import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { address, CHAINS, HOUR, MINUTE, type Chain } from '../config.js';
import type { Trade } from '../types.js';
import { Http } from './http.js';
const amount = z.union([z.string(), z.number()]).transform(v => new Decimal(v).toFixed()).refine(v => new Decimal(v).isPositive());
const rowSchema = z.object({
  Side: z.enum(['Buy', 'Sell']), Block: z.object({ Time: z.string() }),
  Trader: z.object({ Address: z.string().min(1) }), TransactionHeader: z.object({ Hash: z.string().min(1) }),
  Amounts: z.object({ Base: amount }), AmountsInUsd: z.object({ Quote: amount }),
  Pair: z.object({
    Token: z.object({ Address: z.string(), IsNative: z.boolean().optional() }),
    QuoteToken: z.object({ Address: z.string() }), Pool: z.object({ Address: z.string().min(1) }),
    Market: z.object({ NetworkBid: z.string(), ProtocolFamily: z.string() }),
  }),
});
export function normalizeTrade(raw: unknown, now = Date.now()): Trade | null {
  try {
    const r = rowSchema.parse(raw);
    const chain = (Object.keys(CHAINS) as Chain[]).find(c => CHAINS[c].bid === r.Pair.Market.NetworkBid);
    if (!chain || r.Pair.Token.IsNative) return null;
    // Trading also includes NFT/prediction-market rows. Explicitly recognize DEX families.
    if (!/^(pump|raydium|meteora|orca|uniswap|pancake|aerodrome|sushiswap|curve|balancer|jupiter|dodo|bancor|traderjoe|quickswap|camelot|flap|fourmeme|pons)/i.test(r.Pair.Market.ProtocolFamily)) return null;
    const token = address(chain, r.Pair.Token.Address), quote = r.Pair.QuoteToken.Address;
    const at = Date.parse(r.Block.Time);
    if (!Number.isFinite(at) || at > now + 5000 || at <= 0) return null;
    const tx = chain === 'solana' ? r.TransactionHeader.Hash : r.TransactionHeader.Hash.toLowerCase();
    const trader = chain === 'solana' ? r.Trader.Address : r.Trader.Address.toLowerCase();
    const pool = chain === 'solana' ? r.Pair.Pool.Address : r.Pair.Pool.Address.toLowerCase();
    const side = r.Side === 'Buy' ? 'buy' : 'sell';
    const usd = Number(r.AmountsInUsd.Quote), price = new Decimal(r.AmountsInUsd.Quote).div(r.Amounts.Base).toNumber();
    if (!Number.isFinite(usd) || !Number.isFinite(price) || price <= 0) return null;
    const id = createHash('sha256').update(JSON.stringify([chain, token, tx, trader, side, r.Amounts.Base])).digest('hex');
    return { id, chain, token, quote, pool, trader, tx, side, baseAmount: r.Amounts.Base, usd, price, at, source: 'bitquery', confirmed: true };
  } catch { return null; }
}
const fields = `Side Block { Time } Trader { Address } TransactionHeader { Hash }
  Amounts { Base } AmountsInUsd { Quote }
  Pair { Token { Address IsNative } QuoteToken { Address } Pool { Address }
    Market { NetworkBid ProtocolFamily } }`;
export const STREAM_ROW_LIMIT = 10_000;
export function tradeQuery(chain: Chain | Chain[], options: { from?: number; to?: number; limit?: number; token?: string; subscription?: boolean; latest?: boolean } = {}) {
  const chains = Array.isArray(chain) ? chain : [chain];
  if (!chains.length) throw new Error('At least one chain is required');
  if (options.token && chains.length !== 1) throw new Error('Token queries require one chain');
  const time = options.from === undefined ? '' : `Block: { Time: { since: ${JSON.stringify(new Date(options.from).toISOString())} ${options.to === undefined ? '' : `till: ${JSON.stringify(new Date(options.to).toISOString())}`} } }`;
  const token = options.token ? `Token: { Address: { is: ${JSON.stringify(address(chains[0], options.token))} } }` : '';
  const network = chains.length === 1 ? `is: ${JSON.stringify(CHAINS[chains[0]].bid)}` : `in: ${JSON.stringify(chains.map(c => CHAINS[c].bid))}`;
  const query = `${options.subscription ? 'subscription' : 'query'} { Trading { Trades(
    where: { Pair: { Market: { NetworkBid: { ${network} } } ${token} } ${time} }
    ${options.subscription ? `limit: { count: ${STREAM_ROW_LIMIT} }` : `limit: { count: ${options.limit ?? 1000} } orderBy: { ${options.latest ? 'descending' : 'ascending'}: Block_Time }`}
  ) { ${fields} } } }`;
  return query;
}
export class BitqueryHttp {
  constructor(private token: string, private http = new Http(10_000, fetch, { rateLimitRetries: 2 })) {}
  async rows(query: string, signal?: AbortSignal): Promise<unknown[]> {
    signal?.throwIfAborted();
    const data = await this.http.json('https://streaming.bitquery.io/graphql', { method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal });
    signal?.throwIfAborted();
    if (data.errors?.length) throw new Error(`Bitquery GraphQL: ${providerError(data.errors, this.token)}`);
    if (!Array.isArray(data.data?.Trading?.Trades)) throw new Error('Bitquery response missing Trading.Trades');
    return data.data.Trading.Trades;
  }
  async probe(chain: Chain, now = Date.now()): Promise<Trade[]> {
    const rows = await this.rows(tradeQuery(chain, { from: now - 2 * MINUTE, to: now, limit: 100, latest: true }));
    const events = rows.map(r => normalizeTrade(r, now)).filter((e): e is Trade => !!e && e.chain === chain && e.at >= now - 2 * MINUTE && e.at <= now);
    if (!events.length) throw new Error('No current confirmed DEX trades');
    return events;
  }
  async backfill(chain: Chain, from: number, to: number, ingest: (trades: Trade[]) => Promise<void>, token?: string, signal?: AbortSignal): Promise<void> {
    let requests = 0;
    const range = async (start: number, end: number): Promise<void> => {
      signal?.throwIfAborted();
      if (++requests > 2000) throw new Error('Backfill request budget exhausted');
      const rows = await this.rows(tradeQuery(chain, { from: start, to: end, token }), signal);
      signal?.throwIfAborted();
      if (rows.length >= 1000) {
        if (end - start <= 1000) throw new Error('Backfill saturated within one second; coverage incomplete');
        const midpoint = Math.floor((start + end) / 2);
        await range(start, midpoint); await range(midpoint, end); return;
      }
      const events = rows.map(r => normalizeTrade(r)).filter((e): e is Trade => !!e && e.chain === chain && e.at >= start && e.at <= end);
      await ingest(events);
    };
    await range(from, to);
  }
}
export interface StreamHooks {
  ingest: (trades: Trade[]) => Promise<void>;
  health: (healthy: boolean, detail: string, lastEvent?: number) => Promise<void>;
  cursor: () => Promise<number | null>;
  gap: (from: number, to: number) => Promise<void>;
}
function providerError(error: unknown, token: string): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  return String(text).replaceAll(token, '[redacted]').replace(/ory_at_[A-Za-z0-9_.-]+/g, '[redacted]').replace(/[\r\n\u2028\u2029]/g, ' ').slice(0, 350);
}
type ChainHooks = Partial<Record<Chain, StreamHooks>>;
export interface StreamOptions { socket?: (url: string, protocol: string) => WebSocket }
export class BitqueryStream {
  private stopped = false; private ws?: WebSocket; private retry?: NodeJS.Timeout; private cancellation?: AbortController;
  private attempts = 0; private epoch = 0;
  private readonly chains: Chain[];
  private readonly hooks: ChainHooks;
  constructor(chain: Chain | Chain[], private token: string, private api: BitqueryHttp, hooks: StreamHooks | ChainHooks, private options: StreamOptions = {}) {
    this.chains = [...new Set(Array.isArray(chain) ? chain : [chain])];
    if (!this.chains.length) throw new Error('At least one chain is required');
    this.hooks = 'ingest' in hooks ? { [this.chains[0]]: hooks } : hooks;
    if (this.chains.some(c => !this.hooks[c])) throw new Error('Each stream chain requires hooks');
  }
  start() { void this.connect(); }
  stop() { this.stopped = true; this.epoch++; clearTimeout(this.retry); this.cancellation?.abort(); this.ws?.terminate(); }
  private async allHealth(detail: string) {
    await Promise.all(this.chains.map(c => this.hooks[c]!.health(false, detail).catch(() => undefined)));
  }
  private async connect() {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    try {
      await this.allHealth('Connecting confirmed live stream');
      if (this.stopped || this.epoch !== epoch) return;
      await this.session(epoch);
    } catch (error) {
      if (!this.stopped) await this.allHealth(`Bitquery stream: ${providerError(error, this.token)}`);
    }
    if (!this.stopped) this.retry = setTimeout(() => void this.connect(), Math.min(60_000, 5000 * 2 ** Math.min(this.attempts++, 4)) + Math.random() * 1000);
  }
  private session(epoch: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const createSocket = this.options.socket ?? ((url, protocol) => new WebSocket(url, protocol));
      const ws = this.ws = createSocket(`wss://streaming.bitquery.io/graphql?token=${encodeURIComponent(this.token)}`, 'graphql-transport-ws');
      const cancellation = this.cancellation = new AbortController();
      let queue = Promise.resolve(), queued = 0, queuedRows = 0, pong = true, ack = false, failed = '';
      const began = Date.now(), states = new Map(this.chains.map(c => [c, { ready: false, lastEvent: 0, incompleteUntil: 0 }]));
      const active = () => !this.stopped && this.epoch === epoch && ws.readyState === WebSocket.OPEN && !cancellation.signal.aborted;
      const fail = (error: unknown) => { if (!failed) failed = providerError(error, this.token); cancellation.abort(); ws.terminate(); };
      const health = async (chain: Chain) => {
        if (!active()) return;
        const state = states.get(chain)!;
        if (!state.ready) return;
        const fresh = state.lastEvent > Date.now() - 2 * MINUTE;
        const warming = state.incompleteUntil > Date.now();
        await this.hooks[chain]!.health(fresh && !warming, warming
          ? `Confirmed live stream; coverage warming up until ${new Date(state.incompleteUntil).toISOString()}`
          : fresh ? 'Confirmed stream healthy; backfill complete' : 'Stream connected; awaiting recent confirmed DEX trades', state.lastEvent || undefined);
        if (fresh) this.attempts = 0;
      };
      const heartbeat = setInterval(() => {
        if (!pong || (!ack && Date.now() - began > 30_000)) return fail('WebSocket heartbeat or handshake timeout');
        pong = false;
        if (ws.readyState === WebSocket.OPEN) { ws.ping(); ws.send(JSON.stringify({ type: 'ping' })); }
        for (const chain of this.chains) void health(chain).catch(fail);
      }, 30_000);
      ws.on('pong', () => { pong = true; });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('message', raw => {
        let m: any; try { m = JSON.parse(raw.toString()); } catch { fail('Invalid WebSocket JSON'); return; }
        if (m.type === 'pong') { pong = true; return; }
        if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        if (m.type === 'error' || m.type === 'connection_error') { fail(m.payload ?? m); return; }
        if (m.type === 'complete') { fail('Subscription completed unexpectedly'); return; }
        if (m.type === 'connection_ack' && !ack) {
          ack = true;
          ws.send(JSON.stringify({ id: 'trades', type: 'subscribe', payload: { query: tradeQuery(this.chains, { subscription: true }) } }));
          for (const chain of this.chains) {
            // Historical repair runs independently: live rows reach the database while HTTP waits for its account budget.
            void (async () => {
              const hooks = this.hooks[chain]!, state = states.get(chain)!;
              const end = Date.now(), cursor = await hooks.cursor();
              if (!active()) return;
              if (cursor === null) {
                // A fresh scanner builds one clean hour from live data instead of downloading a full-chain firehose.
                state.incompleteUntil = end + HOUR;
                await hooks.gap(end - HOUR, end);
              } else {
                const start = Math.max(end - 15 * MINUTE, cursor - 5000);
                if (start > cursor + 5000) {
                  state.incompleteUntil = start + HOUR;
                  await hooks.gap(cursor, start);
                }
                await hooks.health(false, 'Live stream collecting; repairing disconnected coverage');
                await this.api.backfill(chain, start, end, async events => { if (active()) await hooks.ingest(events); }, undefined, cancellation.signal);
              }
              if (!active()) return;
              state.ready = true;
              await health(chain);
            })().catch(error => { if (active()) fail(`Backfill ${chain}: ${providerError(error, this.token)}`); });
          }
        } else if (m.type === 'next') {
          if (m.payload?.errors?.length) { fail(m.payload.errors); return; }
          if (!ack || !Array.isArray(m.payload?.data?.Trading?.Trades)) { fail('WebSocket response missing Trading.Trades'); return; }
          const rows = m.payload.data.Trading.Trades as unknown[];
          if (++queued > 500 || (queuedRows += rows.length) > 100_000) { fail('Live ingestion queue exceeded its memory budget; coverage repair required'); return; }
          queue = queue.then(async () => {
            if (!active()) return;
            const now = Date.now();
            if (rows.length >= STREAM_ROW_LIMIT) {
              // A full provider batch may be truncated. Record a gap for every selected chain, including omitted chains.
              for (const chain of this.chains) {
                const state = states.get(chain)!;
                state.incompleteUntil = now + HOUR;
                await this.hooks[chain]!.gap(state.lastEvent || began, now);
                await this.hooks[chain]!.health(false, 'Subscription batch saturated; one-hour coverage gap recorded');
              }
            }
            const events = rows.map(r => normalizeTrade(r, now)).filter((e): e is Trade => !!e && this.chains.includes(e.chain));
            for (const chain of this.chains) {
              if (!active()) return;
              const batch = events.filter(e => e.chain === chain), state = states.get(chain)!;
              if (!batch.length) continue;
              await this.hooks[chain]!.ingest(batch);
              state.lastEvent = batch.reduce((at, e) => Math.max(at, e.at), state.lastEvent);
              await health(chain);
            }
          }).catch(fail).finally(() => { queued--; queuedRows -= rows.length; });
        }
      });
      ws.on('error', error => fail(error));
      ws.on('close', (code, reason) => {
        clearInterval(heartbeat); cancellation.abort();
        if (this.epoch === epoch) this.epoch++;
        const detail = failed || `WebSocket closed (${code}): ${providerError(reason.toString() || 'no reason supplied', this.token)}`;
        // Invalidate coverage immediately and cancel historical requests before allowing another session.
        void this.allHealth(detail);
        void queue.then(() => this.stopped ? resolve() : reject(new Error(detail)));
      });
      if (this.stopped) { clearInterval(heartbeat); cancellation.abort(); ws.terminate(); resolve(); }
    });
  }
}
