import { open, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { numberOrNull, validGenerationId, validSessionId, keyView, creditView, safeError, readOpenRouter, requestFromEvent, summarizeSession } from './core.js';

export const name = 'openrouter-dashboard';
export const inject = ['connection', 'credentials', 'sessions'];
export function apply(ctx, config = {}) {
  const provider = config.provider || 'openrouter';
  const keyRef = config.apiKeyRef || 'OPENROUTER_API_KEY';
  const managementRef = config.managementKeyRef || 'OPENROUTER_MANAGEMENT_KEY';
  const cachePath = config.cachePath || fileURLToPath(new URL('./.data/charges.json', import.meta.url));
  const MAX_BYTES = 16 * 1024 * 1024, MAX_COSTS = 10000, MAX_REQUESTS = 20000, MAX_SESSIONS = 1000;
  const costs = new Map(), sessions = new Map(), attempts = new Map(), inFlight = new Map(), work = new Set();
  const controller = new AbortController();
  let credentialController = new AbortController(), epoch = 0, identity = '';
  let stopped = false, writes = null, dirty = false, persistError = false, foreignCache = false;
  let requestCount = 0, activeScans = 0, pricingAfter = 0, cache = null, refresh = null, keyAfter = 0, creditsAfter = 0;
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
  const ready = (async () => {
    let handle;
    try {
      handle = await open(cachePath, 'r');
      if ((await handle.stat()).size > MAX_BYTES) throw new Error('Oversized cache');
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
          const payload = JSON.stringify({version:1, provider, costs:[...costs].map(([id,value]) => ({id,...value})), sessions:[...sessions].map(([id,value]) => ({id,requests:[...value.requests.values()]}))});
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
          for (let page = 0; page < 16; page++) {
            check(scanSignal);
            const events = live ? live.snapshotEvents(from, from + 256).slice(0, 256) : (await handle.read(from, 256, {signal:scanSignal})).events;
            check(scanSignal);
            if (!Array.isArray(events)) throw new Error('Invalid history');
            let next = from;
            for (const event of events) {
              if (!Number.isSafeInteger(event?.seq) || event.seq < from) continue;
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
  ctx.on('llm/stream', (options, next) => {
    const stream = next();
    if (options.provider !== provider || !validSessionId(options.sessionId)) return stream;
    const sessionId = options.sessionId, model = modelName(options.model);
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish' && !stopped) {
          const id = chunk.replayState?.response?.responseId;
          if (validGenerationId(id)) {
            // A finish already observed before disposal must survive cache init.
            void track(ready.then(() => { remember(sessionId, id, model); return save(); })).catch(() => {});
          }
        }
        yield chunk;
      }
    })();
  }, {global:true});
  function clearCache() {
    epoch++; credentialController.abort(); credentialController = new AbortController();
    cache = null; identity = ''; keyAfter = creditsAfter = pricingAfter = 0; attempts.clear(); refresh = null;
  }
  ctx.on('credentials/reference-updated', clearCache);
  ctx.on('credentials/record-updated', clearCache);
  async function credentials(signal) {
    check(signal);
    const before = epoch;
    const [key, managementResult] = await wait(Promise.all([apiKey(), ctx.credentials.resolve(managementRef)]), signal);
    check(signal);
    if (epoch !== before) throw abortError();
    const management = managementResult?.value;
    const nextIdentity = createHash('sha256').update((key || '') + '\0' + (management || '')).digest('hex');
    if (identity && identity !== nextIdentity) clearCache();
    identity = nextIdentity;
    return {key, management, epoch, signal:AbortSignal.any([signal, credentialController.signal])};
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
        const id = new URL(request.url).searchParams.get('sessionId');
        if (id !== null && !validSessionId(id)) return json({error:'Invalid session ID'},400);
        await wait(ready, signal);
        const snapshot = await credentials(signal), data = await account(snapshot);
        let session = summarizeSession(null,[],costs);
        if (id) {
          const error = await scan(id, snapshot.signal), state = stateFor(id);
          await priceSession(state,snapshot);
          session = summarizeSession(id,[...state.requests.values()],costs,state.missing,error || (state.limited ? 'Local request index limit reached. These totals are incomplete.' : persistError ? 'Local cost cache is unavailable; these figures may need to be recovered after restart.' : null));
        }
        current(snapshot);
        return json({...data,session});
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
  ctx.effect(() => async () => {
    stopped = true; controller.abort(); credentialController.abort();
    await Promise.allSettled([ready, ...work]);
    if (writes) await writes;
    await save(true);
  }, 'openrouter: cancel pending work and flush charges');
}
