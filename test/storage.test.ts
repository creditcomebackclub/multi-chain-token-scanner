import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DAY, MAX_ALERTS_PER_24H, MAX_SCOUT_ALERTS_PER_24H, MINUTE, RULE_ID, config } from '../src/config.js';
import { Telegram } from '../src/telegram.js';
import { Http } from '../src/providers/http.js';
import { approveRollout, scopeId } from '../src/rollout.js';
import { Worker } from '../src/worker.js';
import { DexScreener, GoPlus } from '../src/providers/enrichment.js';
import { BitqueryHttp } from '../src/providers/bitquery.js';
import { testStore, allowAlerts, savedQualified, TOKEN, trades, fixture, qualified } from './helpers.js';
import { screenMarket, type ShortlistEntry } from '../src/shortlist.js';
import { unknownSecurity } from '../src/security.js';
import type { Market } from '../src/types.js';
const options = { enabled: true, tradeable: true, scope: 'test-scope', chatKey: 'chat-key' };
const shortlistEntry = (token = TOKEN, security: 'PASS' | 'UNKNOWN' | 'REJECT' = 'PASS'): ShortlistEntry => {
  const now = Date.now(), pool = '0x2222222222222222222222222222222222222222';
  const candidate = { chain: 'ethereum' as const, token, pool, createdAt: now - 60 * MINUTE, fetchedAt: now,
    liquidity: 100_000, volume5m: 25_000, buys5m: 35, sells5m: 15, buyers5m: 25, sellers5m: 12,
    name: 'Test token', symbol: 'TEST', priceUsd: 0.01, source: 'geckoterminal' as const,
    url: `https://www.geckoterminal.com/eth/pools/${pool}` };
  const dex: Market = { chain: 'ethereum', token, pool, name: 'Test token', symbol: 'TEST',
    chart: `https://dexscreener.com/ethereum/${pool}`, createdAt: candidate.createdAt, fetchedAt: now,
    price: 0.01, liquidity: 100_000, fdv: 1_000_000, marketCap: 900_000, priceChange5m: 5, raw: {} };
  return { ...screenMarket(candidate, now, dex), security: { ...unknownSecurity(now, 'test evidence incomplete'), status: security } };
};
test('database migrations are repeatable and normalized events survive replay', async () => {
  const s = await testStore();
  try {
    await s.migrate(); const e = trades(Date.now()); await s.ingest(e); await s.ingest(e);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM events')).rows[0].n, e.length);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM candidates')).rows[0].n, 1);
    const sample = await savedQualified(s); assert.equal((await s.previous('ethereum', TOKEN))?.id, sample.id);
    await s.shadow(sample); await s.shadow(sample);
    assert.equal((await s.activeReferences(Date.now())).length, 1);
  } finally { await s.db.close(); }
});
test('concurrent reservations cannot exceed the rolling alert cap; cooldown survives process replacement', async () => {
  const s = await testStore();
  try {
    await allowAlerts(s);
    const candidates = []; for (let i = 1; i <= MAX_ALERTS_PER_24H + 3; i++) candidates.push(await savedQualified(s, '0x' + i.toString(16).padStart(40, '0')));
    const reservations = await Promise.all(candidates.map(c => s.reserve(c, options)));
    assert.equal(reservations.filter(Boolean).length, MAX_ALERTS_PER_24H);
    await s.migrate(); assert.equal(await s.reserve(candidates[0], options), null);
  } finally { await s.db.close(); }
});
test('daily cap is rolling across midnight and ambiguous sends count conservatively', async () => {
  const s = await testStore();
  try {
    await allowAlerts(s); const a = await savedQualified(s);
    const id = (await s.reserve(a, options))!; await s.finishAlert(id, 'unknown');
    assert.equal(await s.reserve(a, options), null);
    await s.db.query("UPDATE alerts SET reserved_at=clock_timestamp()-interval '25 hours',sent_at=clock_timestamp()-interval '23 hours' WHERE id=$1", [id]);
    assert.equal(await s.reserve(a, options), null);
    await s.db.query("UPDATE alerts SET sent_at=clock_timestamp()-interval '25 hours' WHERE id=$1", [id]);
    assert.ok(await s.reserve(a, options));
  } finally { await s.db.close(); }
});
test('free SCOUT reservations require passed security, deduplicate, and use their own rolling cap', async () => {
  const s = await testStore();
  try {
    await s.validateChat('chat-key');
    const opts = { enabled: true, tradeable: true, chatKey: 'chat-key' };
    assert.equal(await s.reserveShortlist(shortlistEntry(), { ...opts, enabled: false }), null);
    assert.equal(await s.reserveShortlist(shortlistEntry(), { ...opts, tradeable: false }), null);
    assert.equal(await s.reserveShortlist(shortlistEntry(TOKEN, 'UNKNOWN'), opts), null);
    assert.equal(await s.reserveShortlist(shortlistEntry(TOKEN, 'REJECT'), opts), null);
    const entries = Array.from({ length: MAX_SCOUT_ALERTS_PER_24H + 1 }, (_, i) => shortlistEntry('0x' + (i + 1).toString(16).padStart(40, '0')));
    const ids = await Promise.all(entries.map(entry => s.reserveShortlist(entry, opts)));
    assert.equal(ids.filter(Boolean).length, MAX_SCOUT_ALERTS_PER_24H);
    assert.equal(await s.reserveShortlist(entries[0], opts), null);
    const id = ids.find(Boolean)!; assert.equal(await s.beginShortlistSend(id), true);
    await s.finishShortlistAlert(id, 'sent', 42);
    assert.deepEqual(await s.shortlistAlertStats(), { sent7d: 1, used24h: MAX_SCOUT_ALERTS_PER_24H });
  } finally { await s.db.close(); }
});
test('unapproved rollout, observe-only, pause, stale data, unknown security and unsupported chains block reservations', async () => {
  const s = await testStore();
  try {
    const a = await savedQualified(s); assert.equal(await s.reserve(a, options), null);
    await allowAlerts(s);
    assert.equal(await s.reserve(a, { ...options, enabled: false }), null);
    assert.equal(await s.reserve(a, { ...options, tradeable: false }), null);
    assert.equal(await s.reserve(a, { ...options, chatKey: 'wrong' }), null);
    assert.equal(await s.reserve({ ...a, at: Date.now() - 2 * MINUTE }, options), null);
    assert.equal(await s.reserve({ ...a, security: { ...a.security, status: 'UNKNOWN' } }, options), null);
    await s.pause(true); assert.equal(await s.reserve(a, options), null); await s.pause(false);
    await s.health('bitquery:ethereum', 'degraded', 'gap'); assert.equal(await s.reserve(a, options), null);
    await s.health('bitquery:ethereum', 'healthy', 'backfilled', Date.now());
    await s.gap('ethereum', Date.now() - 10 * MINUTE, Date.now() - 5 * MINUTE); assert.equal(await s.reserve(a, options), null);
  } finally { await s.db.close(); }
});
test('Telegram validates only the configured private chat and persists pause/resume', async () => {
  const s = await testStore(), sent: any[] = [];
  try {
    const c = config({ TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'fake' });
    const bot = new Telegram(c, s, new Http(0, async (_url, init) => { sent.push(JSON.parse(init!.body as string)); return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } })); }));
    await bot.handle({ message: { chat: { id: 456, type: 'private' }, text: '/start' } });
    await bot.handle({ message: { chat: { id: 123, type: 'group' }, text: '/start' } });
    assert.equal(sent.length, 0); assert.equal((await s.state()).chat_key, null);
    const msg = (text: string) => ({ message: { chat: { id: 123, type: 'private' }, text } });
    await bot.handle(msg('/start')); assert.equal((await s.state()).chat_key, bot.chatKey);
    await bot.handle(msg('/pause')); assert.equal((await s.state()).paused, true);
    await bot.handle(msg('/resume')); assert.equal((await s.state()).paused, false);
    await bot.handle(msg('/status')); await bot.handle(msg('/stats')); await bot.handle(msg('/recent'));
    assert.equal(sent.length, 6); assert.ok(sent[3].text.includes('OBSERVE ONLY'));
  } finally { await s.db.close(); }
});
test('a Telegram timeout is never retried and occupies the slot', async () => {
  const s = await testStore(); let calls = 0;
  try {
    const c = config({ TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'fake', PUSH_ENABLED: 'true' });
    const bot = new Telegram(c, s, new Http(0, async () => { calls++; throw new Error('Network timeout with a secret in original URL'); }));
    await allowAlerts(s, scopeId(c), bot.chatKey); const a = await savedQualified(s);
    assert.equal(await bot.alert(a), false); assert.equal(await bot.alert(a), false); assert.equal(calls, 1);
    assert.equal((await s.db.query('SELECT status FROM alerts')).rows[0].status, 'unknown');
  } finally { await s.db.close(); }
});
test('database failure prevents any Telegram request', async () => {
  const s = await testStore(); await s.db.close(); let calls = 0;
  const bot = new Telegram(config({ PUSH_ENABLED: 'true' }), s, new Http(0, async () => { calls++; return new Response('{}'); }));
  await assert.rejects(() => bot.alert(qualified())); assert.equal(calls, 0);
});
test('health warning suppression survives fresh provider updates', async () => {
  const s = await testStore();
  try {
    await s.health('goplus', 'degraded', 'test'); await s.warned('goplus', true); await s.health('goplus', 'degraded', 'still down');
    assert.equal((await s.healthAll())[0].warned, true); await s.health('goplus', 'healthy', 'recovered'); assert.equal((await s.healthAll())[0].warned, true);
  } finally { await s.db.close(); }
});
test('end-to-end replay ingests, enriches, checks security, confirms and records shadow without sending', async () => {
  const s = await testStore();
  try {
    const c = config({ CHAINS: 'ethereum' }), now = Date.now();
    await s.ingest(trades(now)); await s.health('bitquery:ethereum', 'healthy', 'test', now);
    const previous = qualified(now - MINUTE); previous.confirmed = false; await s.save(previous);
    const dex = new DexScreener(new Http(0, async () => {
      const p = fixture('dex-pair'); p.pairCreatedAt = Date.now() - 60 * MINUTE; return new Response(JSON.stringify([p]));
    }));
    const go = new GoPlus('', new Http(0, async (url: any) => new Response(JSON.stringify(String(url).includes('address_security') ? fixture('goplus-evm').creatorSecurity : fixture('goplus-evm')))));
    const bq = new BitqueryHttp('test', new Http(0, async () => new Response(JSON.stringify({ data: { Trading: { Trades: [] } } }))));
    await new Worker(c, s, dex, go, bq).tick();
    const latest = await s.previous('ethereum', TOKEN); assert.equal(latest?.confirmed, true, JSON.stringify(latest));
    assert.equal((await s.activeReferences(Date.now())).length, 1);
    assert.equal((await s.db.query('SELECT * FROM alerts')).rows.length, 0);
  } finally { await s.db.close(); }
});
test('rollout rejects insufficient observation, missing one-minute evidence, and stale rule scope', async () => {
  const s = await testStore();
  try {
    const c = config({ CHAINS: 'ethereum' }), now = Date.now();
    const evidence = { ruleId: RULE_ID, scope: scopeId(c), reviewedBy: 'Test reviewer', reviews: [{ referenceId: randomUUID(), checkedAt: now, fullAddressAndChainVerified: true, orderUsd: 100, priceImpactPercent: 1, source: 'Test-only quote evidence' }] };
    await assert.rejects(() => approveRollout(s, c, evidence), /Seven full/);
    await assert.rejects(() => approveRollout(s, c, { ...evidence, ruleId: 'other' }), /different rules/);
    await s.db.query('UPDATE rule_versions SET started_at=$1', [new Date(now - 8 * DAY).toISOString()]);
    await assert.rejects(() => approveRollout(s, c, evidence), /Insufficient healthy/);
  } finally { await s.db.close(); }
});
test('rollout requires actual one-minute samples and approves a complete reviewed seven-day record', async () => {
  const s = await testStore();
  try {
    const c = config({ CHAINS: 'ethereum' }), now = Math.floor(Date.now() / MINUTE) * MINUTE;
    await s.db.query('UPDATE rule_versions SET started_at=$1', [new Date(now - 8 * DAY).toISOString()]);
    await s.db.query(`INSERT INTO observation_minutes(rule_id,scope,at)
      SELECT $1,$2,generate_series($3::timestamptz,$4::timestamptz,interval '1 minute')`, [RULE_ID, scopeId(c), new Date(now - 7 * DAY).toISOString(), new Date(now).toISOString()]);
    await s.health('bitquery:ethereum', 'healthy', 'test', now);
    await s.health('dexscreener', 'healthy', 'test'); await s.health('goplus', 'healthy', 'test');
    const snapshot = qualified(now - 3 * MINUTE); await s.save(snapshot); const id = (await s.shadow(snapshot))!;
    const review = { ruleId: RULE_ID, scope: scopeId(c), reviewedBy: 'Test reviewer', reviews: [{ referenceId: id, checkedAt: snapshot.at + MINUTE, fullAddressAndChainVerified: true, orderUsd: 100, priceImpactPercent: 1, source: 'Synthetic read-only quote, test evidence only' }] };
    await assert.rejects(() => approveRollout(s, c, review, now), /One-minute acceptance failed/);
    await s.sample(id, snapshot.at + MINUTE, 1.06, 300000);
    const result = await approveRollout(s, c, review, now); assert.equal(result.passed, 1); assert.equal(result.total, 1);
    assert.equal((await s.db.query('SELECT * FROM rollout_approvals')).rows.length, 1);
  } finally { await s.db.close(); }
});
test('successful delivery records its message ID and tracks an alert outcome reference', async () => {
  const s = await testStore(); let calls = 0;
  try {
    const c = config({ CHAINS: 'ethereum', TELEGRAM_CHAT_ID: '123', TELEGRAM_BOT_TOKEN: 'fake', PUSH_ENABLED: 'true' });
    const bot = new Telegram(c, s, new Http(0, async () => { calls++; return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })); }));
    await allowAlerts(s, scopeId(c), bot.chatKey); const snapshot = await savedQualified(s);
    assert.equal(await bot.alert(snapshot), true); assert.equal(await bot.alert(snapshot), false); assert.equal(calls, 1);
    const alert = (await s.db.query('SELECT * FROM alerts')).rows[0]; assert.equal(alert.status, 'sent'); assert.equal(Number(alert.message_id), 42);
    const refs = await s.activeReferences(Date.now()); assert.equal(refs[0].kind, 'alert'); assert.equal((await s.stats()).alerts, 1);
  } finally { await s.db.close(); }
});
