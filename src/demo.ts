import { readFileSync } from 'node:fs';
import { aggregate } from './aggregate.js';
import { MINUTE, HOUR } from './config.js';
import { normalizeTrade } from './providers/bitquery.js';
import { parseMarket } from './providers/enrichment.js';
import { checkSecurity } from './security.js';
import { evaluate } from './scoring.js';
import { renderAlert } from './telegram.js';
import type { Trade } from './types.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), 'utf8'));
const now = Math.floor(Date.now() / MINUTE) * MINUTE;
const raw = fixture('bitquery-trade'), token = raw.Pair.Token.Address, events: Trade[] = [];
for (let m = 55; m >= 0; m--) {
  for (let i = 0; i < 32; i++) {
    const row = structuredClone(raw), at = now - m * MINUTE + i * 1500 + 1000;
    const price = 1 + (55 - m) * 0.001 + (i === 10 ? 0.02 : 0);
    const usd = m <= 4 ? 1100 : m <= 9 ? 400 : 200;
    row.Block.Time = new Date(at).toISOString(); row.Trader.Address = `synthetic-buyer-${m}-${i}`;
    row.TransactionHeader.Hash = `synthetic-tx-${m}-${i}`; row.Side = i < 24 ? 'Buy' : 'Sell';
    row.Amounts.Base = String(usd / price); row.AmountsInUsd.Quote = String(usd);
    events.push(normalizeTrade(row, now + MINUTE)!);
  }
}
const input = (at: number) => {
  const rawMarket = fixture('dex-pair'); rawMarket.pairCreatedAt = now - HOUR;
  return { chain: 'ethereum' as const, token, now: at, market: parseMarket('ethereum', token, rawMarket, at),
    metrics: aggregate([...events, ...events], at), security: checkSecurity('ethereum', token, fixture('goplus-evm'), at), tradeable: true, covered: true };
};
const first = evaluate(input(now)), second = evaluate({ ...input(now + MINUTE), previous: first });
console.log('SYNTHETIC OFFLINE REPLAY — no network, database, wallet, or Telegram message.\n');
console.log(`Fed ${events.length * 2} rows including exact duplicates. Five-minute unique swaps: ${second.metrics.m5.buys + second.metrics.m5.sells}.`);
console.log(`First snapshot: ${first.score}/100. Second after 60s: ${second.score}/100. Confirmed: ${second.confirmed}.`);
console.log(`Components: ${JSON.stringify(second.components)}\n`);
if (!second.confirmed) throw new Error(`Demo did not qualify: ${second.reasons.join(', ')}`);
console.log(renderAlert(second));
const bad = input(now + MINUTE); bad.security = { ...bad.security, status: 'UNKNOWN', reasons: ['Provider unavailable'] };
console.log(`\nSecurity outage replay: ${evaluate({ ...bad, previous: first }).reasons.join('; ')}. No push.`);
