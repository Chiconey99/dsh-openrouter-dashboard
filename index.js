import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { numberOrNull, validGenerationId, validSessionId, keyView, creditView, safeError, readOpenRouter, requestFromEvent, summarizeSession } from './core.js';

export const name = 'openrouter-dashboard';
export const inject = ['connection', 'credentials', 'sessions'];
export function apply(ctx, config = {}) {
  const provider = config.provider || 'openrouter';
  const keyRef = config.apiKeyRef || 'OPENROUTER_API_KEY';
  const managementRef = config.managementKeyRef || 'OPENROUTER_MANAGEMENT_KEY';
  const cachePath = config.cachePath || fileURLToPath(new URL('./.data/charges.json', import.meta.url));
  const costs = new Map(), sessions = new Map(), attempts = new Map();
  const controller = new AbortController();
  let stopped = false, writes = Promise.resolve(), dirty = false, persistError = false, cacheIdentity = '', cache = null, cacheAt = 0, refresh = null;
  const ready = readFile(cachePath, 'utf8').then(text => {
    const data = JSON.parse(text);
    if (data.version !== 1 || !Array.isArray(data.costs)) throw new Error('Invalid cache');
    for (const entry of data.costs) if (validGenerationId(entry.id) && numberOrNull(entry.cost) !== null && typeof entry.model === 'string') costs.set(entry.id, { cost: entry.cost, model: entry.model });
    for (const row of data.sessions || []) if (validSessionId(row.id) && Array.isArray(row.requests)) {
      const requests = new Map();
      for (const entry of row.requests) if (validGenerationId(entry.id) && typeof entry.model === 'string') requests.set(entry.id, {id: entry.id, model: entry.model});
      sessions.set(row.id, {requests, missing: 0, cursor: 0});
    }
  }).catch(error => {
    if (error.code !== 'ENOENT') { persistError = true; ctx.logger.warn('OpenRouter charge cache could not be read; session history will be used to recover.'); }
  });
  function stateFor(id) {
    if (!sessions.has(id)) sessions.set(id, {requests: new Map(), missing: 0, cursor: 0});
    return sessions.get(id);
  }
  function remember(sessionId, id, model) {
    if (!validSessionId(sessionId) || !validGenerationId(id)) return;
    const state = stateFor(sessionId);
    if (!state.requests.has(id)) { state.requests.set(id, {id, model}); dirty = true; }
  }
  function save() {
    if (!dirty || stopped) return writes;
    dirty = false;
    writes = writes.then(async () => {
      await ready;
      // All objects here are this plugin's owned leaves, not live DSH objects.
      const payload = JSON.stringify({version: 1, costs: [...costs].map(([id,value]) => ({id,...value})), sessions: [...sessions].map(([id,value]) => ({id,requests:[...value.requests.values()]}))});
      await mkdir(dirname(cachePath), {recursive:true});
      await writeFile(cachePath + '.tmp', payload, {encoding:'utf8',mode:0o600});
      await rename(cachePath + '.tmp', cachePath);
      persistError = false;
    }).catch(() => { persistError = true; dirty = true; ctx.logger.warn('OpenRouter charge cache could not be saved. Live totals still work.'); });
    return writes;
  }
  async function apiKey() {
    const resolved = await ctx.credentials.resolve(keyRef);
    if (resolved?.value) return resolved.value;
    const stored = await ctx.credentials.readRecord(`llm-pi-ai/${provider}`);
    return stored?.kind === 'api-key' ? stored.key : undefined;
  }
  async function scan(sessionId) {
    const state = stateFor(sessionId);
    const live = ctx.sessions.get(sessionId);
    let handle;
    try {
      if (!live && !ctx.get('sessionPersistence')) throw new Error('No history');
      handle = live ? null : await ctx.get('sessionPersistence').open(sessionId, 'read');
      const from = Math.max(state.cursor, live ? live.inheritedEventCount : handle.inheritedEventCount);
      const events = live ? live.snapshotEvents(from) : (await handle.read(from)).events;
      for (const event of events) {
        const request = requestFromEvent(event, provider);
        if (request) {
          if (request.id) remember(sessionId, request.id, request.model);
          else state.missing++;
        }
        state.cursor = Math.max(state.cursor, event.seq + 1);
      }
      return null;
    } catch { return 'Session history is unavailable. Only already recorded charges are shown.'; }
    finally { if (handle) await handle.close(); }
  }
  // Observe request IDs without changing or delaying the model stream. Handles
  // auxiliary session-attributed requests as well as ordinary chat requests.
  ctx.on('llm/stream', (options, next) => {
    const stream = next();
    if (options.provider !== provider || !validSessionId(options.sessionId)) return stream;
    const sessionId = options.sessionId, model = options.model;
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish' && !stopped) {
          const id = chunk.replayState?.response?.responseId;
          if (validGenerationId(id)) {
            void ready.then(() => { if (!stopped) { remember(sessionId, id, model); void save(); } });
          }
        }
        yield chunk;
      }
    })();
  }, {global:true});
  const clearCache = () => { cacheAt = 0; cache = null; cacheIdentity = ''; attempts.clear(); };
  ctx.on('credentials/reference-updated', clearCache);
  ctx.on('credentials/record-updated', clearCache);
  async function account() {
    if (stopped) throw new Error('Plugin stopped');
    const key = await apiKey();
    const management = (await ctx.credentials.resolve(managementRef))?.value;
    const identity = createHash('sha256').update((key || '') + '\0' + (management || '')).digest('hex');
    if (identity !== cacheIdentity) { cache = null; cacheAt = 0; cacheIdentity = identity; }
    if (cache && Date.now() - cacheAt < 25000) return {data:cache, key};
    if (refresh) { await refresh; return account(); }
    refresh = (async () => {
      const now = new Date().toISOString();
      const previous = cache;
      const [keyResult, creditResult] = await Promise.allSettled([
        key ? readOpenRouter('/key',key,{signal:controller.signal}) : Promise.reject(new Error('no-key')),
        management || key ? readOpenRouter('/credits',management || key,{signal:controller.signal}) : Promise.reject(new Error('no-key'))
      ]);
      const keyData = keyResult.status === 'fulfilled'
        ? {...keyView(keyResult.value),error:null,updatedAt:now}
        : {...(previous?.key || keyView(null)),error:key ? safeError(keyResult.reason) : 'No OpenRouter API key configured. Add it in Settings → Models.',updatedAt:previous?.key.updatedAt || null};
      const credits = creditResult.status === 'fulfilled'
        ? {...creditView(creditResult.value),error:null,updatedAt:now}
        : {...(previous?.credits || creditView(null)),error:management || key ? safeError(creditResult.reason) : 'Configure an OpenRouter key, then set up account balance.',updatedAt:previous?.credits.updatedAt || null};
      if (cacheIdentity === identity && !stopped) {
        cache = {updatedAt:now,refreshSeconds:30,key:keyData,credits,managementConfigured:Boolean(management)};
        cacheAt = Date.now();
      }
    })().finally(() => { refresh = null; });
    await refresh;
    if (!cache) return account();
    return {data:cache,key};
  }
  let pricing = Promise.resolve();
  async function priceSession(state, key) {
    if (!key) return;
    // Serialize pricing across browser tabs; at most eight metadata lookups per
    // refresh. Recent/unavailable requests are retried with capped backoff.
    const operation = pricing.then(async () => {
      const due = [...state.requests.values()].filter(row => !costs.has(row.id) && (attempts.get(row.id)?.after || 0) <= Date.now()).slice(0,8);
      for (let i=0;i<due.length;i+=2) {
        if (stopped) return;
        await Promise.all(due.slice(i,i+2).map(async row => {
          try {
            const value = await readOpenRouter('/generation?id=' + encodeURIComponent(row.id),key,{signal:controller.signal});
            if (value.id !== row.id || numberOrNull(value.total_cost) === null) throw new Error('Invalid cost');
            costs.set(row.id,{cost:value.total_cost,model:typeof value.model === 'string' ? value.model : row.model});
            dirty = true; attempts.delete(row.id);
          } catch {
            const count = (attempts.get(row.id)?.count || 0) + 1;
            attempts.set(row.id,{count,after:Date.now() + Math.min(300000,15000 * 2 ** Math.min(count,5))});
          }
        }));
      }
    });
    pricing = operation.catch(() => {});
    await operation;
  }
  const json = (value,status=200) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/openrouter-usage',methods:['GET'],requestBody:'buffered',
    fetch: async request => {
      try {
        const id = new URL(request.url).searchParams.get('sessionId');
        if (id !== null && !validSessionId(id)) return json({error:'Invalid session ID'},400);
        await ready;
        const {data,key} = await account();
        let session = summarizeSession(null,[],costs);
        if (id) {
          const error = await scan(id), state = stateFor(id);
          await priceSession(state,key);
          session = summarizeSession(id,[...state.requests.values()],costs,state.missing,error || (persistError ? 'Local cost cache could not be saved; these figures may need to be recovered after restart.' : null));
          void save();
        }
        return json({...data,session});
      } catch { return json({error:'Usage could not be refreshed. Check the server connection and retry.'},503); }
    }
  }), 'openrouter: authenticated usage endpoint');
  ctx.effect(() => ctx.connection.fetch.register({
    path:'/api/openrouter-usage/management-key',methods:['POST'],requestBody:'buffered',
    fetch: async request => {
      try {
        const body = await request.text();
        if (body.length > 1024) return json({error:'Key is too long.'},400);
        const key = JSON.parse(body).key;
        if (typeof key !== 'string' || !/^sk-or-[A-Za-z0-9_-]{16,240}$/.test(key)) return json({error:'Enter a valid OpenRouter management key.'},400);
        // Validate read-only balance access before storing; never use this key for models.
        await readOpenRouter('/credits',key,{signal:controller.signal});
        await ctx.credentials.set(managementRef,key);
        clearCache();
        return json({ok:true});
      } catch (error) { return json({error:error?.status ? safeError(error) : 'Could not validate or securely store the management key.'},400); }
    }
  }), 'openrouter: management credential setup');
  ctx.effect(() => () => { stopped = true; controller.abort(); return Promise.allSettled([writes,pricing,refresh].filter(Boolean)); }, 'openrouter: cancel pending work');
}
