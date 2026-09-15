import { open, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { numberOrNull, validGenerationId, validSessionId, keyView, creditView, safeError, readOpenRouter, requestFromEvent, summarizeSession } from './core.js';
import { PROVIDER as DEEPSEEK_PROVIDER, KEY_REF as DEEPSEEK_KEY_REF, BASE_URL as DEEPSEEK_BASE_URL, readDeepSeek, usageEntry, summarizeUsage, balanceView, periodStart } from './deepseek.js';

export const name = 'usage-dashboard';
export const inject = ['connection', 'credentials', 'sessions'];
export function apply(ctx, config = {}) {
  const provider = config.provider || 'openrouter';
  const keyRef = config.apiKeyRef || 'OPENROUTER_API_KEY';
  const managementRef = config.managementKeyRef || 'OPENROUTER_MANAGEMENT_KEY';
  const deepseekKeyRef = config.deepseekKeyRef || DEEPSEEK_KEY_REF;
  const deepseekBaseUrl = config.deepseekBaseUrl || DEEPSEEK_BASE_URL;
  const cachePath = config.cachePath || fileURLToPath(new URL('./.data/charges.json', import.meta.url));
  const MAX_BYTES = 16 * 1024 * 1024, MAX_COSTS = 10000, MAX_REQUESTS = 20000, MAX_SESSIONS = 1000;
  // DeepSeek spend is reconstructed from recorded token counts, so its ledger needs
  // its own bounds: a Map keyed by `sessionId:seq` makes rescanning idempotent.
  const MAX_USAGE = 20000;
  const costs = new Map(), sessions = new Map(), attempts = new Map(), inFlight = new Map(), work = new Set();
  const deepseek = new Map();
  const controller = new AbortController();
  let credentialController = new AbortController(), epoch = 0, identity = '';
  let stopped = false, writes = null, dirty = false, persistError = false, foreignCache = false;
  let requestCount = 0, activeScans = 0, pricingAfter = 0, cache = null, refresh = null, keyAfter = 0, creditsAfter = 0;
  let deepseekCache = null, deepseekAfter = 0, deepseekRefresh = null, deepseekLimitHit = false;
  const abortError = () => new DOMException('Operation cancelled', 'AbortError');
  const modelName = value => typeof value === 'string' ? value.slice(0, 256) : 'Unknown model';
  function track(promise) {
    work.add(promise);
    promise.then(() => work.delete(promise), () => work.delete(promise));
    return promise;
  }
  function check(signal) { if (stopped || signal?.aborted) throw abortError(); }
  function wait(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
      signal.addEventListener('abort', abort, {once:true});
      promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  function task(run, signal = controller.signal) {
    const local = new AbortController();
    const job = {controller:local, users:0, settled:false, promise:null};
    job.promise = track(Promise.resolve().then(() => run(AbortSignal.any([signal, local.signal]))).finally(() => { job.settled = true; }));
    return job;
  }
  async function join(job, signal) {
    job.users++;
    try { return await wait(job.promise, signal); }
    finally { if (--job.users === 0 && !job.settled) job.controller.abort(); }
  }
  function stateFor(id) {
    if (!sessions.has(id)) {
      if (sessions.size >= MAX_SESSIONS) {
        const oldest = [...sessions].find(([, state]) => !state.scan);
        if (!oldest) throw new Error('History busy');
        requestCount -= oldest[1].requests.size; sessions.delete(oldest[0]); dirty = true;
      }
      sessions.set(id, {requests:new Map(), missing:0, cursor:0, scan:null, limited:false});
    }
    return sessions.get(id);
  }
  function remember(sessionId, id, model) {
    if (!validSessionId(sessionId) || !validGenerationId(id)) return;
    const state = stateFor(sessionId);
    if (!state.requests.has(id)) {
      if (requestCount >= MAX_REQUESTS) { state.limited = true; return; }
      state.requests.set(id, {id, model:modelName(model)}); requestCount++; dirty = true;
    }
  }
  // DeepSeek carries no provider request ids, so its usage rows are keyed by the
  // call instead: `${sessionId}:${seq}` from a session scan, or `live-${millis}`
  // from an observed stream. Both keys describe distinct spend, and a rescan
  // overwrites its own durable key rather than double-counting it. The model is
  // resolved by the caller (stream options or the preceding `request/header`).
  function rememberUsage(sessionId, key, time, model, usage) {
    if (!validSessionId(sessionId) || (typeof key !== 'string' && !Number.isSafeInteger(key))) return;
    const entry = usageEntry(time, model, usage);
    if (!entry) return;
    const id = sessionId + '#' + key;
    if (!deepseek.has(id) && deepseek.size >= MAX_USAGE) { deepseek.delete(deepseek.keys().next().value); deepseekLimitHit = true; }
    deepseek.set(id, entry);
    dirty = true;
  }
  const deepseekRows = () => [...deepseek.values()];
  const ready = (async () => {
    let handle;
    try {
      handle = await open(cachePath, 'r');      if ((await handle.stat()).size > MAX_BYTES) throw new Error('Oversized cache');
      // A bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const {bytesRead} = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error('Oversized cache');
      const data = JSON.parse(buffer.toString('utf8', 0, length));
      if (!data || data.version !== 1 || !Array.isArray(data.costs) || (data.sessions !== undefined && !Array.isArray(data.sessions))) throw new Error('Invalid cache');
      // Legacy v1 files belonged to the default provider. Never overwrite another
      // provider's cache; simultaneous processes must use distinct cachePath values.
      if ((data.provider ?? 'openrouter') !== provider) { foreignCache = true; throw new Error('Cache belongs to another provider'); }
      if (data.costs.length > MAX_COSTS || (data.sessions?.length || 0) > MAX_SESSIONS) throw new Error('Oversized cache index');
      let count = 0;
      for (const row of data.sessions || []) {
        if (row && Array.isArray(row.requests)) count += row.requests.length;
      }
      if (count > MAX_REQUESTS) throw new Error('Oversized request index');
      for (const entry of data.costs) {
        if (entry && validGenerationId(entry.id) && numberOrNull(entry.cost) !== null && typeof entry.model === 'string') costs.set(entry.id, {cost:entry.cost, model:modelName(entry.model)});
      }
      for (const row of data.sessions || []) if (row && validSessionId(row.id) && Array.isArray(row.requests)) {
        for (const entry of row.requests) if (entry && typeof entry.model === 'string') remember(row.id, entry.id, entry.model);
      }
      // DeepSeek token history is optional in the same v1 file: a cache written by
      // an earlier version simply has none, and unknown extra fields stay ignored.
      if (data.deepseek !== undefined && !Array.isArray(data.deepseek)) throw new Error('Invalid DeepSeek ledger');
      if ((data.deepseek?.length || 0) > MAX_USAGE) throw new Error('Oversized DeepSeek ledger');
      for (const row of data.deepseek || []) {
        if (!row || typeof row.id !== 'string' || !validSessionId(row.session)) continue;
        rememberUsage(row.session, row.id, row.time, typeof row.model === 'string' ? row.model : null, row);
      }
      dirty = false;
    } catch (error) {
      if (error.code !== 'ENOENT') { persistError = true; ctx.logger.warn('OpenRouter charge cache could not be read; session history will be used to recover.'); }
    } finally { if (handle) await handle.close(); }
  })();
  function save(final = false) {
    if (writes) return writes;
    if (!dirty || foreignCache || (stopped && !final)) return Promise.resolve();
    writes = (async () => {
      await ready;
      while (dirty) {
        dirty = false;
        let temp;
        try {
          // Only owned leaves are serialized. Unique temporary files prevent
          // rename collisions, but do not implement cross-process cache merging.
          const payload = JSON.stringify({version:1, provider, costs:[...costs].map(([id,value]) => ({id,...value})), sessions:[...sessions].map(([id,value]) => ({id,requests:[...value.requests.values()]})), deepseek:[...deepseek].map(([id,row]) => ({session:id.slice(0, id.lastIndexOf('#')), id:id.slice(id.lastIndexOf('#') + 1), ...row}))});
          if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error('Cache limit');
          await mkdir(dirname(cachePath), {recursive:true});
          temp = cachePath + '.' + randomUUID() + '.tmp';
          await writeFile(temp, payload, {encoding:'utf8',mode:0o600,flag:'wx'});
          await rename(temp, cachePath);
          persistError = false;
        } catch {
          persistError = true; dirty = true;
          ctx.logger.warn('OpenRouter charge cache could not be saved. Live totals still work.');
          if (temp) await unlink(temp).catch(() => {});
          break;
        }
      }
    })().finally(() => { writes = null; });
    return writes;
  }
  async function apiKey() {
    const resolved = await ctx.credentials.resolve(keyRef);
    if (resolved?.value) return resolved.value;
    const stored = await ctx.credentials.readRecord(`llm-pi-ai/${provider}`);
    return stored?.kind === 'api-key' ? stored.key : undefined;
  }
  async function scan(sessionId, signal) {
    const state = stateFor(sessionId);
    if (state.scan?.controller.signal.aborted) return 'Session history refresh was cancelled. Retry to finish recovering charges.';
    if (!state.scan) {
      if (activeScans >= 4) return 'Session history is busy. Retry to finish recovering charges.';
      activeScans++;
      const job = task(async scanSignal => {
        let handle;
        try {
          check(scanSignal);
          const live = ctx.sessions.get(sessionId), persistence = ctx.get('sessionPersistence');
          if (!live && !persistence) throw new Error('No history');
          handle = live ? null : await persistence.open(sessionId, 'read');
          check(scanSignal);
          const inherited = live ? live.inheritedEventCount : handle.inheritedEventCount;
          let from = Math.max(state.cursor, Number.isSafeInteger(inherited) && inherited >= 0 ? inherited : 0);
          // A DeepSeek usage sample carries no model, so the scan resolves it from the
          // preceding `request/header` while walking forward. A sample encountered
          // before any header (or after a series boundary) stays unattributed rather
          // than borrowing a model, and its tokens are still counted exactly once.
          let currentModel = null;
          for (let page = 0; page < 16; page++) {
            check(scanSignal);
            const events = live ? live.snapshotEvents(from, from + 256).slice(0, 256) : (await handle.read(from, 256, {signal:scanSignal})).events;
            check(scanSignal);
            if (!Array.isArray(events)) throw new Error('Invalid history');
            let next = from;
            for (const event of events) {
              if (!Number.isSafeInteger(event?.seq) || event.seq < from) continue;
              // A `request/header` states the route for the step that follows it, so it
              // applies to later samples. A series boundary only marks where an earlier
              // series ended; clearing the model there would misattribute the samples
              // that come after it, so the last known route carries forward instead.
              if (event.type === 'request/header') {
                const config = event.data?.header?.config;
                currentModel = config?.provider === DEEPSEEK_PROVIDER ? (typeof config.model === 'string' ? config.model : null) : null;
              } else if (event.type === 'assistant/message' && event.data?.usage) {
                // `source.provider` is authoritative only when present, so a sample
                // whose source omits it is still recorded: the preceding DeepSeek
                // header is what makes it DeepSeek usage, and a sample with no header
                // stays unattributed rather than being silently dropped.
                const source = event.data.message?.source;
                if (source?.provider === undefined || source.provider === DEEPSEEK_PROVIDER) {
                  rememberUsage(sessionId, event.seq, event.time, currentModel ?? (typeof source?.model === 'string' ? source.model : null), event.data.usage);
                }
              }
              const request = requestFromEvent(event, provider);
              if (request) {
                if (request.id) remember(sessionId, request.id, request.model);
                else state.missing++;
              }
              next = Math.max(next, event.seq + 1);
            }
            state.cursor = next;
            if (events.length < 256) return null;
            if (next <= from) throw new Error('Invalid history cursor');
            from = next;
          }
          return 'Session history is still being recovered. Refresh again for remaining charges.';
        } catch { return 'Session history is unavailable. Only already recorded charges are shown.'; }
        finally { if (handle) await handle.close(); }
      });
      state.scan = job;
      job.promise.then(() => { activeScans--; if (state.scan === job) state.scan = null; }, () => { activeScans--; if (state.scan === job) state.scan = null; });
    }
    return join(state.scan, signal);
  }
  // One `llm/stream` tap serves both providers. OpenRouter identifies a request
  // through `replayState.response.responseId`, which only the pi-ai adapter emits;
  // DeepSeek reports no request id and instead supplies normalized token usage on a
  // trailing `usage` chunk, so its spend is recorded from resolved token counts.
  ctx.on('llm/stream', (options, next) => {
    const stream = next();
    const isOpenRouter = options.provider === provider, isDeepSeek = options.provider === DEEPSEEK_PROVIDER;
    if ((!isOpenRouter && !isDeepSeek) || !validSessionId(options.sessionId)) return stream;
    const sessionId = options.sessionId, model = modelName(options.model);
    // A stream chunk carries no sequence number or timestamp, so a live DeepSeek
    // capture is keyed by the observed call instead. The subsequent session scan
    // records the same call under its durable `session:seq` key; the two keys
    // simply describe the same spend, which keeps every figure a sum of distinct rows.
    const record = (id, time, usage) => {
      if (isDeepSeek) { void track(ready.then(() => { rememberUsage(sessionId, id, time, model, usage); return save(); })).catch(() => {}); return; }
      if (!validGenerationId(id)) return;
      // A finish already observed before disposal must survive cache init.
      void track(ready.then(() => { remember(sessionId, id, model); return save(); })).catch(() => {});
    };
    return (async function* () {
      const captured = Date.now();
      let usage = null, finished = null;
      for await (const chunk of stream) {
        if (!stopped) {
          if (isDeepSeek) {
            // usage precedes finish, but commit only once the stream ends so an
            // interrupted stream never records tokens the provider never resolved.
            if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage;
          } else if (chunk.type === 'finish') finished = chunk;
        }
        yield chunk;
      }
      if (isDeepSeek) { if (usage) record('live-' + captured, captured, usage); }
      else if (finished) record(finished.replayState?.response?.responseId);
    })();
  }, {global:true});
  function clearCache() {
    epoch++; credentialController.abort(); credentialController = new AbortController();
    cache = null; identity = ''; keyAfter = creditsAfter = pricingAfter = 0; attempts.clear(); refresh = null;
    deepseekCache = null; deepseekAfter = 0; deepseekRefresh = null;
  }
  ctx.on('credentials/reference-updated', clearCache);
  ctx.on('credentials/record-updated', clearCache);
  async function credentials(signal) {
    check(signal);
    const before = epoch;
    const [key, managementResult, deepseekResult] = await wait(Promise.all([apiKey(), ctx.credentials.resolve(managementRef), ctx.credentials.resolve(deepseekKeyRef)]), signal);
    check(signal);
    if (epoch !== before) throw abortError();
    const management = managementResult?.value, deepseekKey = deepseekResult?.value;
    const nextIdentity = createHash('sha256').update((key || '') + '\0' + (management || '') + '\0' + (deepseekKey || '')).digest('hex');
    if (identity && identity !== nextIdentity) clearCache();
    identity = nextIdentity;
    return {key, management, deepseekKey, epoch, signal:AbortSignal.any([signal, credentialController.signal])};
  }
  function current(snapshot) { check(snapshot.signal); if (snapshot.epoch !== epoch) throw abortError(); }
  const retryDelay = (error, fallback) => Math.max(fallback, Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0);
  async function account(snapshot) {
    current(snapshot);
    if (refresh?.controller.signal.aborted) throw abortError();
    if (!cache || Date.now() >= keyAfter || Date.now() >= creditsAfter) {
      if (!refresh) {
        const previous = cache, attemptEpoch = epoch;
        const job = task(async signal => {
          check(signal);
          const now = new Date().toISOString();
          const data = {updatedAt:now,refreshSeconds:30,key:previous?.key || {...keyView(null),error:null,updatedAt:null},credits:previous?.credits || {...creditView(null),error:null,updatedAt:null},managementConfigured:Boolean(snapshot.management)};
          async function update(field, path, key, view, missing) {
            try {
              const value = await readOpenRouter(path, key, {signal});
              check(signal);
              data[field] = {...view(value),error:null,updatedAt:now};
              return Date.now() + 25000;
            } catch (error) {
              check(signal);
              data[field] = {...data[field],error:key ? safeError(error) : missing};
              return Date.now() + retryDelay(error, 25000);
            }
          }
          const [nextKey, nextCredits] = await Promise.all([
            Date.now() >= keyAfter ? update('key','/key',snapshot.key,keyView,'No OpenRouter API key configured. Add it in Settings → Models.') : keyAfter,
            Date.now() >= creditsAfter ? update('credits','/credits',snapshot.management || snapshot.key,creditView,'Configure an OpenRouter key, then set up account balance.') : creditsAfter
          ]);
          check(signal);
          if (attemptEpoch !== epoch) throw abortError();
          cache = data; keyAfter = nextKey; creditsAfter = nextCredits;
        }, AbortSignal.any([controller.signal, credentialController.signal]));
        refresh = job;
        job.promise.then(() => { if (refresh === job) refresh = null; }, () => { if (refresh === job) refresh = null; });
      }
      await join(refresh, snapshot.signal);
    }
    current(snapshot);
    return cache;
  }
  // DeepSeek exposes a single balance endpoint, so this mirrors the OpenRouter
  // refresh contract (stale-value retention, Retry-After, epoch fencing) with one field.
  async function deepseekAccount(snapshot) {
    current(snapshot);
    if (deepseekRefresh?.controller.signal.aborted) throw abortError();
    if (!deepseekCache || Date.now() >= deepseekAfter) {
      if (!deepseekRefresh) {
        const previous = deepseekCache, attemptEpoch = epoch;
        const job = task(async signal => {
          check(signal);
          const now = new Date().toISOString();
          const data = {updatedAt:now, keyConfigured:Boolean(snapshot.deepseekKey), balance:previous?.balance || {...balanceView(null),error:null,updatedAt:null}};
          async function update() {
            try {
              const view = await readDeepSeek(deepseekBaseUrl, snapshot.deepseekKey, {signal});
              check(signal);
              data.balance = {...view,error:null,updatedAt:now};
              return Date.now() + 25000;
            } catch (error) {
              check(signal);
              data.balance = {...data.balance,error:snapshot.deepseekKey ? safeError(error,'DeepSeek') : 'No DeepSeek API key configured. Add it in Settings, or set one up below.'};
              return Date.now() + retryDelay(error, 25000);
            }
          }
          const next = await update();
          check(signal);
          if (attemptEpoch !== epoch) throw abortError();
          deepseekCache = data; deepseekAfter = next;
        }, AbortSignal.any([controller.signal, credentialController.signal]));
        deepseekRefresh = job;
        job.promise.then(() => { if (deepseekRefresh === job) deepseekRefresh = null; }, () => { if (deepseekRefresh === job) deepseekRefresh = null; });
      }
      await join(deepseekRefresh, snapshot.signal);
    }
    current(snapshot);
    return deepseekCache;
  }
  // DeepSeek publishes no usage history, so every spend figure below is a local
  // estimate over recorded token counts, scoped by the same period names the
  // OpenRouter card uses. Day and Week are bounded by the caller's clock.
  function deepseekScope(period, now) {
    const start = period === 'Day' || period === 'Week' ? periodStart(period, now) : null;
    if (start === null) return deepseekRows();
    return deepseekRows().filter(row => Number.isFinite(row.time) && row.time >= start);
  }
  // The account-level view has no session to scope to, so it always reports the
  // whole recorded ledger; `period` still narrows an explicitly requested scope.
  function deepseekSummary(id, period, error) {
    const rows = deepseekRows();
    const unattributedTokens = row => row.model ? 0 : row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
    const unattributedCalls = rows.reduce((sum, row) => sum + (row.model ? 0 : 1), 0);
    if (!id) {
      const totals = summarizeUsage(period ? deepseekScope(period, Date.now()) : rows);
      return {
        id: null, period: period || null, scope: 'All recorded sessions',
        cost: totals.cost, calls: totals.calls, pricedCalls: totals.priced,
        unattributedCalls, tokens: totals.tokens, unattributedTokens: rows.reduce((sum, row) => sum + unattributedTokens(row), 0),
        truncated: deepseekLimitHit, models: totals.models, error
      };
    }
    const scoped = summarizeUsage(deepseekScope(period, Date.now()));
    return {
      id, period,
      // Account scope is reported alongside the session scope because the balance
      // it is compared against is account-wide, not per-session.
      scope: 'Session + other sessions in this ledger',
      cost: scoped.cost, calls: scoped.calls, pricedCalls: scoped.priced,
      unattributedCalls, tokens: scoped.tokens,
      accountTokens: summarizeUsage(rows).tokens,
      unattributedTokens: rows.reduce((sum, row) => sum + unattributedTokens(row), 0),
      truncated: deepseekLimitHit, models: scoped.models, error
    };
  }
  async function priceSession(state, snapshot) {
    if (!snapshot.key) return;
    // No promise queue: at most two network calls exist globally. Another tab or
    // session gets an immediate partial snapshot while those slots are occupied.
    let launched = 0;
    for (;;) {
      current(snapshot);
      if (launched >= 8 || inFlight.size >= 2 || Date.now() < pricingAfter) return;
      const due = [];
      for (const row of state.requests.values()) {
        if (!costs.has(row.id) && !inFlight.has(row.id) && (attempts.get(row.id)?.after || 0) <= Date.now()) due.push(row);
        if (due.length >= Math.min(2 - inFlight.size, 8 - launched)) break;
      }
      if (!due.length) return;
      const operations = due.map(row => {
        launched++;
        const operation = track((async () => {
          try {
            current(snapshot);
            const value = await readOpenRouter('/generation?id=' + row.id, snapshot.key, {signal:snapshot.signal});
            current(snapshot);
            if (value.id !== row.id || numberOrNull(value.total_cost) === null || (value.model !== undefined && typeof value.model !== 'string')) throw new Error('Invalid cost');
            if (!costs.has(row.id) && costs.size >= MAX_COSTS) costs.delete(costs.keys().next().value);
            costs.set(row.id, {cost:value.total_cost,model:modelName(value.model ?? row.model)});
            dirty = true; attempts.delete(row.id);
          } catch (error) {
            current(snapshot); // Cancellation/rotation must not poison the new key's retry state.
            const count = (attempts.get(row.id)?.count || 0) + 1;
            if (attempts.size >= MAX_COSTS) attempts.delete(attempts.keys().next().value);
            const delay = retryDelay(error, Math.min(300000, 15000 * 2 ** Math.min(count,5)));
            attempts.set(row.id, {count,after:Date.now() + delay});
            if (error?.status === 429 || error?.retryAfterMs) pricingAfter = Math.max(pricingAfter, Date.now() + delay);
          } finally { inFlight.delete(row.id); }
        })());
        inFlight.set(row.id, operation);
        return operation;
      });
      await wait(Promise.all(operations), snapshot.signal);
    }
  }
  const json = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/openrouter-usage',methods:['GET'],requestBody:'buffered',
    fetch: async request => {
      const signal = AbortSignal.any([request.signal, controller.signal]);
      try {
        check(signal);
        const params = new URL(request.url).searchParams;
        const id = params.get('sessionId'), wantsDeepSeek = params.get('deepseek') === '1';
        if (id !== null && !validSessionId(id)) return json({error:'Invalid session ID'},400);
        await wait(ready, signal);
        const snapshot = await credentials(signal);
        if (wantsDeepSeek) {
          const data = await deepseekAccount(snapshot);
          // Deliberately not named `deepseek`: that identifier is the ledger Map in
          // this closure, and shadowing it would report an empty ledger.
          let tokens = deepseekSummary(null, null, null);
          if (id) {
            const error = await scan(id, snapshot.signal);
            tokens = deepseekSummary(id, params.get('period'), error);
          }
          current(snapshot);
          return json({...data, session:summarizeSession(null,[],costs), deepseek:tokens});
        }
        const data = await account(snapshot);
        let session = summarizeSession(null,[],costs);
        if (id) {
          const error = await scan(id, snapshot.signal), state = stateFor(id);
          await priceSession(state,snapshot);
          session = summarizeSession(id,[...state.requests.values()],costs,state.missing,error || (state.limited ? 'Local request index limit reached. These totals are incomplete.' : persistError ? 'Local cost cache is unavailable; these figures may need to be recovered after restart.' : null));
        }
        current(snapshot);
        return json({...data, session});
      } catch { return json({error:'Usage could not be refreshed. Check the server connection and retry.'},503); }
      finally { void save(); }
    }
  }), 'openrouter: authenticated usage endpoint');
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/openrouter-usage/management-key',methods:['POST'],requestBody:'buffered',
    fetch: request => track((async () => {
      const signal = AbortSignal.any([request.signal, controller.signal, credentialController.signal]);
      try {
        check(signal);
        const body = await wait(request.text(), signal);
        if (body.length > 1024) return json({error:'Key is too long.'},400);
        const key = JSON.parse(body)?.key;
        if (typeof key !== 'string' || !/^sk-or-[A-Za-z0-9_-]{16,240}$/.test(key)) return json({error:'Enter a valid OpenRouter management key.'},400);
        // readOpenRouter validates both finite nonnegative credit fields. Merely
        // receiving a 2xx response is not proof that this is a management key.
        await readOpenRouter('/credits',key,{signal});
        check(signal);
        await ctx.credentials.set(managementRef,key);
        clearCache();
        return json({ok:true});
      } catch (error) { return json({error:error?.status ? safeError(error) : 'Could not validate or securely store the management key.'},400); }
    })())
  }), 'openrouter: management credential setup');
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/openrouter-usage/deepseek-key',methods:['POST'],requestBody:'buffered',
    fetch: request => track((async () => {
      const signal = AbortSignal.any([request.signal, controller.signal, credentialController.signal]);
      try {
        check(signal);
        const body = await wait(request.text(), signal);
        if (body.length > 1024) return json({error:'Key is too long.'},400);
        const key = JSON.parse(body)?.key;
        // DSH accepts any non-blank key whose characters an HTTP header can carry
        // and lets the provider judge it, so this matches that rule rather than
        // assuming a prefix shape and refusing a key DSH itself would accept.
        if (typeof key !== 'string' || key.length < 8 || key.length > 400 || !/^[\x21-\x7e]+$/.test(key)) return json({error:'Enter a valid DeepSeek API key.'},400);
        // A 2xx alone proves nothing: readDeepSeek validates a real balance payload,
        // so a rejected or non-balance response never replaces a stored key.
        await readDeepSeek(deepseekBaseUrl, key, {signal});
        check(signal);
        await ctx.credentials.set(deepseekKeyRef, key);
        clearCache();
        return json({ok:true});
      } catch (error) { return json({error:error?.status ? safeError(error,'DeepSeek') : 'Could not validate or securely store the DeepSeek key.'},400); }
    })())
  }), 'openrouter: deepseek credential setup');
  ctx.effect(() => async () => {
    stopped = true; controller.abort(); credentialController.abort();
    await Promise.allSettled([ready, ...work]);
    if (writes) await writes;
    await save(true);
  }, 'openrouter: cancel pending work and flush charges');
}
