import type { Chain } from './config.js';
import type { Market } from './types.js';
import type { DexScreener } from './providers/enrichment.js';
import type { Store } from './store.js';
import { CHAINS, HOUR } from './config.js';
import { escapeHtml, type Telegram } from './telegram.js';

export interface AlertOutcome {
  startedAt: number; lastAt: number; entry: number; stop: number; tp1: number; tp2: number;
  minPrice: number; maxPrice: number; firstHit: 'stop' | 'tp1' | null;
  stopAt: number | null; tp1At: number | null; tp2At: number | null; complete: boolean;
}
export interface ManagedPosition {
  id: string; alertId: string; chain: Chain; token: string; pool: string; symbol: string;
  amountUsd: number; entry: number; stop: number; tp1: number; tp2: number;
  initialLiquidity: number; openedAt: number; stage: 'open' | 'tp1'; status: 'open' | 'closed';
}
export type PositionEvent = 'liquidity' | 'stop' | 'tp1' | 'tp2' | 'breakeven';

export function advanceOutcome(old: AlertOutcome | undefined, levels: {entry:number;stop:number;tp1:number;tp2:number}, price: number, at: number): AlertOutcome {
  if (![price,at,levels.entry,levels.stop,levels.tp1,levels.tp2].every(Number.isFinite) || price <= 0 || levels.stop >= levels.entry || levels.tp1 <= levels.entry || levels.tp2 <= levels.tp1) throw new Error('Invalid chart outcome sample');
  const out: AlertOutcome = old ? structuredClone(old) : { startedAt: at, lastAt: at, ...levels, minPrice: levels.entry, maxPrice: levels.entry, firstHit: null, stopAt: null, tp1At: null, tp2At: null, complete: false };
  out.lastAt = Math.max(out.lastAt, at); out.minPrice = Math.min(out.minPrice, price); out.maxPrice = Math.max(out.maxPrice, price);
  if (!out.firstHit && price <= out.stop) { out.firstHit = 'stop'; out.stopAt = at; }
  if (!out.firstHit && price >= out.tp1) { out.firstHit = 'tp1'; out.tp1At = at; }
  if (!out.tp1At && price >= out.tp1) out.tp1At = at;
  if (!out.tp2At && price >= out.tp2) out.tp2At = at;
  out.complete = at - out.startedAt >= 24 * HOUR;
  return out;
}

export function positionEvent(position: ManagedPosition, market: Pick<Market,'price'|'liquidity'>): PositionEvent | null {
  if (position.stage === 'open' && market.price <= position.stop) return 'stop';
  if (market.price >= position.tp2) return 'tp2';
  if (position.stage === 'open' && market.price >= position.tp1) return 'tp1';
  if (position.stage === 'tp1' && market.price <= position.entry) return 'breakeven';
  if (market.liquidity < Math.max(10_000, position.initialLiquidity * .5)) return 'liquidity';
  return null;
}
const money = (n:number) => `$${n.toPrecision(5)}`;
export function renderPositionEvent(p: ManagedPosition, event: PositionEvent, market: Pick<Market,'price'|'liquidity'>): string {
  const gain = (market.price / p.entry - 1) * 100;
  const action = event === 'tp1' ? '<b>TP1 HIT — SELL 50% NOW</b>\nThen move the stop on the remainder to your actual entry.'
    : event === 'tp2' ? p.stage==='open'?'<b>TP2 REACHED — TAKE PROFIT NOW</b>\nThe one-minute sample skipped past TP1; manage the full position now.':'<b>TP2 HIT — SELL THE REMAINDER</b>'
    : event === 'stop' ? '<b>STOP HIT — EXIT THE POSITION</b>'
    : event === 'breakeven' ? '<b>BREAKEVEN STOP HIT — EXIT THE REMAINDER</b>'
    : '<b>LIQUIDITY WARNING — CHECK SELLABILITY NOW</b>\nExact-pool liquidity fell by at least 50% or below $10K.';
  return `⚡ ${action}\n\n${escapeHtml(p.symbol)} · ${CHAINS[p.chain].name}\nCurrent observed price: ${money(market.price)} (${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% from your entered price)\nObserved liquidity: $${Math.round(market.liquidity).toLocaleString('en-US')}\n\n<code>${escapeHtml(p.token)}</code>\n\nThis is a monitoring alert from DEX Screener spot samples. It cannot sell for you; verify the live FOMO quote and slippage before acting.`;
}

export class ChartMonitor {
  private stopped = false;
  constructor(private store: Store, private dex: DexScreener, private telegram?: Telegram) {}
  stop() { this.stopped = true; }
  async tick(now = Date.now()) {
    if (this.stopped) return;
    const alerts = await this.store.chartAlertsForTracking(now), signals=await this.store.chartSignalsForTracking(now), positions = await this.store.openChartPositions();
    const keys = new Map<string,{chain:Chain;token:string}>();
    for (const item of [...alerts,...signals,...positions]) keys.set(`${item.chain}:${item.token}`,{chain:item.chain,token:item.token});
    let sampled=0, missing=0, notices=0;
    for (const chain of [...new Set([...keys.values()].map(k=>k.chain))]) {
      const tokens=[...keys.values()].filter(k=>k.chain===chain).map(k=>k.token);
      let markets: Map<string,Market[]>;
      try { markets=await this.dex.batch(chain,tokens,now); } catch { missing += tokens.length; continue; }
      for (const alert of alerts.filter(a=>a.chain===chain)) {
        const market=markets.get(alert.token)?.find(m=>m.pool===alert.pool);
        if (!market) { missing++; continue; }
        try {
          const levels={entry:alert.data.plan.referenceEntry,stop:alert.data.plan.stop,tp1:alert.data.plan.takeProfit,tp2:alert.data.plan.runnerTarget};
          const initial=alert.outcome??advanceOutcome(undefined,levels,levels.entry,alert.sentAt);
          const outcome=advanceOutcome(initial,levels,market.price,now);
          await this.store.recordChartAlertSample(alert.id,now,market.price,market.liquidity,outcome); sampled++;
        } catch { missing++; }
      }
      for(const signal of signals.filter(item=>item.chain===chain)){
        const market=markets.get(signal.token)?.find(m=>m.pool===signal.pool);
        if(!market){missing++;continue;}
        try{
          const levels={entry:signal.data.plan.referenceEntry,stop:signal.data.plan.stop,tp1:signal.data.plan.takeProfit,tp2:signal.data.plan.runnerTarget};
          const initial=signal.outcome??advanceOutcome(undefined,levels,levels.entry,signal.at);
          const outcome=advanceOutcome(initial,levels,market.price,now);
          await this.store.recordChartSignalSample(signal.id,now,market.price,market.liquidity,outcome);sampled++;
        }catch{missing++;}
      }
      for (const position of positions.filter(p=>p.chain===chain)) {
        const market=markets.get(position.token)?.find(m=>m.pool===position.pool);
        if (!market) { missing++; continue; }
        const event=positionEvent(position,market); if (!event || !this.telegram) continue;
        if (!await this.store.reserveChartPositionEvent(position,event,{price:market.price,liquidity:market.liquidity,at:now},this.telegram.chatKey)) continue;
        try { const message=await this.telegram.send(renderPositionEvent(position,event,market)); await this.store.finishChartPositionEvent(position.id,event,'sent',message); notices++; }
        catch { await this.store.finishChartPositionEvent(position.id,event,'unknown'); }
      }
    }
    await this.store.health('chart-monitor', missing ? 'degraded' : 'healthy', `${sampled} alert/signal samples saved; ${positions.length} open positions checked; ${notices} management alerts sent; ${missing} exact pools unavailable`);
  }
}
