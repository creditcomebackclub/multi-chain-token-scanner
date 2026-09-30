import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAINS, HOUR, MINUTE, address, config, fomoAllowed, rules } from '../src/config.js';
import { normalizeTrade, tradeQuery, BitqueryHttp } from '../src/providers/bitquery.js';
import { heliusDiscoveries } from '../src/providers/helius.js';
import { parseMarket, DexScreener } from '../src/providers/enrichment.js';
import { Http } from '../src/providers/http.js';
import { chartSecurityGate, checkSecurity } from '../src/security.js';
import { aggregate, flow } from '../src/aggregate.js';
import { evaluate } from '../src/scoring.js';
import { renderAlert } from '../src/telegram.js';
import { measure, median } from '../src/outcomes.js';
import { fixture, TOKEN, SOL, evaluationInput, qualified, trades } from './helpers.js';
const now = Date.parse('2026-09-04T12:00:00Z');
test('canonical dedup key uses amount precision, token, chain, wallet, side and tx', () => {
  const r = fixture('bitquery-trade'), e = normalizeTrade(r, now)!;
  r.Amounts.Base = '1e3'; assert.equal(normalizeTrade(r, now)!.id, e.id);
  r.Side = 'Sell'; assert.notEqual(normalizeTrade(r, now)!.id, e.id);
  r.Pair.Market.NetworkBid = 'bid:base'; assert.notEqual(normalizeTrade(r, now)!.id, e.id);
});
test('executed price and USD use quote leg; pool is not EVM factory', () => {
  const r = fixture('bitquery-trade'), e = normalizeTrade(r, now)!;
  assert.equal(e.usd, 100); assert.equal(e.price, 0.1); assert.equal(e.pool, r.Pair.Pool.Address); assert.equal(e.token, TOKEN);
});
test('malformed, native, future, zero-price and non-DEX rows are excluded', () => {
  for (const mutate of [(r: any) => r.AmountsInUsd.Quote = 'NaN', (r: any) => r.Amounts.Base = '0', (r: any) => r.Pair.Token.IsNative = true, (r: any) => r.Pair.Market.ProtocolFamily = 'Seaport', (r: any) => r.Pair.Token.Address = 'bad', (r: any) => r.Block.Time = new Date(now + MINUTE).toISOString()]) {
    const r = fixture('bitquery-trade'); mutate(r); assert.equal(normalizeTrade(r, now), null);
  }
});
test('case handling preserves Solana and canonicalizes EVM', () => {
  assert.equal(address('solana', SOL), SOL); assert.equal(address('ethereum', '0x' + 'AB'.repeat(20)), '0x' + 'ab'.repeat(20));
});
test('rolling windows exclude expired/future trades and count duplicate legs once', () => {
  const e = normalizeTrade(fixture('bitquery-trade'), now)!;
  const result = aggregate([e, e, { ...e, id: 'old', at: now - 5 * MINUTE }, { ...e, id: 'future', at: now + 1 }], now);
  assert.equal(result.m5.volume, 100); assert.equal(result.m5.buys, 1);
  assert.equal(flow([e, { ...e, id: 'leg2', usd: 200 }]).buys, 1);
});
test('gaps cannot manufacture technical indicators', () => {
  const events = trades(now).filter(e => e.at < now - 5 * MINUTE || e.at > now - 4 * MINUTE);
  const m = aggregate(events, now); assert.equal(m.ema21, null); assert.equal(m.sma50, null);
});
test('complete EVM and Solana security fixtures pass; missing results never pass', () => {
  assert.equal(checkSecurity('ethereum', TOKEN, fixture('goplus-evm'), now).status, 'PASS');
  assert.equal(checkSecurity('solana', SOL, fixture('goplus-solana'), now).status, 'PASS');
  for (const raw of [{}, { code: 1, result: {} }, { code: 1, result: { [TOKEN]: {} } }]) assert.equal(checkSecurity('ethereum', TOKEN, raw, now).status, 'UNKNOWN');
});
test('each critical EVM field rejects true and remains UNKNOWN when absent', () => {
  const keys = ['is_honeypot','cannot_buy','cannot_sell_all','is_proxy','is_mintable','can_take_back_ownership','owner_change_balance','hidden_owner','selfdestruct','external_call','is_blacklisted','is_whitelisted','slippage_modifiable','personal_slippage_modifiable','transfer_pausable'];
  for (const key of keys) {
    const p = fixture('goplus-evm'); p.result[TOKEN][key] = '1'; assert.equal(checkSecurity('ethereum', TOKEN, p, now).status, 'REJECT', key);
    delete p.result[TOKEN][key]; assert.equal(checkSecurity('ethereum', TOKEN, p, now).status, 'UNKNOWN', key);
  }
});
test('tax, holder or creator concentration, and malicious creators reject', () => {
  for (const mutate of [(p: any) => p.result[TOKEN].sell_tax = '0.11', (p: any) => p.result[TOKEN].holders[0].percent = '0.25', (p: any) => p.result[TOKEN].creator_percent = '1', (p: any) => p.creatorSecurity.result.honeypot_related_address = '1']) {
    const p = fixture('goplus-evm'); mutate(p); assert.equal(checkSecurity('ethereum', TOKEN, p, now).status, 'REJECT');
  }
});
test('chart security warns on launchpad structure but keeps execution and creator risks blocked',()=>{
  assert.deepEqual(chartSecurityGate({status:'REJECT',reasons:['Dangerous holder concentration','is_proxy']}),{
    allowed:true,warnings:['Dangerous holder concentration','is_proxy'],blockers:[]});
  assert.equal(chartSecurityGate({status:'UNKNOWN',reasons:['Unknown: creator','Unknown: Top-ten holder concentration']}).allowed,true);
  for(const reason of ['is_mintable','cannot_sell_all','Creator deployed malicious contracts','Security response unavailable or token missing','Unknown: buy_tax']){
    const gate=chartSecurityGate({status:'REJECT',reasons:['Dangerous holder concentration',reason]});
    assert.equal(gate.allowed,false,reason);assert.deepEqual(gate.blockers,[reason]);
  }
});
test('exact EVM pool and burn balances do not create false holder-concentration rejects', () => {
  const pool='0x2222222222222222222222222222222222222222';
  const pair=fixture('goplus-evm');pair.result[TOKEN].holders[0]={address:pool,percent:'0.9'};
  assert.equal(checkSecurity('ethereum',TOKEN,pair,now,pool).status,'PASS');
  assert.equal(checkSecurity('ethereum',TOKEN,pair,now).status,'REJECT');
  const burn=fixture('goplus-evm');burn.result[TOKEN].holders[0]={address:'0x000000000000000000000000000000000000dead',percent:'0.9'};
  assert.equal(checkSecurity('ethereum',TOKEN,burn,now,pool).status,'PASS');
});
test('new GoPlus B20, structured fake-token and exact-pool fee risks are enforced',()=>{
  const pool='0x2222222222222222222222222222222222222222';
  const fake=fixture('goplus-evm');fake.result[TOKEN].fake_token={value:'1'};
  assert.equal(checkSecurity('ethereum',TOKEN,fake,now,pool).status,'REJECT');
  const b20=fixture('goplus-evm');b20.result[TOKEN].b20_token={is_b20:'1',b20_info:Object.fromEntries(['mintable','transfer_pausable','owner_change_balance','metadata_modifiable','blacklist','whitelist','cannot_sell','cannot_buy'].map(k=>[k,{status:k==='cannot_sell'?'1':'0'}]))};
  assert.equal(checkSecurity('ethereum',TOKEN,b20,now,pool).status,'REJECT');
  const fee=fixture('goplus-evm');fee.result[TOKEN].buy_tax='0.05';fee.result[TOKEN].sell_tax='0.05';fee.result[TOKEN].dex=[{pair:pool,pool_fee:'0.06'}];
  const result=checkSecurity('ethereum',TOKEN,fee,now,pool);assert.equal(result.status,'REJECT');assert.equal(result.buyTax,0.11);assert.equal(result.sellTax,0.11);
  assert.equal(checkSecurity('ethereum',TOKEN,fee,now,'0x3333333333333333333333333333333333333333').status,'PASS');
});
test('Solana control and future transfer-fee hazards reject', () => {
  for (const mutate of [(p: any) => p.freezable.status = '1', (p: any) => p.transfer_hook = [{ address: 'hook' }], (p: any) => p.transfer_fee = { current_fee_rate: { fee_rate: '0' }, scheduled_fee_rate: { fee_rate: '1100' } }, (p: any) => p.default_account_state = '2']) {
    const p = fixture('goplus-solana'); mutate(p.result[SOL]); assert.equal(checkSecurity('solana', SOL, p, now).status, 'REJECT');
  }
});
test('incomplete creator, top-ten holder and Solana extension evidence remains UNKNOWN', () => {
  const p = fixture('goplus-evm'); delete p.creatorSecurity.result.fake_token;
  assert.equal(checkSecurity('ethereum', TOKEN, p, now).status, 'UNKNOWN');
  const holders = fixture('goplus-evm'); holders.result[TOKEN].holders.length = 3;
  assert.equal(checkSecurity('ethereum', TOKEN, holders, now).status, 'UNKNOWN');
  for (const key of ['transfer_fee', 'transfer_hook']) {
    const sol = fixture('goplus-solana'); sol.result[SOL][key] = null;
    assert.equal(checkSecurity('solana', SOL, sol, now).status, 'UNKNOWN');
  }
});
test('two strong snapshots confirm; a lone snapshot does not', () => {
  const s = evaluate(evaluationInput(now)); assert.ok(s.score! >= 80, JSON.stringify(s)); assert.equal(s.confirmed, false);
  assert.equal(qualified(now).confirmed, true);
});
test('confirmation requires 60s separation, unchanged pool, stable liquidity and buy flow', () => {
  const previous = evaluate(evaluationInput(now - MINUTE));
  for (const mutate of [(a: any) => a.now -= 1, (a: any) => a.market.pool = 'other', (a: any) => a.market.liquidity *= 0.99, (a: any) => a.metrics.m5.buyUsd *= 0.99, (a: any) => a.security.sellTax = 0.01]) {
    const a = evaluationInput(now); mutate(a); assert.equal(evaluate({ ...a, previous }).confirmed, false);
  }
  assert.equal(evaluate({ ...evaluationInput(now), previous: { ...previous, qualifies: false } }).confirmed, false);
  assert.equal(evaluate({ ...evaluationInput(now), previous: { ...previous, at: now - 4 * MINUTE } }).confirmed, false);
});
test('hard rules block risk, age, liquidity, pump, flow concentration, unsupported routing and gaps', () => {
  const mutations = [(a: any) => a.market.createdAt = now - 9 * MINUTE, (a: any) => a.market.createdAt = now - 25 * HOUR, (a: any) => a.market.liquidity = CHAINS.ethereum.minLiquidity - 1, (a: any) => a.market.fdv = a.market.liquidity * 21, (a: any) => a.market.priceChange5m = 51, (a: any) => a.metrics.m5.buyers = rules.minBuyers5m - 1, (a: any) => a.metrics.m5.volume = rules.minVolume5mUsd - 1, (a: any) => a.metrics.m5.countRatio = rules.minBuySellCountRatio - 0.01, (a: any) => a.metrics.m5.usdRatio = 1.14, (a: any) => a.metrics.m5.largestBuyerShare = 0.21, (a: any) => a.metrics.m5.topFiveShare = 0.61, (a: any) => a.security.status = 'UNKNOWN', (a: any) => a.tradeable = false, (a: any) => a.covered = false];
  for (const mutate of mutations) { const a = evaluationInput(now); mutate(a); const s = evaluate(a); assert.equal(s.confirmed, false); assert.equal(s.score, null); }
});
test('malformed DEX identity, quote-side token and untrusted chart URLs cannot enrich', () => {
  for (const mutate of [(p: any) => p.baseToken.address = p.quoteToken.address, (p: any) => p.chainId = 'base', (p: any) => p.url = 'https://phishing.example/chart', (p: any) => p.fdv = null, (p: any) => p.priceUsd = 'NaN']) {
    const p = fixture('dex-pair'); mutate(p); assert.equal(parseMarket('ethereum', TOKEN, p, now), null);
  }
});
test('DEX batches at most 30 and reuses 30-second cache', async () => {
  const urls: string[] = []; const http = new Http(0, async (url: any) => { urls.push(String(url)); return new Response('[]'); });
  const dex = new DexScreener(http), tokens = Array.from({ length: 31 }, (_, i) => '0x' + i.toString(16).padStart(40, '0'));
  await dex.batch('ethereum', tokens, now); await dex.batch('ethereum', tokens, now + 29999); assert.equal(urls.length, 2);
  await dex.batch('ethereum', tokens, now + 30000); assert.equal(urls.length, 4);
});
test('Helius produces deduplicated discovery hints only for successful transactions', () => {
  const p = fixture('helius-notification'); p.params.result.transaction.meta.postTokenBalances.push(p.params.result.transaction.meta.postTokenBalances[0]);
  const e = heliusDiscoveries(p, now); assert.equal(e.length, 1); assert.equal(e[0].token, SOL); assert.equal('usd' in e[0], false);
  p.params.result.transaction.meta.err = 'failed'; assert.equal(heliusDiscoveries(p, now).length, 0);
});
test('malformed Helius balances are safely ignored', () => {
  const p = fixture('helius-notification'); p.params.result.transaction.meta.postTokenBalances = {};
  assert.deepEqual(heliusDiscoveries(p, now), []);
});
test('Telegram escapes metadata and renders full token instead of pool', () => {
  const s = qualified(now), message = renderAlert(s);
  assert.ok(message.includes(`<code>${TOKEN}</code>`)); assert.ok(!message.includes(`<code>${s.market!.pool}</code>`));
  assert.ok(message.includes('Example &lt;Token&gt; &amp; Co')); assert.ok(message.includes(`/tokens/ethereum/${TOKEN}`));
});
test('observe-only defaults and Base allowlist are explicit', () => {
  const c = config({}); assert.equal(c.pushEnabled, false); assert.equal(c.scoutPushEnabled,false); assert.equal(fomoAllowed('base', c), false);
  assert.equal(fomoAllowed('base', { ...c, baseFomoConfirmed: true }), true);
  assert.throws(() => config({ PUSH_ENABLED: 'yes' }));
});
test('Bitquery schema errors and coverage failures propagate; bounded backfill splits truncation', async () => {
  const api = new BitqueryHttp('test', new Http(0, async () => new Response(JSON.stringify({ errors: [{ message: 'unsupported' }] }))));
  await assert.rejects(() => api.probe('robinhood', now));
  let calls = 0, ingested = 0;
  const splitting = new BitqueryHttp('test', new Http(0, async () => { calls++; return new Response(JSON.stringify({ data: { Trading: { Trades: calls === 1 ? Array(1000).fill(fixture('bitquery-trade')) : [] } } })); }));
  await splitting.backfill('ethereum', now - MINUTE, now, async e => { ingested += e.length; }); assert.equal(calls, 3); assert.equal(ingested, 0);
  assert.ok(tradeQuery('robinhood').includes('bid:robinhood')); assert.ok(!tradeQuery('solana', { subscription: true }).includes('mempool'));
});
test('outcome horizons use historical trades; unknown gaps do not become a hit', () => {
  const s = qualified(now), ref = { id: 'r', chain: 'ethereum' as const, token: TOKEN, at: now, snapshot: s, kind: 'shadow' as const };
  const e = normalizeTrade(fixture('bitquery-trade'), now)!;
  const path = [{ ...e, at: now + MINUTE, price: s.market!.price * 0.9 }, { ...e, at: now + HOUR, price: s.market!.price * 1.3 }];
  const samples = [{ at: now + HOUR, price: s.market!.price * 1.3, liquidity: 300000 }];
  const result = measure(ref, 1, path, samples, false); assert.equal(result.complete, true); assert.ok(Math.abs(result.returnPercent! - 30) < 1e-8); assert.equal(result.hit, true);
  assert.equal(measure(ref, 1, path, samples, true).hit, null); assert.equal(measure(ref, 6, path, samples, false).returnPercent, null);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});
