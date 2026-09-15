// Pure data helpers and a bounded, credential-safe provider reader.
export const API = 'https://openrouter.ai/api/v1';
export const MAX_METADATA_BYTES = 256000;
export const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const validGenerationId = value => typeof value === 'string' && /^gen-[A-Za-z0-9_-]{1,200}$/.test(value);
export const validSessionId = value => typeof value === 'string' && /^session-[A-Za-z0-9_-]{1,160}$/.test(value);
export function keyView(data) {
  return { usageDaily: numberOrNull(data?.usage_daily), usageWeekly: numberOrNull(data?.usage_weekly), usageTotal: numberOrNull(data?.usage), limit: numberOrNull(data?.limit), limitRemaining: numberOrNull(data?.limit_remaining) };
}
export function creditView(data) {
  const totalCredits = numberOrNull(data?.total_credits), totalUsage = numberOrNull(data?.total_usage);
  return { totalCredits, totalUsage, balance: totalCredits !== null && totalUsage !== null ? totalCredits - totalUsage : null };
}
export function safeError(error, provider = 'OpenRouter') {
  if (error?.status === 401) return `${provider} rejected this key (401). Check the credential in Settings.`;
  if (error?.status === 403) return provider === 'DeepSeek' ? 'DeepSeek refused this key (403). Check the credential in Settings.' : `${provider} requires a management key for account balance. Use Balance setup below.`;
  if (error?.status === 429) return `${provider} rate limit reached. Retrying automatically.`;
  if (error?.status === 404) return provider === 'DeepSeek' ? 'DeepSeek does not expose this endpoint on the configured base URL.' : `This request is not yet available, or is outside ${provider} retention.`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `${provider} request timed out. Retrying automatically.`;
  return `${provider} is unavailable or returned an invalid response. Retrying automatically.`;
}
// One hardened metadata transfer shared by every provider reader: HTTPS only,
// redirects rejected, a hard byte cap enforced while streaming, and Retry-After
// surfaced as a delay. Callers own endpoint allowlisting and shape validation.
export async function readMetadataData(url, key, { fetchImpl = fetch, signal } = {}) {
  if (!key) throw new Error('Missing credential');
  if (new URL(url).protocol !== 'https:') throw new Error('Unsupported metadata endpoint');
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
  });
  if (!response.ok) {
    const error = new Error('Provider HTTP error');
    error.status = response.status;
    const retry = response.headers.get('retry-after');
    if (retry) {
      const milliseconds = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      if (Number.isFinite(milliseconds) && milliseconds > 0) error.retryAfterMs = milliseconds;
    }
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  // Enforce a byte cap while reading, not after an unbounded response.text().
  // This also bounds bodies without Content-Length and decompressed responses.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing metadata body');
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_METADATA_BYTES) {
        await reader.cancel();
        throw new Error('Oversized metadata');
      }
      body += decoder.decode(chunk.value, {stream: true});
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  // Parsing only: providers disagree on their envelope (OpenRouter wraps the
  // payload in `data`, DeepSeek returns a bare object), so each caller unwraps.
  return JSON.parse(body);
}
export async function readOpenRouter(path, key, options = {}) {
  if (path !== '/key' && path !== '/credits' && !/^\/generation\?id=gen-[A-Za-z0-9_-]{1,200}$/.test(path)) {
    throw new Error('Unsupported metadata endpoint');
  }
  const body = await readMetadataData(API + path, key, options);
  const data = body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid metadata');
  if (path === '/key' && ['usage', 'usage_daily', 'usage_weekly'].some(field => numberOrNull(data[field]) === null)) {
    throw new Error('Invalid key usage metadata');
  }
  if (path === '/credits' && ['total_credits', 'total_usage'].some(field => numberOrNull(data[field]) === null)) {
    throw new Error('Invalid account credit metadata');
  }
  return data;
}
export function requestFromEvent(event, provider = 'openrouter') {
  if (event.type !== 'assistant/message') return null;
  const source = event.data?.message?.source;
  if (source?.kind !== 'model' || source.provider !== provider) return null;
  const id = source.replayState?.response?.responseId;
  return { id: validGenerationId(id) ? id : null, model: typeof source.model === 'string' ? source.model : 'Unknown model' };
}
export function summarizeSession(id, requests, costs, missing = 0, error = null) {
  const models = new Map(); let cost = 0, priced = 0;
  for (const request of requests) {
    const entry = costs.get(request.id);
    if (numberOrNull(entry?.cost) === null) continue;
    cost += entry.cost; priced++;
    const model = entry.model || request.model;
    const row = models.get(model) || { model, cost: 0, requests: 0 };
    row.cost += entry.cost; row.requests++; models.set(model, row);
  }
  return { id, cost: id === null || (priced === 0 && (missing > 0 || requests.length > 0 || error)) ? null : cost,
    requests: requests.length + missing, priced, pending: requests.length - priced, missing,
    models: [...models.values()].sort((a,b) => b.cost - a.cost), error };
}
