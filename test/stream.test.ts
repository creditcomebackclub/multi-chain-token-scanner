import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { CHAINS, HOUR, MINUTE, type Chain } from '../src/config.js';
import { BitqueryHttp, BitqueryStream, STREAM_ROW_LIMIT, tradeQuery, type StreamHooks } from '../src/providers/bitquery.js';
import { Http } from '../src/providers/http.js';
import type { Trade } from '../src/types.js';
import { fixture, SOL } from './helpers.js';

class Socket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent: any[] = [];
  send(value: string) { this.sent.push(JSON.parse(value)); }
  ping() {}
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.from(''));
  }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function row(chain: Chain = 'ethereum') {
  const raw = fixture('bitquery-trade');
  raw.Block.Time = new Date().toISOString();
  raw.Pair.Market.NetworkBid = CHAINS[chain].bid;
  if (chain === 'solana') raw.Pair.Token.Address = SOL;
  return raw;
}
function recorder(cursor: number | null = Date.now() - MINUTE) {
  const events: Trade[] = [], health: { ok: boolean; detail: string; last?: number }[] = [], gaps: [number, number][] = [];
  const hooks: StreamHooks = {
    ingest: async batch => { events.push(...batch); },
    health: async (ok, detail, last) => { health.push({ ok, detail, last }); },
    cursor: async () => cursor,
    gap: async (from, to) => { gaps.push([from, to]); },
  };
  return { events, health, gaps, hooks };
}
async function start(chain: Chain | Chain[], api: BitqueryHttp, hooks: StreamHooks | Partial<Record<Chain, StreamHooks>>) {
  const socket = new Socket();
  const stream = new BitqueryStream(chain, 'private-test-token', api, hooks, { socket: () => socket as unknown as WebSocket });
  stream.start(); await flush(); socket.open(); socket.message({ type: 'connection_ack' }); await flush();
  return { socket, stream };
}
const message = (socket: Socket, rows: unknown[]) => socket.message({ type: 'next', id: 'trades', payload: { data: { Trading: { Trades: rows } } } });

test('one subscription dispatches all five chains through one socket, including Robinhood', async t => {
  const chains: Chain[] = ['solana', 'ethereum', 'bnb', 'robinhood', 'base'];
  const records = Object.fromEntries(chains.map(chain => [chain, recorder()])) as Record<Chain, ReturnType<typeof recorder>>;
  const api = { backfill: async () => {} } as unknown as BitqueryHttp;
  const { socket, stream } = await start(chains, api, Object.fromEntries(chains.map(chain => [chain, records[chain].hooks])));
  t.after(() => stream.stop());
  assert.equal(socket.sent.filter(item => item.type === 'subscribe').length, 1);
  const query = socket.sent.find(item => item.type === 'subscribe').payload.query;
  assert.match(query, /NetworkBid: \{ in:/);
  assert.match(query, /limit: \{ count: 10000 \}/);
  for (const chain of chains) assert.ok(query.includes(CHAINS[chain].bid));
  message(socket, chains.map(chain => row(chain))); await flush();
  for (const chain of chains) {
    assert.equal(records[chain].events.length, 1);
    assert.equal(records[chain].events[0].chain, chain);
    assert.equal(records[chain].health.at(-1)!.ok, true);
  }
});

test('live rows persist while historical backfill waits, with coverage degraded until repair completes', async t => {
  const repair = deferred(), record = recorder();
  const api = { backfill: async () => repair.promise } as unknown as BitqueryHttp;
  const { socket, stream } = await start('ethereum', api, record.hooks);
  t.after(() => { repair.resolve(); stream.stop(); });
  message(socket, [row()]); await flush();
  assert.equal(record.events.length, 1);
  assert.equal(record.health.some(h => h.ok), false);
  repair.resolve(); await flush();
  assert.equal(record.health.at(-1)!.ok, true);
});

test('cold startup uses live history with an explicit one-hour gap instead of HTTP replay or probe', async t => {
  const record = recorder(null);
  const api = { backfill: async () => assert.fail('cold startup must not backfill'), probe: async () => assert.fail('stream must not need an HTTP probe') } as unknown as BitqueryHttp;
  const before = Date.now();
  const { socket, stream } = await start('ethereum', api, record.hooks);
  t.after(() => stream.stop());
  assert.equal(record.gaps.length, 1);
  assert.equal(record.gaps[0][1] - record.gaps[0][0], HOUR);
  assert.ok(record.gaps[0][1] >= before);
  message(socket, [row()]); await flush();
  assert.equal(record.events.length, 1);
  assert.equal(record.health.at(-1)!.ok, false);
  assert.match(record.health.at(-1)!.detail, /warming up until/);
});

test('a stale cursor records the unavailable interval and repairs at most fifteen minutes', async t => {
  const cursor = Date.now() - HOUR, record = recorder(cursor);
  let requested: number[] = [];
  const api = { backfill: async (_chain: Chain, from: number, to: number) => { requested = [from, to]; } } as unknown as BitqueryHttp;
  const { stream } = await start('ethereum', api, record.hooks);
  t.after(() => stream.stop());
  assert.equal(requested[1] - requested[0], 15 * MINUTE);
  assert.deepEqual(record.gaps, [[cursor, requested[0]]]);
  assert.equal(record.health.some(h => h.ok), false);
});

test('disconnect cancels historical repair and cannot mark the closed stream healthy', async t => {
  const repair = deferred(), record = recorder();
  let signal: AbortSignal | undefined;
  const api = { backfill: async (_chain: Chain, _from: number, _to: number, _ingest: unknown, _token: unknown, input: AbortSignal) => {
    signal = input; await repair.promise;
  } } as unknown as BitqueryHttp;
  const { socket, stream } = await start('ethereum', api, record.hooks);
  t.after(() => { repair.resolve(); stream.stop(); });
  message(socket, [row()]); await flush(); socket.terminate(); await flush();
  assert.equal(signal!.aborted, true);
  repair.resolve(); await flush();
  assert.equal(record.health.some(h => h.ok), false);
  assert.match(record.health.at(-1)!.detail, /closed/);
});

test('aborting saturated HTTP backfill prevents recursive requests and stale ingestion', async () => {
  const cancellation = new AbortController();
  let calls = 0, ingested = 0;
  const api = new BitqueryHttp('private-test-token', new Http(0, async () => {
    calls++; cancellation.abort();
    return new Response(JSON.stringify({ data: { Trading: { Trades: Array(1000).fill(row()) } } }));
  }));
  await assert.rejects(() => api.backfill('ethereum', Date.now() - MINUTE, Date.now(), async events => { ingested += events.length; }, undefined, cancellation.signal));
  assert.equal(calls, 1);
  assert.equal(ingested, 0);
});

test('a saturated live frame records gaps for omitted chains and keeps subsequent coverage degraded', async t => {
  const ethereum = recorder(), robinhood = recorder();
  const api = { backfill: async () => {} } as unknown as BitqueryHttp;
  const { socket, stream } = await start(['ethereum', 'robinhood'], api, { ethereum: ethereum.hooks, robinhood: robinhood.hooks });
  t.after(() => stream.stop());
  message(socket, Array(STREAM_ROW_LIMIT).fill(row())); await flush();
  assert.equal(ethereum.events.length, STREAM_ROW_LIMIT);
  assert.equal(ethereum.gaps.length, 1);
  assert.equal(robinhood.gaps.length, 1);
  message(socket, [row(), row('robinhood')]); await flush();
  assert.equal(ethereum.health.at(-1)!.ok, false);
  assert.equal(robinhood.health.at(-1)!.ok, false);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test('websocket provider errors remain useful without exposing credentials', async t => {
  const record = recorder();
  const api = { backfill: async () => {} } as unknown as BitqueryHttp;
  const { socket, stream } = await start('ethereum', api, record.hooks);
  t.after(() => stream.stop());
  const fakeToken = ['ory', 'at', 'another.secret'].join('_');
  socket.message({ type: 'error', payload: [{ message: `Plan limit hit for private-test-token and ${fakeToken}` }] });
  await flush();
  const detail = record.health.at(-1)!.detail;
  assert.match(detail, /Plan limit hit/);
  assert.equal(detail.includes('private-test-token'), false);
  assert.equal(detail.includes('ory_at_'), false);
  assert.equal(record.health.at(-1)!.ok, false);
});

test('GraphQL HTTP errors expose the cause while redacting the saved token', async () => {
  const api = new BitqueryHttp('private-test-token', new Http(0, async () => new Response(JSON.stringify({ errors: [{ message: 'Access denied private-test-token' }] }))));
  await assert.rejects(() => api.rows(tradeQuery('robinhood')), error => {
    assert.match((error as Error).message, /Access denied/);
    assert.equal((error as Error).message.includes('private-test-token'), false);
    return true;
  });
});
