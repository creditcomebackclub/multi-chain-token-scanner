import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, HOUR, MINUTE } from '../src/config.js';
import { screenMarket, shortlistEligible, type ShortlistEntry } from '../src/shortlist.js';
import { renderShortlist, renderShortlistAlert } from '../src/telegram.js';
import { unknownSecurity } from '../src/security.js';
import type { Market } from '../src/types.js';

const now = Date.parse('2026-09-06T12:00:00Z');
const candidate = {
  chain: 'ethereum' as const,
  token: '0x1111111111111111111111111111111111111111',
  pool: '0x2222222222222222222222222222222222222222',
  createdAt: now - 60 * MINUTE,
  fetchedAt: now,
  liquidity: 100_000,
  volume5m: 25_000,
  buys5m: 35,
  sells5m: 15,
  buyers5m: 25,
  sellers5m: 12,
  name: '<Untrusted>',
  symbol: 'A&B',
  priceUsd: 0.01,
  source: 'geckoterminal' as const,
  url: 'https://www.geckoterminal.com/eth/pools/0x2222222222222222222222222222222222222222',
};
const dex: Market = {
  chain: candidate.chain, token: candidate.token, pool: candidate.pool, name: candidate.name,
  symbol: candidate.symbol, chart: 'https://dexscreener.com/ethereum/' + candidate.pool,
  createdAt: candidate.createdAt, fetchedAt: now, price: candidate.priceUsd, liquidity: 100_000,
  fdv: 1_000_000, marketCap: 900_000, priceChange5m: 5, raw: {},
};

test('free market screen fails closed when buyer count or price is unavailable', () => {
  assert.equal(screenMarket(candidate, now).marketPass, true);
  const buyers = screenMarket({ ...candidate, buyers5m: null }, now);
  assert.equal(buyers.marketPass, false); assert.match(buyers.reasons.join(' '), /Buyer count unavailable/);
  const price = screenMarket({ ...candidate, priceUsd: null }, now);
  assert.equal(price.marketPass, false); assert.match(price.reasons.join(' '), /Price unavailable/);
});

test('DEX Screener must confirm the exact pool and its valuation and price-move limits', () => {
  assert.equal(screenMarket(candidate, now, dex).marketPass, true);
  assert.match(screenMarket(candidate, now, null).reasons.join(' '), /exact-pool confirmation unavailable/);
  assert.match(screenMarket(candidate, now, { ...dex, pool: '0x3333333333333333333333333333333333333333' }).reasons.join(' '), /exact-pool confirmation unavailable/);
  assert.match(screenMarket(candidate, now, { ...dex, fdv: 2_100_001 }).reasons.join(' '), /FDV\/liquidity/);
  assert.match(screenMarket(candidate, now, { ...dex, priceChange5m: 51 }).reasons.join(' '), /price move already extended/);
});

test('free shortlist accepts only 10m–24h pools and excludes stable, wrapped, and major assets', () => {
  assert.equal(shortlistEligible(candidate, now), true);
  assert.equal(shortlistEligible({ ...candidate, createdAt: now - 9 * MINUTE }, now), false);
  assert.equal(shortlistEligible({ ...candidate, createdAt: now - 24 * HOUR - 1 }, now), false);
  for (const [symbol, name] of [['USDC', 'USD Coin'], ['WETH', 'Wrapped Ether'], ['BTCB', 'Bitcoin']]) {
    assert.equal(shortlistEligible({ ...candidate, symbol, name }, now), false);
  }
});

test('free shortlist is escaped, fresh, and explicitly not an execution signal', () => {
  const entry: ShortlistEntry = { ...screenMarket(candidate, now, dex), security: unknownSecurity(now, '<pending>') };
  const output = renderShortlist([entry], config({ SCAN_MODE: 'shortlist', CHAINS: 'ethereum' }), now);
  assert.match(output, /FREE SHORTLIST/);
  assert.match(output, /PASS — market screen only/);
  assert.match(output, /Execution is unverified/);
  assert.doesNotMatch(output, /HIGH-CONVICTION|SCORE \d/);
  assert.match(output, /A&amp;B/); assert.match(output, /&lt;pending&gt;/);
  assert.equal(renderShortlist([{ ...entry, at: now - 16 * MINUTE }], config({ SCAN_MODE: 'shortlist' }), now).includes('No fresh market-screen matches'), true);
  const oldUsdc = { ...entry, symbol: 'USDC', name: 'USD Coin', createdAt: now - 25 * HOUR };
  assert.doesNotMatch(renderShortlist([oldUsdc], config({ SCAN_MODE: 'shortlist' }), now), /USD Coin|USDC/);
  const miss = screenMarket({ ...candidate, volume5m: 1 }, now);
  assert.match(renderShortlist([miss], config({ SCAN_MODE: 'shortlist' }), now), /No fresh market-screen matches/);
  assert.match(renderShortlist([miss], config({ SCAN_MODE: 'shortlist' }), now, true), /NEAR MISS/);
});

test('free automatic alert identifies itself as a watch and preserves the full contract', () => {
  const entry: ShortlistEntry = { ...screenMarket(candidate, now, dex), security: { ...unknownSecurity(now, ''), status: 'PASS', reasons: [], raw: {} } };
  const output = renderShortlistAlert(entry, config({ SCAN_MODE: 'shortlist', CHAINS: 'ethereum', PUSH_ENABLED: 'true' }));
  assert.match(output, /NEW-TOKEN WATCH — FREE MODE/);
  assert.match(output, new RegExp(candidate.token));
  assert.match(output, /A&amp;B/);
  assert.match(output, /Automated GoPlus checks passed/);
  assert.match(output, /DEX Screener/);
  assert.doesNotMatch(output, /HIGH-CONVICTION|SCORE \d/);
});
