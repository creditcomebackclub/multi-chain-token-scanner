import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { HOUR, MINUTE, RULE_ID } from '../src/config.js';
import { aggregate } from '../src/aggregate.js';
import { normalizeTrade } from '../src/providers/bitquery.js';
import { parseMarket } from '../src/providers/enrichment.js';
import { checkSecurity } from '../src/security.js';
import { evaluate } from '../src/scoring.js';
import { Store, type Database, type Sql } from '../src/store.js';
import type { Snapshot, Trade } from '../src/types.js';
export const TOKEN = '0x1111111111111111111111111111111111111111';
export const SOL = 'So11111111111111111111111111111111111111112';
export const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
export function trades(now: number): Trade[] {
  const base = fixture('bitquery-trade'), result: Trade[] = [];
  const boundary = Math.floor(now / MINUTE) * MINUTE;
  for (let m = 55; m > 0; m--) {
    for (let i = 0; i < 32; i++) {
      const at = boundary - m * MINUTE + i * 1500 + 1000;
      const price = 1 + (55 - m) * 0.001 + (i === 10 ? 0.02 : 0);
      const usd = m <= 5 ? 1000 : m <= 10 ? 400 : 200;
      const r = structuredClone(base);
      r.Block.Time = new Date(at).toISOString(); r.Side = i < 24 ? 'Buy' : 'Sell';
      r.TransactionHeader.Hash = `tx-${m}-${i}`; r.Trader.Address = `trader-${m}-${i}`;
      r.Amounts.Base = String(usd / price); r.AmountsInUsd.Quote = String(usd);
      result.push(normalizeTrade(r, now)!);
    }
  }
  return result;
}
export function evaluationInput(now = Date.now()) {
  const p = fixture('dex-pair'); p.pairCreatedAt = now - HOUR;
  return { chain: 'ethereum' as const, token: TOKEN, now, market: parseMarket('ethereum', TOKEN, p, now)!,
    metrics: aggregate(trades(now), now), security: checkSecurity('ethereum', TOKEN, fixture('goplus-evm'), now), tradeable: true, covered: true };
}
export function qualified(now = Date.now(), token = TOKEN): Snapshot {
  const firstInput = evaluationInput(now - MINUTE), first = evaluate(firstInput);
  const second = evaluationInput(now), snapshot = evaluate({ ...second, previous: first });
  snapshot.token = token; snapshot.market!.token = token;
  return snapshot;
}
export async function testStore() {
  const db = new PGlite();
  const query = async (sql: string, params?: any[]) => {
    if (!params && sql.includes(';')) { const result = await db.exec(sql); return { rows: result.at(-1)?.rows || [] }; }
    return db.query<any>(sql, params);
  };
  const driver: Database = { query, close: () => db.close(), transaction: fn => db.transaction(tx => fn({ query: (sql, params) => tx.query<any>(sql, params) } as Sql)) };
  const store = new Store(driver); await store.migrate();
  return store;
}
export async function allowAlerts(store: Store, scope = 'test-scope', chatKey = 'chat-key') {
  await store.validateChat(chatKey);
  await store.health('bitquery:ethereum', 'healthy', 'test', Date.now());
  await store.db.query('INSERT INTO rollout_approvals(rule_id,scope,evidence) VALUES($1,$2,$3)', [RULE_ID, scope, JSON.stringify({ test: true })]);
}
export async function savedQualified(store: Store, token = TOKEN) {
  const s = qualified(Date.now(), token); s.id = randomUUID(); await store.save(s); return s;
}
