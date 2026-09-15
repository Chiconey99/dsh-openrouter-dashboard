// DeepSeek's official API, kept separate from the OpenRouter reader because the
// two providers expose different things. DeepSeek publishes ONE account endpoint
// (`/user/balance`) and no usage history at all, so every spend figure here is a
// LOCAL ESTIMATE derived from token counts DSH already recorded, priced with the
// published table below. Balance is provider-reported and exact; spend is not.
import { readMetadataData, numberOrNull } from './core.js';

export const PROVIDER = 'deepseek-official';
export const BASE_URL = 'https://api.deepseek.com';
export const KEY_REF = 'DEEPSEEK_API_KEY';

// Published per-1M-token prices in USD. Peak hours are 01:00-04:00 and
// 06:00-10:00 UTC Monday-Friday; off-peak is exactly half. Cache-miss rates
// apply to uncached input. Update this table when DeepSeek changes its prices.
export const PRICES = {
  'deepseek-flash': { hit: [0.003, 0.006], miss: [0.15, 0.3], out: [0.6, 1.2] },
  'deepseek-v4-pro': { hit: [0.022, 0.044], miss: [0.66, 1.32], out: [1.98, 3.96] }
};
export const DEFAULT_MODEL = 'deepseek-flash';
// Legacy ids DeepSeek still accepts and bills at the Flash price.
const FLASH_ALIASES = ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner'];

export function priceFor(model) {
  if (typeof model !== 'string') return null;
  const name = model.trim().toLowerCase();
  for (const alias of FLASH_ALIASES) if (name === alias || name.startsWith(alias + '-') || name.startsWith(alias + ':')) return PRICES[DEFAULT_MODEL];
  if (PRICES[name]) return PRICES[name];
  for (const key of Object.keys(PRICES)) if (name.startsWith(key + '-') || name.startsWith(key + ':')) return PRICES[key];
  return null;
}

// Peak = 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday.
export function isPeak(time) {
  if (!Number.isFinite(time)) return false;
  const at = new Date(time);
  const day = at.getUTCDay(), hour = at.getUTCHours();
  if (day === 0 || day === 6) return false;
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

const tokenCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
// `inputTokens` excludes cache reads and writes (DSH reports disjoint counts),
// so billed input is the sum of all three. An unknown model returns null rather
// than a confident zero.
export function estimateCost(model, usage, time) {
  const price = priceFor(model);
  if (!price || !usage) return null;
  const peak = isPeak(time) ? 1 : 0;
  const tokens = tokenCount(usage.inputTokens) + tokenCount(usage.cacheReadTokens) + tokenCount(usage.cacheWriteTokens) + tokenCount(usage.outputTokens);
  if (!tokens) return null;
  return (tokenCount(usage.cacheReadTokens) * price.hit[peak]
    + (tokenCount(usage.inputTokens) + tokenCount(usage.cacheWriteTokens)) * price.miss[peak]
    + tokenCount(usage.outputTokens) * price.out[peak]) / 1e6;
}

// DSH normalizes DeepSeek usage into disjoint counts. Anything unusable is
// treated as absent rather than zero so one malformed call cannot add a phantom row.
// A row whose owning `request/header` is missing keeps a null model: its tokens are
// still real and counted, they simply cannot be priced or broken down by model.
export function usageEntry(time, model, usage) {
  if (!Number.isFinite(time) || time <= 0 || !usage) return null;
  const entry = {
    time: Math.floor(time), model: typeof model === 'string' && model ? model.slice(0, 256) : null,
    inputTokens: tokenCount(usage.inputTokens), outputTokens: tokenCount(usage.outputTokens),
    cacheReadTokens: tokenCount(usage.cacheReadTokens), cacheWriteTokens: tokenCount(usage.cacheWriteTokens)
  };
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens > 0 ? entry : null;
}

// DeepSeek reports balances as decimal STRINGS and may return several currencies
// at once, so the preferred currency is selected explicitly instead of by position.
export function balanceView(data, preferred = 'USD') {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  let info = infos.find(row => row?.currency === preferred) || infos.find(row => row?.currency === 'USD') || infos.find(row => row?.currency === 'CNY') || infos[0];
  if (!info || typeof info.currency !== 'string') info = null;
  const amount = value => {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  return {
    isAvailable: data?.is_available === true, currency: info?.currency || null,
    balance: info ? amount(info.total_balance) : null,
    granted: info ? amount(info.granted_balance) : null,
    toppedUp: info ? amount(info.topped_up_balance) : null,
    infos: infos.filter(row => row && typeof row.currency === 'string')
      .map(row => ({ currency: row.currency, balance: amount(row.total_balance) }))
  };
}

export async function readDeepSeek(baseUrl, key, options = {}) {
  let url;
  try { url = new URL('/user/balance', typeof baseUrl === 'string' && baseUrl ? baseUrl : BASE_URL); }
  catch { throw new Error('Invalid DeepSeek base URL'); }
  if (url.protocol !== 'https:') throw new Error('Unsupported metadata endpoint');
  const data = await readMetadataData(url.href, key, options);
  // A 2xx response is not proof of a balance payload: validate before trusting it.
  const view = balanceView(data, 'USD');
  if (view.balance === null && view.granted === null && view.toppedUp === null) throw new Error('Invalid balance metadata');
  return view;
}

// Roll a set of recorded usage rows into one scope. `models` is always the full
// breakdown, so a caller can show per-model bars for any period.
export function summarizeUsage(rows) {
  const models = new Map();
  let cost = 0, priced = 0, unpriced = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const row of rows) {
    if (!row) continue;
    tokens.input += tokenCount(row.inputTokens); tokens.output += tokenCount(row.outputTokens);
    tokens.cacheRead += tokenCount(row.cacheReadTokens); tokens.cacheWrite += tokenCount(row.cacheWriteTokens);
    const estimated = estimateCost(row.model, row, row.time);
    const label = row.model || 'Unattributed';
    const entry = models.get(label) || { model: label, cost: 0, calls: 0, tokens: 0, priced: false };
    entry.calls++; entry.tokens += tokenCount(row.inputTokens) + tokenCount(row.outputTokens) + tokenCount(row.cacheReadTokens) + tokenCount(row.cacheWriteTokens);
    if (estimated === null) unpriced++; else { cost += estimated; priced++; entry.cost += estimated; entry.priced = true; }
    models.set(row.model, entry);
  }
  return {
    cost: priced ? cost : null, priced, unpriced, calls: rows.length, tokens,
    models: [...models.values()].sort((a, b) => b.cost - a.cost)
  };
}

// Bounds are computed from the caller's clock so the period filters stay pure and testable.
export function periodStart(period, now = Date.now()) {
  const at = new Date(now);
  if (period === 'Day') return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  if (period === 'Week') {
    const day = at.getUTCDay(), back = (day + 6) % 7; // Monday-first week
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - back);
  }
  return null;
}
