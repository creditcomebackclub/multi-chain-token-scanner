import { chartTradePlan, chartEntryAvailable } from './chart-trade-plan.js';
import { createHash } from 'node:crypto';
import { address, CHAINS, CHART_WATCHLIST_SIZE, HOUR, MINUTE, fomoAllowed, type Config } from './config.js';
import { analyze, BAR, candles, CHART_RULE, selectPairs, watchDay, type Setup } from './chart-pattern.js';
import { networks, type DiscoveryCandidate } from './providers/discovery.js';
import type { Http } from './providers/http.js';
import type { DexScreener, GoPlus } from './providers/enrichment.js';
import { chartSecurityGate, type ChartSecurityGate } from './security.js';
import type { Store } from './store.js';
import { escapeHtml, type Telegram } from './telegram.js';
const price = (n: number) => `$${n.toPrecision(5)}`;
export function renderSetup(p: DiscoveryCandidate, s: Setup, c: Config, securityGate?: ChartSecurityGate): string {
  const plan=chartTradePlan(s);
  const time=(at:number)=>new Date(at).toLocaleString('en-US',{timeZone:'America/Phoenix'});
  const warned=!!securityGate?.warnings.length;
  const acceptedRisk=warned
    ? `\n\n⚠️ <b>AGGRESSIVE RISK ACCEPTED</b>\n${securityGate.warnings.map(reason=>`• ${escapeHtml(reason)}`).join('\n')}\nThese warnings can increase rug, upgrade, and whale-dump risk; size accordingly.`
    : '';
  const headline=warned?'⚠️ <b>HIGH-RISK 5M WATCH — VERIFY BEFORE ENTRY</b>':'🔥 <b>SUPER AGGRESSIVE 5M BUY</b>';
  const rangeLabel=warned?'POTENTIAL ENTRY RANGE — not a buy instruction':'BUY only within';
  return `${headline}\n\n${escapeHtml(p.symbol)} · ${CHAINS[p.chain].name}\nFirst support-rejection candle closed: ${time(s.at)} Arizona\n\n<b>${rangeLabel}:</b> ${price(plan.entryMin)}–${price(plan.entryMax)}\nEntry window expires: ${time(plan.expiresAt)} Arizona. Skip if expired or outside the range. Check your live executable quote.\n\n<b>STOP:</b> ${price(plan.stop)} (0.5% below support floor; exit level, not an automatic order).\n<b>TP1:</b> sell 50% at +5% from YOUR actual entry, then move the stop on the remainder to your entry.\n<b>TP2:</b> sell the remaining 50% at +10%.\nReference: ${price(plan.referenceEntry)} → TP1 ${price(plan.takeProfit)} · TP2 ${price(plan.runnerTarget)}.\nRisk to stop: ${plan.riskPct.toFixed(1)}% at reference entry; ${plan.maxRiskPct.toFixed(1)}% at maximum entry, before fees/slippage.\n\n<b>Why it triggered early</b>\nClose: ${price(s.price)}\nSupport: ${price(s.lower)}–${price(s.upper)}\nEMA9: ${price(s.ema9)} · EMA21: ${price(s.ema21)} · SMA50: ${price(s.sma50)}\nGreen rejection volume: ${s.volumeRatio.toFixed(1)}× prior 20-candle average. Candle closed strongly inside/above support, price and EMA9 are rising, and EMA9 is no more than 1.5% below EMA21. SMA50 confirmation is deliberately not required.\n\n<code>${escapeHtml(p.token)}</code>\n<a href="${escapeHtml(p.url)}">5m chart</a>${fomoAllowed(p.chain,c) ? ` · <a href="https://fomo.family/tokens/${p.chain}/${encodeURIComponent(p.token)}">FOMO</a>` : ' · FOMO route unconfirmed'}${acceptedRisk}\n\nIf you enter after your own verification, arm free management alerts with:\n<code>/entered ${escapeHtml(p.token)} DOLLARS PRICE</code>\n\nSuper-aggressive signal: expect more failed reversals. No order or exit is automatic. Exact-pool liquidity passed; the security policy either passed or disclosed the accepted warnings above. Losses can exceed the stop if price gaps or liquidity disappears. Targets are gross of fees and slippage.`;
}
export function chartRefreshOrder<T extends { state?: { checkedAt: number; lastAt: number; detail: string } }>(items: T[], now: number): T[] {
  const oldest=(a:T,b:T)=>(a.state?.checkedAt??0)-(b.state?.checkedAt??0);
  // Five oldest first guarantees progress even when every pair is developing.
  const ordered=items.slice().sort(oldest), fair=ordered.slice(0,5);
  const rest=ordered.slice(5).sort((a,b)=>{
    const pending=(x:T)=>!!x.state && now-x.state.lastAt<15*MINUTE && x.state.detail.startsWith('Support touched');
    return Number(pending(b))-Number(pending(a)) || oldest(a,b);
  });
  return [...fair,...rest].slice(0,10);
}
export class ChartSetupWorker {
  private stopSignal = new AbortController();
  constructor(private c: Config, private store: Store, private http: Http, private dex: DexScreener, private security: GoPlus, private telegram?: Telegram) {}
  stop() { this.stopSignal.abort(); }
  async tick() {
    if (!this.c.chartSetupsEnabled || !this.c.ingestionEnabled || this.stopSignal.signal.aborted) return;
    const now=Date.now(), day = watchDay(now);
    const tradeableChains=this.c.chains.filter(chain=>fomoAllowed(chain,this.c));
    let pairs = (await this.store.chartWatchlist(day)).filter(p => tradeableChains.includes(p.chain));
    const newestSelection=Math.max(0,...pairs.map(p=>p.fetchedAt));
    if (pairs.length < CHART_WATCHLIST_SIZE || now-newestSelection>=15*MINUTE) {
      const existing=pairs;
      const selected = selectPairs(await this.store.setupCandidates(), tradeableChains, now);
      const states=await Promise.all(existing.map(async pair=>({pair,state:await this.store.chartState(pair.chain,pair.pool)})));
      const protectedPairs=states.filter(item=>item.state && now-item.state.checkedAt<6*HOUR && item.state.detail.startsWith('Support touched')).map(item=>item.pair);
      pairs=[];
      // Fresh candidates replace stale idle pairs first. Keep old pairs as a fallback when
      // discovery is temporarily sparse so a refresh can never empty the watchlist.
      for (const p of [...protectedPairs,...selected,...existing]) {
        if (pairs.length>=CHART_WATCHLIST_SIZE) break;
        if (!pairs.some(old=>old.chain===p.chain && old.token===p.token)) pairs.push(p);
      }
      if (pairs.length) await this.store.saveChartWatchlist(day, pairs);
    }
    const signal = AbortSignal.any([this.stopSignal.signal, AbortSignal.timeout(285_000)]);
    const withStates = await Promise.all(pairs.map(async p=>({pair:p,state:await this.store.chartState(p.chain,p.pool)})));
    const selected=chartRefreshOrder(withStates,Date.now());
    let ready = 0, failures = 0, attempted = 0;
    for (const item of selected) {
      const p=item.pair;
      if (signal.aborted) break;
      attempted++;
      const previous = item.state;
      let lastAt = previous?.lastAt ?? 0, detail = '';
      try {
        const root=this.c.coingeckoProKey ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.geckoterminal.com/api/v2';
        const url = `${root}/networks/${networks[p.chain]}/pools/${encodeURIComponent(p.pool)}/ohlcv/minute?aggregate=5&limit=500&currency=usd&token=${encodeURIComponent(p.token)}&include_empty_intervals=true`;
        const headers=this.c.coingeckoProKey ? {'x-cg-pro-api-key':this.c.coingeckoProKey} : undefined;
        const data = await this.http.json(url,{signal,headers});
        if (address(p.chain,data?.meta?.base?.address) !== p.token) throw new Error('Candle token identity mismatch');
        const bars = candles(data?.data?.attributes?.ohlcv_list, Date.now());
        const currentAt = bars.at(-1) ? bars.at(-1)!.at + BAR : 0;
        if (Date.now() - currentAt > 7.5 * MINUTE) throw new Error('Closed candles are stale');
        const result = analyze(bars);
        detail = result.detail;
        if (bars.length >= 80) ready++;
        const currentSetup = result.setups.findLast(s => s.at === currentAt), setup=currentSetup&&currentSetup.at>lastAt?currentSetup:undefined;
        const signalId=currentSetup?createHash('sha256').update(`${CHART_RULE}:${p.chain}:${p.pool}:${currentSetup.at}`).digest('hex'):undefined;
        const researchId=createHash('sha256').update(`${CHART_RULE}:research:${p.chain}:${p.pool}:${currentAt}`).digest('hex');
        if(result.latest)await this.store.saveChartResearch(researchId,p,bars.slice(-100),result.latest,currentSetup,signalId);
        lastAt = Math.max(lastAt,currentAt);
        // Bootstrap records the cursor without sending historical signals.
        await this.store.saveChartState(p.chain,p.pool,{lastAt,checkedAt:Date.now(),detail});
        if (!previous?.lastAt) detail = `Baseline recorded. ${detail}`;
        else if (setup) {
          const id = signalId!;
          await this.store.saveChartSignal(id,p,setup);
          const market = (await this.dex.batch(p.chain,[p.token])).get(p.token)?.find(m => m.pool === p.pool);
          const marketEvidence=market?{price:market.price,liquidity:market.liquidity,fdv:market.fdv,marketCap:market.marketCap,priceChange5m:market.priceChange5m,createdAt:market.createdAt,fetchedAt:market.fetchedAt,
            quoteVsReferencePct:(market.price/setup.price-1)*100,quoteLagMs:market.fetchedAt-setup.at}:null;
          const marketUsable=!!market&&Date.now()-market.fetchedAt<=60_000&&market.liquidity>=50_000,entryUsable=marketUsable&&chartEntryAvailable(setup,market,Date.now());
          const security=entryUsable?await this.security.check(p.chain,p.token,p.pool):undefined;
          const securityGate=security?chartSecurityGate(security):undefined;
          await this.store.health('dexscreener',market?'healthy':'degraded',market?'Exact setup pool quote confirmed':'Exact setup pool quote unavailable');
          if(security){const securityReasons=security.reasons??[];await this.store.health('goplus',security.raw?'healthy':'degraded',security.raw
            ?`Security API responded: ${security.status}${securityReasons.length?` — ${securityReasons.join('; ').slice(0,300)}`:''}`
            :`Security API unavailable: ${securityReasons.join('; ').slice(0,300)||security.status}`);}
          await this.store.saveChartResearchEvidence(researchId,{market:marketEvidence,security:security?{status:security.status,reasons:security.reasons??[],buyTax:security.buyTax??null,sellTax:security.sellTax??null,checkedAt:security.checkedAt??Date.now(),chartGate:securityGate}:null,
            costModel:{roundTripCostBps:this.c.researchRoundTripCostBps,source:'configurable research assumption'}});
          if(!this.telegram||!this.c.pushEnabled){await this.store.chartSignalDecision(id,'push_disabled');detail='Setup measured in shadow; BUY pushes disabled';}
          else if (!marketUsable) { detail = 'Setup withheld: current exact-pool liquidity/price unavailable or below threshold'; await this.store.chartSignalDecision(id,'market_unavailable'); }
          else if (!entryUsable) { detail = 'Buy alert withheld: entry expired or price outside entry range'; await this.store.chartSignalDecision(id,'entry_unavailable'); }
          else {
              if (!securityGate!.allowed) { detail = `Setup withheld: GoPlus ${security!.status}`; await this.store.chartSignalDecision(id,`security_${security!.status.toLowerCase()}`); }
              else if (!chartEntryAvailable(setup,market!,Date.now())) { detail = 'Buy alert withheld: entry or quote expired during security check'; await this.store.chartSignalDecision(id,'entry_expired_during_security'); }
              else if (signal.aborted) await this.store.chartSignalDecision(id,'cycle_expired');
              else if (await this.store.reserveChart(id,p,setup,this.telegram.chatKey,securityGate!.warnings)) {
                if (!await this.store.beginChartSend(id)) { await this.store.finishChartSend(id,'failed'); await this.store.chartSignalDecision(id,'paused_before_send'); detail = 'Setup withheld: alerts paused'; }
                else {
                  try { const message = await this.telegram.send(renderSetup(p,setup,this.c,securityGate)); await this.store.finishChartSend(id,'sent',message); await this.store.chartSignalDecision(id,securityGate!.warnings.length?'sent_risk_watch':'sent'); detail = securityGate!.warnings.length?'High-risk setup watch sent with security warnings':'Setup alert sent'; }
                  catch { await this.store.finishChartSend(id,'unknown'); await this.store.chartSignalDecision(id,'delivery_unknown'); detail = 'Telegram delivery uncertain; will not duplicate'; }
                }
              } else { await this.store.chartSignalDecision(id,'not_reserved'); detail = 'Setup withheld: paused, BUY cap, cooldown, or duplicate'; }
          }
        }
      } catch (error) {
        failures++;
        detail = error instanceof Error && /^(Provider HTTP \d+|Closed candles are stale|Candle token identity mismatch|Invalid candle|Missing candle array|Conflicting candles)$/.test(error.message) ? error.message : 'Candle refresh unavailable; retry next cycle';
      }
      await this.store.saveChartState(p.chain,p.pool,{lastAt,checkedAt:Date.now(),detail});
    }
    let backfilled=0;
    const backlog=!signal.aborted?await this.store.chartResearchBackfillCandidate(Date.now()):undefined;
    if(backlog&&!selected.some(item=>item.pair.chain===backlog.chain&&item.pair.pool===backlog.pool)){
      try{
        const root=this.c.coingeckoProKey?'https://pro-api.coingecko.com/api/v3/onchain':'https://api.geckoterminal.com/api/v2',headers=this.c.coingeckoProKey?{'x-cg-pro-api-key':this.c.coingeckoProKey}:undefined;
        const data=await this.http.json(`${root}/networks/${networks[backlog.chain]}/pools/${encodeURIComponent(backlog.pool)}/ohlcv/minute?aggregate=5&limit=500&currency=usd&token=${encodeURIComponent(backlog.token)}&include_empty_intervals=true`,{signal,headers});
        if(address(backlog.chain,data?.meta?.base?.address)!==backlog.token)throw new Error('Candle token identity mismatch');
        await this.store.saveChartCandles(backlog,candles(data?.data?.attributes?.ohlcv_list,Date.now()));backfilled=1;
      }catch{/* The next cycle retries the oldest incomplete pool. */}
    }
    const labeled=await this.store.updateChartResearchOutcomes(Date.now(),this.c.researchRoundTripCostBps);
    const shadowed=await this.store.updateShadowVariantOutcomes(Date.now(),this.c.researchRoundTripCostBps).catch(()=>0);
    await this.store.health('chart-setups',ready === selected.length && selected.length >= CHART_WATCHLIST_SIZE && !failures ? 'healthy' : 'degraded',
      `${pairs.length}/${CHART_WATCHLIST_SIZE} tradeable rolling pairs selected; ${ready}/${attempted} charts have fresh usable 5m candles this cycle; ${failures} refresh failures; ${labeled} research outcomes refreshed; ${shadowed} forward shadow outcomes resolved; ${backfilled} matured pool backfilled. ${this.c.coingeckoProKey?'CoinGecko paid candle route':'GeckoTerminal public candle route'}; every selected pair is checked each 5-minute cycle. /setups shows each pair.`);
  }
}
