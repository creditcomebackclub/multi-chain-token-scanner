import { watchDay } from './chart-pattern.js';
import { createHash } from 'node:crypto';
import { CHAINS, CHART_WATCHLIST_SIZE, MAX_ALERTS_PER_24H, MAX_SCOUT_ALERTS_PER_24H, MINUTE, RULE_ID, rules, fomoAllowed, type Config } from './config.js';
import type { Snapshot, WalletTrade } from './types.js';
import type { Store } from './store.js';
import { Http } from './providers/http.js';
import { median } from './outcomes.js';
import { scopeId } from './rollout.js';
import { shortlistEligible, type ShortlistEntry } from './shortlist.js';
import { walletExplorer, watchedWallets } from './wallet-watch.js';
import type { ManagedPosition } from './chart-monitor.js';
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dollars = (v: number | null) => v === null ? 'unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(v);
export function renderAlert(s: Snapshot): string {
  const p = s.market!;
  const f = s.metrics.m5;
  const fomo = `https://fomo.family/tokens/${s.chain}/${encodeURIComponent(s.token)}`;
  return `🚨 HIGH-CONVICTION CANDIDATE — SCORE ${s.score}/100\n\nTOKEN: ${escapeHtml(p.name)} (${escapeHtml(p.symbol)})\nCHAIN: ${CHAINS[s.chain].name}\nAGE: ${Math.floor((s.at - p.createdAt) / 60000)}m\nPRICE: ${dollars(p.price)}\nMARKET CAP: ${dollars(p.marketCap)}\nLIQUIDITY: ${dollars(p.liquidity)}\n5M FLOW: ${f.buys} buys / ${f.sells} sells | ${dollars(f.buyUsd)} / ${dollars(f.sellUsd)}\nUNIQUE BUYERS: ${f.buyers}\nRISK: Passed automated checks; manual FOMO preview still required\n\nCONTRACT — TAP TO COPY\n<code>${escapeHtml(s.token)}</code>\n\nWHY IT ALERTED:\n${s.why.map(w => `• ${escapeHtml(w)}`).join('\n')}\n\n<a href="${escapeHtml(fomo)}">Open in FOMO</a>\n<a href="${escapeHtml(p.chart)}">Chart</a>\n\nReview FOMO price, fees, sellability, and slippage manually before any order. An alert does not predict a winner.`;
}
export function renderShortlistAlert(entry: ShortlistEntry, c: Config): string {
  const fomo = `https://fomo.family/tokens/${entry.chain}/${encodeURIComponent(entry.token)}`;
  const age = Math.max(0, Math.floor((entry.at - entry.createdAt) / MINUTE));
  const fdvRatio = entry.dex ? entry.dex.fdv / Math.max(1, entry.dex.liquidity) : 0;
  const risk = entry.security.status === 'PASS' ? 'Automated GoPlus checks passed'
    : `GoPlus result ${entry.security.status}: ${shortHtml(entry.security.reasons.join('; ') || 'incomplete security evidence', 300)}`;
  return `🔎 <b>NEW-TOKEN WATCH — FREE MODE</b>\n\n<b>TOKEN:</b> ${shortHtml(entry.name || '?', 80)} (${shortHtml(entry.symbol || '?', 30)})\n<b>CHAIN:</b> ${CHAINS[entry.chain].name}\n<b>POOL AGE:</b> ${age}m\n<b>PRICE:</b> ${dollars(entry.dex?.priceUsd ?? entry.priceUsd)}\n<b>FDV:</b> ${dollars(entry.dex?.fdv ?? null)}\n<b>LIQUIDITY:</b> ${dollars(entry.dex?.liquidity ?? entry.liquidity)}\n<b>5M ACTIVITY:</b> ${entry.buys5m} buys / ${entry.sells5m} sells · ${dollars(entry.volume5m)} volume\n<b>RISK:</b> ${risk}\n\n<b>CONTRACT — TAP TO COPY</b>\n<code>${escapeHtml(entry.token)}</code>\n\n<b>WHY IT ALERTED:</b>\n• Pool is 10m–24h old and passes the free activity screen\n• Exact pool confirmed independently by DEX Screener\n• FDV/liquidity ratio ${fdvRatio.toFixed(1)}; 5m price change ${(entry.dex?.priceChange5m ?? 0).toFixed(1)}%\n\n${fomoAllowed(entry.chain, c) ? `<a href="${escapeHtml(fomo)}">Open in FOMO</a>\n` : ''}<a href="${escapeHtml(entry.url)}">GeckoTerminal</a> · <a href="${escapeHtml(entry.dex!.chart)}">DEX Screener</a>\n\nReview the contract, FOMO quote, fees, sellability, and slippage manually. Free-mode coverage is limited and this is not an execution signal.`;
}
const compactAmount = (value: string | null) => {
  if (value === null) return 'unknown amount';
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 }).format(number) : value.slice(0, 30);
};
export function renderWalletTrade(trade: WalletTrade, c: Config): string {
  const action = trade.side === 'buy' ? 'BOUGHT' : 'SOLD';
  const symbol = trade.tokenSymbol || `${trade.token.slice(0, 6)}…${trade.token.slice(-4)}`;
  const quote = `${compactAmount(trade.quoteAmount)} ${escapeHtml(trade.quoteSymbol)}`;
  const value = trade.quoteUsd === null ? quote : `${dollars(trade.quoteUsd)} ${escapeHtml(trade.quoteSymbol)}`;
  const tokenAmount = trade.tokenAmount ? `${compactAmount(trade.tokenAmount)} ` : '';
  const fomo = `https://fomo.family/tokens/${trade.chain}/${encodeURIComponent(trade.token)}`;
  return `👀 <b>${escapeHtml(trade.trader.toUpperCase())} ${action} — CONFIRMED ON-CHAIN</b>\n\n<b>TOKEN:</b> ${tokenAmount}${escapeHtml(symbol)}\n<b>CHAIN:</b> ${CHAINS[trade.chain].name}\n<b>${trade.side === 'buy' ? 'SPENT' : 'RECEIVED'}:</b> ${value}\n<b>WALLET:</b> <code>${escapeHtml(trade.wallet)}</code>\n\n<b>CONTRACT — TAP TO COPY</b>\n<code>${escapeHtml(trade.token)}</code>\n\n<a href="${escapeHtml(walletExplorer(trade.chain, trade.tx))}">Confirmed transaction</a>${fomoAllowed(trade.chain, c) ? ` · <a href="${escapeHtml(fomo)}">Open in FOMO</a>` : ''}${trade.chart ? ` · <a href="${escapeHtml(trade.chart)}">DEX Screener</a>` : ''}\n\nDirect wallet match with one asset sent and another received. Airdrops and one-way transfers are ignored. Token safety and execution are unverified.`;
}
const shortHtml = (text: string, budget: number) => {
  let result = '';
  for (const char of text.replace(/[\r\n\u2028\u2029]/g, ' ')) {
    const escaped = escapeHtml(char);
    if (result.length + escaped.length > budget) return `${result}…`;
    result += escaped;
  }
  return result;
};
const shortDollars = (value: number) => !Number.isFinite(value) ? 'unknown' : Math.abs(value) >= 1e12
  ? `$${value.toExponential(2)}` : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumSignificantDigits: 3 }).format(value);
const commandNumber = (value: string | undefined) => Number((value || '').replace(/[$,]/g,''));
const positionLine = (p:ManagedPosition) => `${escapeHtml(p.symbol)} · ${CHAINS[p.chain].name} · $${p.amountUsd.toFixed(2)} entered at $${p.entry.toPrecision(5)}\nTP1 $${p.tp1.toPrecision(5)} · TP2 $${p.tp2.toPrecision(5)} · ${p.stage==='tp1'?'remainder stop at entry':`stop $${p.stop.toPrecision(5)}`}\n<code>${escapeHtml(p.token)}</code>`;
export function renderShortlist(entries: ShortlistEntry[], c: Config, now = Date.now(), includeNearMisses = false): string {
  const selected = new Set<string>();
  const fresh = entries.filter(entry => {
    const shortlistPass = entry.marketPass && !!entry.dex && entry.security.status !== 'REJECT';
    if (!c.chains.includes(entry.chain) || entry.at < now - 15 * MINUTE || entry.at > now + 5000
      || !shortlistEligible(entry, now) || (includeNearMisses ? shortlistPass : !shortlistPass) || selected.has(entry.chain)) return false;
    selected.add(entry.chain); return true;
  }).slice(0, 5);
  const heading = `<b>${includeNearMisses ? 'RECENT NEW-TOKEN NEAR MISSES' : 'FREE SHORTLIST'}</b>\n10m–24h pools; known majors/stables excluded; refresh about every 5m.\n`;
  const footer = `\nExecution is unverified. Automatic SCOUT pushes are ${c.scoutPushEnabled ? `enabled with a ${MAX_SCOUT_ALERTS_PER_24H}-per-24h cap` : 'off; use /shortlist on demand'}.`;
  if (!fresh.length) return `${heading}\nNo fresh ${includeNearMisses ? 'relevant near misses' : 'market-screen matches'} right now. Use /status to check the pool feeds.${footer}`;
  // Budget the HTML itself, including links and escaped metadata, below Telegram's message limit.
  const budget = Math.floor((3950 - heading.length - footer.length) / fresh.length) - 2;
  const rows = fresh.map(entry => {
    const age = Math.max(0, Math.floor((now - entry.at) / MINUTE));
    const poolAge = Math.max(0, Math.floor((now - entry.createdAt) / MINUTE));
    const fomo = `https://fomo.family/tokens/${entry.chain}/${encodeURIComponent(entry.token)}`;
    let reasonsBudget = 110;
    const render = () => {
      const market = entry.marketPass ? 'PASS — market screen only' : `NEAR MISS — ${shortHtml(entry.reasons.join('; ') || 'Market screen not passed', reasonsBudget)}`;
      const security = `${entry.security.status} — ${shortHtml(entry.security.reasons.join('; ') || 'Automated checks only', reasonsBudget)}`;
      const dex = entry.dex ? `Confirmed · liquidity ${shortDollars(entry.dex.liquidity)} · FDV ${shortDollars(entry.dex.fdv)} · 5m ${entry.dex.priceChange5m.toFixed(1)}%` : 'Exact-pool confirmation unavailable';
      return `<b>${CHAINS[entry.chain].name} · ${shortHtml(entry.symbol || entry.name || '?', 35)}</b>\n<code>${escapeHtml(entry.token)}</code>\nAs of ${age}m ago · pool age ${poolAge}m\nLiquidity ${shortDollars(entry.liquidity)} · 5m volume ${shortDollars(entry.volume5m)}\n5m: ${entry.buys5m} buys / ${entry.sells5m} sells\nMarket: ${market}\nDEX Screener: ${dex}\nSecurity: ${security}\n<a href="${escapeHtml(entry.url)}">GeckoTerminal</a>${entry.dex ? ` · <a href="${escapeHtml(entry.dex.chart)}">DEX Screener</a>` : ''}${fomoAllowed(entry.chain, c) ? ` · <a href="${escapeHtml(fomo)}">FOMO</a>` : ' · FOMO unconfirmed'}`;
    };
    let result = render();
    while (result.length > budget && reasonsBudget > 0) { reasonsBudget = Math.max(0, reasonsBudget - 10); result = render(); }
    return result;
  });
  return `${heading}\n${rows.join('\n\n')}${footer}`;
}
export class Telegram {
  readonly chatKey: string;
  private stopped = false;
  constructor(private c: Config, private store: Store, private http = new Http(1100), private pollHttp = new Http(1000)) {
    this.chatKey = createHash('sha256').update(`${c.telegramToken}:${c.telegramChatId}`).digest('hex');
  }
  async send(text: string): Promise<number> {
    const response = await this.http.json(`https://api.telegram.org/bot${this.c.telegramToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: this.c.telegramChatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }) });
    if (response.ok !== true || !Number.isInteger(response.result?.message_id)) throw new Error('Telegram send failed or ambiguous');
    return response.result.message_id;
  }
  async alert(s: Snapshot): Promise<boolean> {
    const id = await this.store.reserve(s, { enabled: this.c.pushEnabled, tradeable: fomoAllowed(s.chain, this.c), scope: scopeId(this.c), chatKey: this.chatKey });
    if (!id) return false;
    if (!await this.store.beginSend(id)) { await this.store.finishAlert(id, 'failed'); return false; }
    try { const message = await this.send(renderAlert(s)); await this.store.finishAlert(id, 'sent', message); return true; }
    catch { await this.store.finishAlert(id, 'unknown').catch(() => undefined); return false; }
  }
  async shortlistAlert(entry: ShortlistEntry): Promise<boolean> {
    const id = await this.store.reserveShortlist(entry, { enabled: this.c.pushEnabled && this.c.scoutPushEnabled, tradeable: fomoAllowed(entry.chain, this.c), chatKey: this.chatKey });
    if (!id) return false;
    if (!await this.store.beginShortlistSend(id)) { await this.store.finishShortlistAlert(id, 'failed'); return false; }
    try { const message = await this.send(renderShortlistAlert(entry, this.c)); await this.store.finishShortlistAlert(id, 'sent', message); return true; }
    catch { await this.store.finishShortlistAlert(id, 'unknown').catch(() => undefined); return false; }
  }
  async walletTrade(trade: WalletTrade): Promise<boolean> {
    const id = await this.store.reserveWalletTrade(trade, { enabled: this.c.walletWatchEnabled, chatKey: this.chatKey });
    if (!id) return false;
    if (!await this.store.beginWalletSend(id)) { await this.store.finishWalletAlert(id, 'failed'); return false; }
    try { const message = await this.send(renderWalletTrade(trade, this.c)); await this.store.finishWalletAlert(id, 'sent', message); return true; }
    catch { await this.store.finishWalletAlert(id, 'unknown').catch(() => undefined); return false; }
  }
  async status(): Promise<string> {
    const state = await this.store.state(), health = await this.store.healthAll();
    if (this.c.scanMode === 'shortlist') {
      return `Scanner: ${!this.c.ingestionEnabled ? 'STANDBY — ' : state.paused ? 'PAUSED — ' : ''}FREE SHORTLIST\nChat validated: ${state.chat_key === this.chatKey}\nLimited new/trending pools, refreshed about every 15 minutes.\nDEX Screener exact-pool checks: on\nPaid Bitquery feeds: off\nAutomatic SCOUT pushes: ${!this.c.scoutPushEnabled ? 'off; /shortlist remains available' : state.paused ? 'paused' : `on — maximum ${MAX_SCOUT_ALERTS_PER_24H} per rolling 24h`}\nChart BUY setups: ${!this.c.chartSetupsEnabled ? 'off' : !this.c.ingestionEnabled ? 'standby' : state.paused ? 'paused; scanning continues' : !this.c.pushEnabled ? 'scanning; pushes off' : `on — ${CHART_WATCHLIST_SIZE} tradeable pairs checked every 5 minutes; /setups`}\nBUY alert cap: ${MAX_ALERTS_PER_24H}/rolling 24h, independent of SCOUT messages\nResearch capture: every watched candle, signal/control features, and 15m–24h outcomes; /research\nDelivered-alert outcome tracking: on — 1-minute DEX spot samples for 24h\nPosition management: /entered CONTRACT DOLLARS PRICE · /positions · /closed CONTRACT\nDirect wallet alerts: ${!this.c.walletWatchEnabled ? 'off' : state.paused ? 'paused' : `on — ${watchedWallets.map(wallet => wallet.name).join(' + ')}`}\nExecution is unverified; full strategy scoring and observation are not running.\n\n${this.c.chains.map(chain => `${CHAINS[chain].name}: ${fomoAllowed(chain, this.c) ? 'FOMO route configured' : 'research only; FOMO unconfirmed'}`).join('\n')}\n\n${health.filter(h => !h.provider.startsWith('bitquery:') && h.provider !== 'helius').map(h => `${h.provider}: ${h.state} — ${escapeHtml(h.detail)}`).join('\n')}`;
    }
    const approval = (await this.store.db.query('SELECT 1 FROM rollout_approvals WHERE rule_id=$1 AND scope=$2', [RULE_ID, scopeId(this.c)])).rows.length > 0;
    return `Scanner: ${!this.c.ingestionEnabled ? 'STANDBY' : state.paused ? 'PAUSED' : this.c.pushEnabled && approval ? 'PRIVATE ALERTS' : 'OBSERVE ONLY'}\nRules: ${RULE_ID}\nPush setting: ${this.c.pushEnabled}; rollout approved: ${approval}\nChat validated: ${state.chat_key === this.chatKey}\nCap: ${MAX_ALERTS_PER_24H} candidate alerts per rolling 24h${this.c.ingestionEnabled ? '' : '\nPaid Bitquery ingestion is stopped; no observation credit is accumulating.'}\n\n${this.c.chains.map(c => `${CHAINS[c].name}: ${fomoAllowed(c, this.c) ? 'FOMO route configured' : 'research only; FOMO unconfirmed'}`).join('\n')}\n\n${health.map(h => `${h.provider}: ${h.state} — ${escapeHtml(h.detail)}`).join('\n')}`;
  }
  async handle(update: any) {
    const m = update.message;
    if (!m || m.chat?.type !== 'private' || String(m.chat.id) !== this.c.telegramChatId || typeof m.text !== 'string') return;
    const args=m.text.trim().split(/\s+/), command = args[0].split('@')[0].toLowerCase();
    if (command === '/start') { await this.store.validateChat(this.chatKey); await this.send(this.c.scanMode === 'shortlist'
      ? `Private chat validated. 5M BUY alerts are ${this.c.pushEnabled ? `enabled with an independent ${MAX_ALERTS_PER_24H}-per-24h cap` : 'disabled'}. Automatic SCOUT pushes are ${this.c.scoutPushEnabled ? `enabled with a ${MAX_SCOUT_ALERTS_PER_24H}-per-24h cap` : 'off; /shortlist remains available'}. Use /setups, /stats, /research, /learn, /security, or /lastbuy. Execution remains manual.`
      : 'Private chat validated. Use /status, /pause, /resume, /recent, or /stats. Candidate pushes stay disabled until the observation and rollout gates pass.'); return; }
    if ((await this.store.state()).chat_key !== this.chatKey) { await this.send('Send /start to validate this configured private chat.'); return; }
    if (command === '/pause' || command === '/resume') {
      await this.store.pause(command === '/pause');
      await this.send(this.c.scanMode === 'shortlist'
        ? `${command === '/pause' ? 'Automatic watch alerts paused. Scanning and saved results continue.' : `Automatic watch alerts ${this.c.pushEnabled ? 'resumed' : 'remain disabled by configuration'}.`} Use /shortlist to read the latest saved results.`
        : command === '/pause' ? 'Candidate alerts paused. Observation continues.' : 'Candidate alerts resumed subject to observe-only, coverage, security, and rollout gates.');
    } else if (command === '/status') await this.send(await this.status());
    else if (command === '/entered') {
      try {
        const position=await this.store.registerChartPosition(args[1]||'',commandNumber(args[2]),commandNumber(args[3]));
        await this.send(`✅ <b>POSITION MONITOR ARMED</b>\n\n${positionLine(position)}\n\nI will check DEX Screener about once per minute and alert at TP1, TP2, the stop, or a severe liquidity drop. FOMO execution stays manual; spot samples can miss brief moves or gaps.`);
      } catch(error) { await this.send(escapeHtml(error instanceof Error?error.message:'Could not register that position.')); }
    }
    else if (command === '/positions') {
      const positions=await this.store.openChartPositions();
      await this.send(positions.length?`<b>OPEN POSITION MONITORS</b>\n\n${positions.map(positionLine).join('\n\n')}`:'No open position monitors. After entering a delivered 5M alert, use /entered CONTRACT DOLLARS PRICE.');
    }
    else if (command === '/closed') {
      await this.send(await this.store.closeChartPosition(args[1]||'')?'Position monitor closed.':'No open position monitor matches that contract.');
    }
    else if (command === '/setups') {
      const pairs = await this.store.chartWatchlist(watchDay(Date.now()));
      const lines = await Promise.all(pairs.map(async p => {
        const state = await this.store.chartState(p.chain,p.pool);
        const age = state ? Math.max(0,Math.floor((Date.now()-state.checkedAt)/MINUTE)) : null;
        return `${shortHtml(p.symbol,30)} · ${p.chain}: ${state ? `${shortHtml(state.detail,100)} (${age}m ago)` : 'awaiting candles'}`;
      }));
      await this.send(`<b>SUPER-AGGRESSIVE 5M WATCHLIST</b>\n${this.c.chartSetupsEnabled ? 'Enabled' : 'Disabled'} · ${pairs.length}/${CHART_WATCHLIST_SIZE} tradeable pairs selected\nRefreshed every 15 minutes while preserving active support setups. Every selected pair is checked each 5-minute cycle. Research-only chains do not consume slots. The first strong green rejection candle can trigger with 1.2× volume, rising EMA9 and EMA9 no more than 1.5% below EMA21; SMA50 confirmation is not required. Signal risk above 8% is rejected.\n\n${lines.join('\n') || 'Waiting for qualifying liquid pairs from public discovery.'}\n\nBUY alerts require at least $50K current exact-pool liquidity and a clean security result. Otherwise-valid setups with only holder concentration, a standard proxy, or missing holder/creator metadata are sent as HIGH-RISK WATCH alerts with a prominent warning. Sell restrictions, minting/ownership controls, high tax, malicious creators, transfer hooks, and unavailable core evidence remain blocked. The ${MAX_ALERTS_PER_24H}/24h cap is independent of SCOUT messages. /pause pauses alerts.`);
    }
    else if (command === '/lastbuy') {
      const alert=await this.store.latestChartAlert();
      if(!alert){await this.send('No delivered 5M BUY alert has been recorded yet.');return;}
      const pair=alert.data?.pair,plan=alert.data?.plan,out=alert.outcome;
      const pct=(value:number)=>Number.isFinite(value)&&Number.isFinite(plan?.referenceEntry)?`${((value/plan.referenceEntry-1)*100).toFixed(1)}%`:'n/a';
      const first=out?.firstHit==='tp1'?'TP1 first':out?.firstHit==='stop'?'stop first':'neither TP1 nor stop yet',tp2=out?.tp2At?'yes':'no';
      await this.send(`<b>LAST AGGRESSIVE BUY</b>\n${escapeHtml(pair?.symbol||'?')} · ${escapeHtml(String(alert.chain))}\nSent: ${new Date(alert.sentAt).toLocaleString('en-US',{timeZone:'America/Phoenix'})} Arizona\n\nReference entry: ${plan?.referenceEntry??'n/a'}\nBUY range: ${plan?.entryMin??'n/a'}–${plan?.entryMax??'n/a'}\nStop: ${plan?.stop??'n/a'} · TP1: ${plan?.takeProfit??'n/a'} · TP2: ${plan?.runnerTarget??'n/a'}\n\nObserved outcome: ${first}; TP2 reached: ${tp2}\nLowest sampled: ${out?.minPrice??'n/a'} (${pct(out?.minPrice)})\nHighest sampled: ${out?.maxPrice??'n/a'} (${pct(out?.maxPrice)})\nLatest sampled: ${alert.lastPrice??'n/a'} (${pct(alert.lastPrice)})\nLatest liquidity: ${alert.lastLiquidity==null?'n/a':`$${Math.round(alert.lastLiquidity).toLocaleString('en-US')}`}\n\n<code>${escapeHtml(alert.token)}</code>\n\nUses roughly one-minute DEX spot samples. Fees, slippage, fills, and intraminute extremes are excluded.`);
    }
    else if(command==='/research'){
      const r=await this.store.chartResearchStats(),f=(n:number|null)=>n===null?'n/a':`${n.toFixed(1)}%`,h=r.horizons as Record<string,{gross:number|null;net:number|null}>;
      await this.send(`<b>5M RESEARCH DATASET — 7 DAYS</b>\nObservations: ${r.observations} · controls ${r.controls} · qualifying signals ${r.signals}\nOutcome records: ${r.measured} · complete 24h paths ${r.complete}\nFirst level: TP1 ${r.tp1First} · stop ${r.stopFirst} · same-candle ambiguous ${r.ambiguous}\nComplete-path median MFE: ${f(r.medianMfe)} · median MAE: ${f(r.medianMae)}\n\nMedian gross / modeled net return:\n15m ${f(h['15m'].gross)} / ${f(h['15m'].net)}\n30m ${f(h['30m'].gross)} / ${f(h['30m'].net)}\n1h ${f(h['60m'].gross)} / ${f(h['60m'].net)}\n3h ${f(h['180m'].gross)} / ${f(h['180m'].net)}\n6h ${f(h['360m'].gross)} / ${f(h['360m'].net)}\n12h ${f(h['720m'].gross)} / ${f(h['720m'].net)}\n24h ${f(h['1440m'].gross)} / ${f(h['1440m'].net)}\n\nEntry model: next 5M candle open. Net subtracts the configured ${(this.c.researchRoundTripCostBps/100).toFixed(1)}% round-trip research assumption; it is not a FOMO quote.`);
    }
    else if(command==='/learn'){
      const r=await this.store.chartLearningStats(this.c.researchRoundTripCostBps),pct=(n:number|null)=>n===null?'n/a':`${n.toFixed(1)}%`,number=(n:number|null)=>n===null?'n/a':n.toFixed(2);
      const feature=(id:string)=>r.features.find(item=>item.id===id),line=(id:string)=>{const x=feature(id);return x?`• ${escapeHtml(x.label)}: winners ${number(x.winnerMedian)} · losses ${number(x.loserMedian)} (n=${x.winnerCount}/${x.loserCount})`:''};
      const tags=Object.entries(r.failureTags).slice(0,5).map(([tag,count])=>`• ${escapeHtml(tag)}: ${count}/${r.losses}`).join('\n')||'No resolved losses with candle evidence yet.';
      const variants=r.shadow.variants.map(v=>`• ${escapeHtml(v.label)}: ${v.resolved} closed (${v.wins}W/${v.losses}L, ${v.open} open) · net ${v.netPnlUsd>=0?'+':''}$${v.netPnlUsd.toFixed(2)} · $${v.endingBalanceUsd.toFixed(2)} balance · DD $${v.maxDrawdownUsd.toFixed(2)}`).join('\n');
      const recent=r.recentResolved.map(item=>`• ${escapeHtml(item.symbol)} ${item.result.toUpperCase()}${item.tags.length?` — ${escapeHtml(item.tags.join(', '))}`:''}`).join('\n');
      await this.send(`<b>STRATEGY LEARNING — RAW 5M SETUPS, 7 DAYS</b>\nResolved first-hit labels: ${r.resolved}/${r.total} · ${r.wins} TP1-first / ${r.losses} stop-first · ${pct(r.baselineWinRate)}\n\n<b>$50 SHADOW TRADES · $1,000 START · ${(r.shadow.costBps/100).toFixed(1)}% COST</b>\n${variants}\n\nModels 50% sold at +5%, runner at +10% or breakeven, gap-aware stops and conservative ambiguous candles. Repeated signals from the same support are suppressed in the strictest variant.\n\n<b>Winner vs loser medians</b>\n${[line('volumeRatio'),line('riskPct'),line('closePosition'),line('upperWickPct'),line('ema9SlopePct'),line('ema9ToEma21Pct')].filter(Boolean).join('\n')}\n\n<b>Loss signatures</b>\n${tags}\n\n<b>Simple confirmation screen</b>\n${r.leadingScreen?`${escapeHtml(r.leadingScreen.label)}: avoided ${r.leadingScreen.lossesAvoided} losses and missed ${r.leadingScreen.winnersMissed} winners among ${r.leadingScreen.evaluated} evaluable setups.`:'Waiting for evidence.'}\n\n<b>Recent resolved</b>\n${recent||'None yet.'}\n\nNo live rule changed. ${r.promotionReady?'Sample threshold reached; compare forward variants before promotion.':`Collecting toward at least 50 resolved setups (currently ${r.resolved}).`}`);
    }
    else if(command==='/security'){
      const raw=await this.store.chartSignalStats(),s=raw.security;
      const reasons=Object.entries(s.reasons).map(([reason,count])=>`• ${escapeHtml(reason)}: ${count}`).join('\n')||'No reason evidence recorded yet.';
      await this.send(`<b>GOPLUS SECURITY GATE — 7 DAYS</b>\nRaw setups: ${raw.detected}\nEvidence captured/backfilled: ${s.evidence} · still missing ${s.missing}\nPASS ${s.statuses.PASS} · REJECT ${s.statuses.REJECT} · UNKNOWN ${s.statuses.UNKNOWN}\n\n<b>Recorded reasons</b>\n${reasons}\n\nREJECT means GoPlus reported a concrete risk under our policy. UNKNOWN means the API omitted required evidence or was unavailable. The free API is paced below 30 calls/minute. Exact EVM pool and burn balances are excluded from holder concentration; authenticated B20 risks and exact-pool fees are enforced when GoPlus returns them.`);
    }
    else if (command === '/shortlist' || command === '/recent' && this.c.scanMode === 'shortlist') {
      await this.send(this.c.scanMode === 'shortlist'
        ? renderShortlist(await this.store.recentShortlist(), this.c, Date.now(), command === '/recent')
        : 'The scanner is using full analysis. Use /recent for its latest candidates.');
    }
    else if (command === '/recent') {
      const candidates = await this.store.recent();
      await this.send(candidates.length ? candidates.map(s => `${escapeHtml(s.market?.symbol || 'Unknown')} · ${s.chain} · ${s.score === null ? 'unscored' : `${s.score}/100`}\n<code>${s.token}</code>\n${escapeHtml(s.reasons.join('; ').slice(0, 350))}`).join('\n\n') : 'No rejected or sub-threshold candidates recorded yet.');
    } else if (command === '/stats') {
      if (this.c.scanMode === 'shortlist') {
        const stats = await this.store.shortlistAlertStats(), wallets = await this.store.walletAlertStats(), charts = await this.store.chartStats(), raw=await this.store.chartSignalStats();
        const decisions=Object.entries(raw.decisions).map(([key,value])=>`${key} ${value}`).join(' · ')||'none yet';
        await this.send(`Free-mode SCOUT messages sent in 7 days: ${stats.sent7d}; ${stats.used24h}/${MAX_SCOUT_ALERTS_PER_24H} slots used in 24h\nChart BUY alerts sent in 7 days: ${charts.sent7d}; ${charts.used24h}/${MAX_ALERTS_PER_24H} BUY slots used in 24h\n\nAll raw 5M setups in 7 days: ${raw.detected}; measured ${raw.measured}\nRaw first observed level: TP1 ${raw.tp1First} · stop ${raw.stopFirst} · neither yet ${raw.open}\nGate decisions: ${decisions}\n\nDelivered-alert outcomes: measured ${charts.measured} · TP1 first ${charts.tp1First} · stop first ${charts.stopFirst} · neither yet ${charts.open} · later TP2 ${charts.tp2}\nDirect wallet alerts: ${wallets.sent24h} in 24h; ${wallets.sent7d} in 7d\n\nResults use roughly one-minute DEX spot samples from the signal reference price. Fees, slippage, brief intraminute touches, and actual fill prices are excluded.`);
        return;
      }
      const stats = await this.store.stats(), lines = [`7-day sent alerts: ${stats.alerts}`, `Hit target: +${rules.hitTargetPercent}% with at most ${rules.hitMaxDrawdownPercent}% observed drawdown`];
      const groups = new Map<string, any[]>();
      for (const o of stats.outcomes) { const k = `${o.rule_id} · ${o.kind} · ${o.hours}h`; groups.set(k, [...(groups.get(k) || []), o.data]); }
      for (const [k, values] of groups) {
        const complete = values.filter(v => v.complete), ret = median(complete.map(v => v.returnPercent)), adverse = complete.length ? Math.min(...complete.map(v => v.maximumAdversePercent)) : null;
        lines.push(`${k}: ${complete.length}/${values.length} complete; median ${ret === null ? 'n/a' : `${ret.toFixed(1)}%`}; worst adverse ${adverse === null ? 'n/a' : `${adverse.toFixed(1)}%`}; hit rate ${complete.length ? `${(100 * complete.filter(v => v.hit).length / complete.length).toFixed(0)}%` : 'n/a'}`);
      }
      if (!groups.size) lines.push('1h / 6h / 24h outcomes: not available yet.');
      lines.push('Observed prices; fees and execution slippage excluded.');
      await this.send(escapeHtml(lines.join('\n').slice(0, 3500)));
    }
  }
  async poll() {
    while (!this.stopped) {
      try {
        const state = await this.store.state();
        const data = await this.pollHttp.json(`https://api.telegram.org/bot${this.c.telegramToken}/getUpdates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: Number(state.telegram_offset), timeout: 10, allowed_updates: ['message'] }) });
        if (data.ok !== true || !Array.isArray(data.result)) throw new Error('Telegram polling unavailable');
        for (const update of data.result) { await this.handle(update); await this.store.offset(update.update_id + 1); }
        await this.store.health('telegram', 'healthy', 'Private command polling active');
      } catch { await this.store.health('telegram', 'degraded', 'Telegram or database unavailable').catch(() => undefined); await new Promise(resolve => setTimeout(resolve, 5000)); }
    }
  }
  stop() { this.stopped = true; }
}
