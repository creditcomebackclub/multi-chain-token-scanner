import WebSocket from 'ws';
import { address } from '../config.js';
import type { Discovery } from '../types.js';
import { object } from '../security.js';
// Raw balance deltas are discovery hints, never fabricated USD swaps. Bitquery owns priced flow.
export function heliusDiscoveries(payload: unknown, now = Date.now()): Discovery[] {
  const m = object(payload), r = object(m.params?.result), tx = object(r.transaction);
  if (m.method !== 'transactionNotification' || tx.meta?.err !== null || typeof r.signature !== 'string') return [];
  const tokens = new Set<string>();
  if (!Array.isArray(tx.meta.preTokenBalances) || !Array.isArray(tx.meta.postTokenBalances)) return [];
  for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
    try { tokens.add(address('solana', b.mint)); } catch { /* malformed balance */ }
  }
  return [...tokens].map(token => ({ chain: 'solana', token, tx: r.signature, at: now, source: 'helius' }));
}
export class Helius {
  private stopped = false; private ws?: WebSocket; private retry?: NodeJS.Timeout; private attempts = 0;
  constructor(private key: string, private programs: string[], private ingest: (events: Discovery[]) => Promise<void>, private health: (ok: boolean, detail: string) => Promise<void>, private backfill: () => Promise<void>) {}
  start() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.key)}`);
    let alive = true, subscribed = false, queue = Promise.resolve(), queued = 0;
    const timer = setInterval(() => { if (!alive || !subscribed) return ws.terminate(); alive = false; if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
    ws.on('pong', () => { alive = true; });
    ws.on('open', () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'transactionSubscribe', params: [{ failed: false, vote: false, accountInclude: this.programs }, { commitment: 'confirmed', encoding: 'jsonParsed', transactionDetails: 'full', maxSupportedTransactionVersion: 0 }] })));
    ws.on('message', raw => {
      let m: any; try { m = JSON.parse(raw.toString()); } catch { ws.terminate(); return; }
      if (m.error) { ws.terminate(); return; }
      if (m.id === 1 && m.result !== undefined) {
        subscribed = true; this.attempts = 0;
        queue = queue.then(async () => { await this.backfill(); await this.health(true, 'Confirmed discovery hints active; priced flow uses Bitquery'); }).catch(() => ws.terminate());
      }
      const events = heliusDiscoveries(m);
      if (++queued > 200) { ws.terminate(); return; }
      queue = queue.then(() => this.ingest(events)).catch(() => ws.terminate()).finally(() => { queued--; });
    });
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearInterval(timer);
      void this.health(false, 'Helius unavailable; Bitquery fallback active').catch(() => undefined);
      if (!this.stopped) this.retry = setTimeout(() => this.start(), Math.min(60_000, 1000 * 2 ** Math.min(this.attempts++, 6)) + Math.random() * 1000);
    });
  }
  stop() { this.stopped = true; clearTimeout(this.retry); this.ws?.terminate(); }
}
