import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICES, DEFAULT_MODEL, PROVIDER, BASE_URL, priceFor, isPeak, estimateCost,
  usageEntry, balanceView, readDeepSeek, summarizeUsage, periodStart
} from '../deepseek.js';

const response = data => Response.json({data});
const json = payload => Response.json(payload);

test('provider identity matches the route DSH registers for the official API', () => {
  assert.equal(PROVIDER, 'deepseek-official');
  assert.equal(BASE_URL, 'https://api.deepseek.com');
});

test('pricing table keeps off-peak at half of peak', () => {
  for (const [model, price] of Object.entries(PRICES)) {
    for (const tier of ['hit', 'miss', 'out']) {
      const [off, peak] = price[tier];
      assert.equal(peak, off * 2, `${model}.${tier} peak must be double off-peak`);
    }
  }
});

test('legacy and versioned ids resolve to a published price, unknown ones do not', () => {
  assert.equal(priceFor('deepseek-flash'), PRICES['deepseek-flash']);
  assert.equal(priceFor('deepseek-v4-pro'), PRICES['deepseek-v4-pro']);
  // Retired names are still accepted and billed at the Flash price.
  for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner']) {
    assert.equal(priceFor(alias), PRICES[DEFAULT_MODEL], alias);
  }
  assert.equal(priceFor('deepseek-v4-pro-0813'), PRICES['deepseek-v4-pro']);
  assert.equal(priceFor('deepseek-flash:batch'), PRICES[DEFAULT_MODEL]);
  assert.equal(priceFor('some-other-model'), null);
  assert.equal(priceFor(undefined), null);
  assert.equal(priceFor(''), null);
});

test('peak windows are the published UTC weekday hours', () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(isPeak(at('2026-09-15T02:00:00Z')), true, 'Tuesday 02:00 UTC is peak');
  assert.equal(isPeak(at('2026-09-15T08:30:00Z')), true, 'Tuesday 08:30 UTC is peak');
  assert.equal(isPeak(at('2026-09-15T04:00:00Z')), false, '04:00 ends the window');
  assert.equal(isPeak(at('2026-09-15T01:00:00Z')), true, '01:00 opens the window');
  assert.equal(isPeak(at('2026-09-15T00:59:00Z')), false);
  assert.equal(isPeak(at('2026-09-15T10:00:00Z')), false);
  assert.equal(isPeak(at('2026-09-15T13:00:00Z')), false);
  // 2026-09-19 is a Saturday, 2026-09-20 a Sunday: peak hours never apply.
  assert.equal(isPeak(at('2026-09-19T02:00:00Z')), false, 'Saturday');
  assert.equal(isPeak(at('2026-09-20T08:00:00Z')), false, 'Sunday');
  assert.equal(isPeak(undefined), false);
});

test('estimated cost prices disjoint token counts at the correct tier', () => {
  const offPeak = Date.parse('2026-09-15T13:00:00Z'), peak = Date.parse('2026-09-15T02:00:00Z');
  const usage = {inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6};
  // Off-peak flash: 1M cache-hit + 1M miss + 1M output.
  assert.equal(estimateCost('deepseek-flash', usage, offPeak), 0.003 + 0.15 + 0.6);
  // The same call during peak costs double.
  assert.equal(estimateCost('deepseek-flash', usage, peak), (0.003 + 0.15 + 0.6) * 2);
  // Pro rates are distinct from flash.
  assert.equal(estimateCost('deepseek-v4-pro', usage, offPeak), 0.022 + 0.66 + 1.98);
  // Cache writes bill at the miss rate.
  assert.equal(estimateCost('deepseek-flash', {cacheWriteTokens: 1e6}, offPeak), 0.15);
  assert.equal(estimateCost('deepseek-flash', {inputTokens: 1000, outputTokens: 1000}, offPeak), (1000 * 0.15 + 1000 * 0.6) / 1e6);
});

test('unknown models and empty usage never yield a confident zero', () => {
  const when = Date.parse('2026-09-15T13:00:00Z');
  assert.equal(estimateCost('mystery-model', {inputTokens: 1e6}, when), null);
  assert.equal(estimateCost('deepseek-flash', null, when), null);
  assert.equal(estimateCost('deepseek-flash', {}, when), null);
  assert.equal(estimateCost('deepseek-flash', {inputTokens: 0, outputTokens: 0}, when), null);
  // Malformed counts are dropped, not trusted.
  assert.equal(estimateCost('deepseek-flash', {inputTokens: 'lots', outputTokens: -5}, when), null);
  assert.equal(estimateCost('deepseek-flash', {inputTokens: 1.5, outputTokens: NaN}, when), null);
});

test('usage rows require a usable time and nonzero token total, not a model', () => {
  const when = Date.parse('2026-09-15T13:00:00Z');
  const row = usageEntry(when, 'deepseek-flash', {inputTokens: 10, outputTokens: 5, cacheReadTokens: 2});
  assert.deepEqual(row, {time: when, model: 'deepseek-flash', inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0});
  assert.equal(usageEntry(when, 'deepseek-flash', {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0}), null);
  assert.equal(usageEntry(when, 'deepseek-flash', null), null);
  assert.equal(usageEntry(NaN, 'deepseek-flash', {inputTokens: 1}), null);
  assert.equal(usageEntry(0, 'deepseek-flash', {inputTokens: 1}), null);
  assert.equal(usageEntry(when, 'x'.repeat(400), {inputTokens: 1}).model.length, 256);
  // Tokens whose owning request header was never seen stay real but unattributed.
  for (const missing of [undefined, null, '']) {
    const orphan = usageEntry(when, missing, {inputTokens: 7});
    assert.equal(orphan.model, null);
    assert.equal(orphan.inputTokens, 7);
  }
});

test('balance parsing accepts decimal strings and several currencies', () => {
  const view = balanceView({
    is_available: true,
    balance_infos: [
      {currency: 'CNY', total_balance: '138.00', granted_balance: '0.00', topped_up_balance: '138.00'},
      {currency: 'USD', total_balance: '18.50', granted_balance: '1.50', topped_up_balance: '17.00'}
    ]
  });
  assert.equal(view.isAvailable, true);
  assert.equal(view.currency, 'USD');
  assert.equal(view.balance, 18.5);
  assert.equal(view.granted, 1.5);
  assert.equal(view.toppedUp, 17);
  assert.deepEqual(view.infos, [{currency: 'CNY', balance: 138}, {currency: 'USD', balance: 18.5}]);
});

test('balance parsing falls back to CNY and never invents a number', () => {
  const cny = balanceView({is_available: false, balance_infos: [{currency: 'CNY', total_balance: '42.75'}]});
  assert.equal(cny.currency, 'CNY');
  assert.equal(cny.balance, 42.75);
  assert.equal(cny.isAvailable, false);
  assert.equal(cny.granted, null);
  for (const bad of [undefined, null, {}, {balance_infos: []}, {balance_infos: 'nope'}, {balance_infos: [null]}, {balance_infos: [{total_balance: '5'}]}]) {
    const view = balanceView(bad);
    assert.equal(view.balance, null, JSON.stringify(bad));
    assert.equal(view.currency, null);
  }
  // Negative and non-numeric amounts are not balances.
  assert.equal(balanceView({balance_infos: [{currency: 'USD', total_balance: '-1'}]}).balance, null);
  assert.equal(balanceView({balance_infos: [{currency: 'USD', total_balance: 'free'}]}).balance, null);
});

test('balance read targets the documented endpoint and rejects unusable responses', async () => {
  const oldFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, options) => {
      seen.push({url, authorization: options.headers.Authorization, redirect: options.redirect});
      return json({is_available: true, balance_infos: [{currency: 'USD', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99'}]});
    };
    const view = await readDeepSeek(BASE_URL, 'sk-deepseek-test-key-000000');
    assert.equal(view.balance, 9.99);
    assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance');
    assert.equal(seen[0].authorization, 'Bearer sk-deepseek-test-key-000000');
    assert.equal(seen[0].redirect, 'error');
    // A trailing slash on the configured base URL must not double up.
    seen.length = 0;
    await readDeepSeek('https://api.deepseek.com/', 'sk-deepseek-test-key-000000');
    assert.equal(seen[0].url, 'https://api.deepseek.com/user/balance');
  } finally { globalThis.fetch = oldFetch; }
});

test('balance read refuses non-HTTPS bases, missing keys and invalid payloads', async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('network must not be reached'); };
    await assert.rejects(() => readDeepSeek('http://api.deepseek.com', 'sk-deepseek-test-key-000000'), /Unsupported metadata endpoint/);
    await assert.rejects(() => readDeepSeek('not a url', 'sk-deepseek-test-key-000000'), /Invalid DeepSeek base URL/);
    await assert.rejects(() => readDeepSeek(BASE_URL, ''), /Missing credential/);
    for (const payload of [{}, {balance_infos: []}, {balance_infos: [{currency: 'USD'}]}, {is_available: true}]) {
      globalThis.fetch = async () => json(payload);
      await assert.rejects(() => readDeepSeek(BASE_URL, 'sk-deepseek-test-key-000000'), /Invalid balance metadata/, JSON.stringify(payload));
    }
    // A redirect must never be followed to a credential-bearing destination.
    let redirect = null;
    globalThis.fetch = async (url, options) => { redirect = options.redirect; return json({is_available: true, balance_infos: [{currency: 'USD', total_balance: '1'}]}); };
    await readDeepSeek(BASE_URL, 'sk-deepseek-test-key-000000');
    assert.equal(redirect, 'error');
  } finally { globalThis.fetch = oldFetch; }
});

test('usage rollups total exact tokens and separate priced from unknown models', () => {
  const offPeak = Date.parse('2026-09-15T13:00:00Z');
  const rows = [
    usageEntry(offPeak, 'deepseek-flash', {inputTokens: 1e6, outputTokens: 1e6}),
    usageEntry(offPeak, 'deepseek-flash', {cacheReadTokens: 1e6}),
    usageEntry(offPeak, 'deepseek-v4-pro', {outputTokens: 1e6}),
    usageEntry(offPeak, 'mystery-model', {outputTokens: 1e6})
  ];
  const summary = summarizeUsage(rows);
  assert.equal(summary.calls, 4);
  assert.equal(summary.priced, 3);
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.cost, (0.15 + 0.6) + 0.003 + 1.98);
  assert.deepEqual(summary.tokens, {input: 1e6, output: 3e6, cacheRead: 1e6, cacheWrite: 0});
  assert.equal(summary.models[0].model, 'deepseek-v4-pro');
  const flash = summary.models.find(row => row.model === 'deepseek-flash');
  assert.equal(flash.calls, 2);
  assert.equal(flash.priced, true);
  assert.equal(flash.cost, (0.15 + 0.6) + 0.003);
  const mystery = summary.models.find(row => row.model === 'mystery-model');
  assert.equal(mystery.cost, 0);
  assert.equal(mystery.priced, false);
  assert.equal(mystery.tokens, 1e6);
});

test('a rollup with nothing priceable reports no cost rather than zero', () => {
  const when = Date.parse('2026-09-15T13:00:00Z');
  assert.equal(summarizeUsage([]).cost, null);
  assert.equal(summarizeUsage([usageEntry(when, 'mystery-model', {outputTokens: 5})]).cost, null);
  assert.deepEqual(summarizeUsage([null, undefined]).calls, 2);
});

test('unattributed tokens are counted but never given a price', () => {
  const when = Date.parse('2026-09-15T13:00:00Z');
  const summary = summarizeUsage([usageEntry(when, null, {inputTokens: 2e6, outputTokens: 1e6})]);
  assert.equal(summary.tokens.input, 2e6);
  assert.equal(summary.tokens.output, 1e6);
  assert.equal(summary.cost, null, 'no model means no price, not zero');
  assert.equal(summary.unpriced, 1);
  assert.equal(summary.models[0].model, 'Unattributed');
  assert.equal(summary.models[0].priced, false);
});

test('period starts are UTC and the week begins on Monday', () => {
  const wednesday = Date.parse('2026-09-16T15:30:00Z');
  assert.equal(periodStart('Day', wednesday), Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(periodStart('Week', wednesday), Date.parse('2026-09-14T00:00:00Z'), 'Monday of that week');
  assert.equal(periodStart('Session', wednesday), null);
  assert.equal(periodStart('Total', wednesday), null);
  // A Sunday belongs to the week that started the previous Monday.
  assert.equal(periodStart('Week', Date.parse('2026-09-20T23:59:00Z')), Date.parse('2026-09-14T00:00:00Z'));
  // A Monday is its own week start.
  assert.equal(periodStart('Week', Date.parse('2026-09-14T00:00:00Z')), Date.parse('2026-09-14T00:00:00Z'));
});
