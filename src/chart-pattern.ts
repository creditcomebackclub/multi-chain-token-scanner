import { CHART_WATCHLIST_SIZE, MINUTE, HOUR, DAY, type Chain } from './config.js';
import { excludedSymbols } from './shortlist.js';
import type { DiscoveryCandidate } from './providers/discovery.js';
export const BAR = 5 * MINUTE;
export const CHART_RULE = 'support-rejection-super-v3';
export type Candle = { at: number; open: number; high: number; low: number; close: number; volume: number };
export type ResearchFeatures = {
  at:number; open:number; high:number; low:number; close:number; volume:number; meanVolume20:number; volumeRatio:number;
  bodyPct:number; upperWickPct:number; lowerWickPct:number; closePosition:number; atr14:number; atrPct:number;
  ema9:number; ema21:number; sma50:number; ema9SlopePct:number; ema21SlopePct:number;
  priceToEma9Pct:number; ema9ToEma21Pct:number; priceToSma50Pct:number; priorPeakDrawdownPct:number;
  supportArmed:boolean; supportAnchor:number|null; supportLower:number|null; supportUpper:number|null;
  supportTestCount:number; supportTouchAgeBars:number|null; closesBelowSupport:number; riskPct:number|null;
  conditions:{green:boolean;closeInZone:boolean;volume:boolean;strongClose:boolean;aboveEma9:boolean;ema9Rising:boolean;emaAlignment:boolean;risk:boolean};
};
export type Setup = { at: number; anchor: number; lower: number; upper: number; price: number;
  ema9: number; ema21: number; sma50: number; volumeRatio: number; features?:ResearchFeatures };
export function candles(rows: unknown, now: number): Candle[] {
  if (!Array.isArray(rows)) throw new Error('Missing candle array');
  const unique = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 6 || !row.every(Number.isFinite)) throw new Error('Invalid candle');
    const [seconds, open, high, low, close, volume] = row as number[];
    const at = seconds * 1000;
    if (at % BAR || at <= 0 || Math.min(open, high, low, close) <= 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low || volume < 0) throw new Error('Invalid candle');
    if (at + BAR > now) continue;
    const value = { at, open, high, low, close, volume };
    if (unique.has(at) && JSON.stringify(unique.get(at)) !== JSON.stringify(value)) throw new Error('Conflicting candles');
    unique.set(at, value);
  }
  const sorted = [...unique.values()].sort((a, b) => a.at - b.at);
  // Only use the contiguous tail. Missing bars are not invented or treated as zero volume.
  let start = sorted.length - 1;
  while (start > 0 && sorted[start].at - sorted[start - 1].at === BAR) start--;
  return sorted.slice(Math.max(0, start));
}
const majors = new Set(['BTC','WBTC','CBBTC','ETH','WETH','SOL','WSOL','BNB','WBNB','USDC','USDT','USDG','DAI','USDE','USDS','FDUSD','TUSD','BUSD','PYUSD','FRAX','USD1','EURC','WSTETH','STETH']);
export function selectPairs(all: DiscoveryCandidate[], chains: Chain[], now: number): DiscoveryCandidate[] {
  const eligible = all.filter(p => chains.includes(p.chain) && now - p.fetchedAt <= 30 * MINUTE && p.fetchedAt <= now + 5000
    && now - p.createdAt >= 4 * HOUR && p.liquidity >= 50_000 && (p.volume24h ?? 0) >= 100_000
    && !majors.has(p.symbol.toUpperCase()) && !excludedSymbols.has(p.symbol.toUpperCase().replace(/[^A-Z0-9]/g,'')) && !/stablecoin|wrapped (ether|bitcoin|solana)/i.test(p.name))
    .sort((a, b) => (b.volume5m / Math.max(1,b.liquidity)) - (a.volume5m / Math.max(1,a.liquidity))
      || b.volume5m-a.volume5m || (b.volume24h ?? 0) - (a.volume24h ?? 0));
  const result: DiscoveryCandidate[] = [], seen = new Set<string>();
  const buckets = chains.map(chain => eligible.filter(p => p.chain === chain));
  while (result.length < CHART_WATCHLIST_SIZE && buckets.some(b => b.length)) for (const bucket of buckets) {
    let p: DiscoveryCandidate | undefined;
    while ((p = bucket.shift()) && seen.has(`${p.chain}:${p.token}`)) { /* one pool per token */ }
    if (p && result.length < CHART_WATCHLIST_SIZE) { seen.add(`${p.chain}:${p.token}`); result.push(p); }
  }
  return result;
}
export const watchDay = (now: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function analyze(bars: Candle[]): { setups: Setup[]; detail: string; latest:ResearchFeatures|null } {
  if (bars.length < 80) return { setups: [], detail: `Warming up: ${bars.length}/80 consecutive closed candles`, latest:null };
  const ema9: number[] = [], ema21: number[] = [], sma50: number[] = [], setups: Setup[] = [];
  let arm: { anchor: number; lower: number; upper: number; touched: number; below: number; tests:number } | undefined;
  let latest:ResearchFeatures|null=null;
  let detail = 'Waiting for support touch and reclaim';
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    ema9[i] = i ? b.close * (2 / 10) + ema9[i - 1] * (8 / 10) : b.close;
    ema21[i] = i ? b.close * (2 / 22) + ema21[i - 1] * (20 / 22) : b.close;
    sma50[i] = i >= 49 ? bars.slice(i - 49, i + 1).reduce((s, c) => s + c.close, 0) / 50 : NaN;
    if (i < 79) continue;
    if (arm) {
      arm.below = b.close < arm.lower ? arm.below + 1 : 0;
      if (b.at - arm.touched > 6 * HOUR || arm.below >= 2) { arm = undefined; detail = 'Previous support expired or failed'; }
    }
    if (!arm && b.close < Math.max(...bars.slice(Math.max(0, i - 288), i).map(c => c.high)) * .96) {
      // All pivots are confirmed by three later bars, and at least an hour old at the touch.
      const pivots: Candle[] = [];
      for (let j = Math.max(3, i - DAY / BAR); j <= i - 12; j++) {
        if (bars.slice(j - 3, j + 4).every((c, k) => k === 3 || c.low > bars[j].low)) pivots.push(bars[j]);
      }
      for (const pivot of pivots.slice().reverse()) {
        const peers = pivots.filter(p => Math.abs(p.low / pivot.low - 1) <= .04 && Math.abs(p.at - pivot.at) >= 6 * BAR);
        if (!peers.length) continue;
        const level = (pivot.low + peers[peers.length - 1].low) / 2, lower = level * .975, upper = level * 1.035;
        if (b.low <= upper && b.high >= lower && b.close >= lower) {
          arm = { anchor: pivot.at, lower, upper, touched: b.at, below: 0, tests:peers.length+1 };
          detail = 'Support touched; waiting for first strong rejection candle'; break;
        }
      }
    }
    if (!arm) continue;
    const mean = bars.slice(i - 20, i).reduce((s, c) => s + c.volume, 0) / 20;
    const ratio = mean > 0 ? b.volume / mean : 0;
    const stop = arm.lower * .995, risk = 1 - stop / b.close;
    const range = b.high - b.low, closePosition = range > 0 ? (b.close - b.low) / range : 0;
    const middle = (arm.lower + arm.upper) / 2;
    const trueRanges=bars.slice(Math.max(1,i-13),i+1).map((c,k)=>{const prev=bars[Math.max(0,i-13)+k-1]?.close??c.open;return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));});
    const atr14=trueRanges.reduce((sum,value)=>sum+value,0)/Math.max(1,trueRanges.length);
    const conditions={green:b.close>b.open,closeInZone:b.close>=middle&&b.close<=arm.upper*1.05,volume:ratio>=1.2,strongClose:closePosition>=.65,
      aboveEma9:b.close>ema9[i],ema9Rising:ema9[i]>ema9[i-1],emaAlignment:ema9[i]>=ema21[i]*.985,risk:risk<=.08};
    latest={at:b.at+BAR,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,meanVolume20:mean,volumeRatio:ratio,
      bodyPct:range>0?Math.abs(b.close-b.open)/range:0,upperWickPct:range>0?(b.high-Math.max(b.open,b.close))/range:0,
      lowerWickPct:range>0?(Math.min(b.open,b.close)-b.low)/range:0,closePosition,atr14,atrPct:atr14/b.close*100,
      ema9:ema9[i],ema21:ema21[i],sma50:sma50[i],ema9SlopePct:(ema9[i]/ema9[i-1]-1)*100,ema21SlopePct:(ema21[i]/ema21[i-1]-1)*100,
      priceToEma9Pct:(b.close/ema9[i]-1)*100,ema9ToEma21Pct:(ema9[i]/ema21[i]-1)*100,priceToSma50Pct:(b.close/sma50[i]-1)*100,
      priorPeakDrawdownPct:(b.close/Math.max(...bars.slice(Math.max(0,i-288),i).map(c=>c.high))-1)*100,
      supportArmed:true,supportAnchor:arm.anchor,supportLower:arm.lower,supportUpper:arm.upper,supportTestCount:arm.tests,
      supportTouchAgeBars:Math.round((b.at-arm.touched)/BAR),closesBelowSupport:arm.below,riskPct:risk*100,conditions};
    if (Object.values(conditions).every(Boolean)) {
      setups.push({ at: b.at + BAR, anchor: arm.anchor, lower: arm.lower, upper: arm.upper, price: b.close,
        ema9: ema9[i], ema21: ema21[i], sma50: sma50[i], volumeRatio: ratio, features:latest });
      detail = 'Super-aggressive support rejection confirmed with rising EMA9 and green volume'; arm = undefined;
    }
  }
  if (!arm && setups.at(-1)?.at !== (bars.at(-1)?.at ?? 0) + BAR) detail = 'Waiting for a new support touch and reclaim';
  if(!latest){
    const i=bars.length-1,b=bars[i],range=b.high-b.low,mean=bars.slice(i-20,i).reduce((s,c)=>s+c.volume,0)/20;
    const trueRanges=bars.slice(i-13,i+1).map((c,k)=>{const prev=bars[i-14+k]?.close??c.open;return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));}),atr14=trueRanges.reduce((s,n)=>s+n,0)/trueRanges.length;
    latest={at:b.at+BAR,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,meanVolume20:mean,volumeRatio:mean?b.volume/mean:0,
      bodyPct:range?Math.abs(b.close-b.open)/range:0,upperWickPct:range?(b.high-Math.max(b.open,b.close))/range:0,lowerWickPct:range?(Math.min(b.open,b.close)-b.low)/range:0,closePosition:range?(b.close-b.low)/range:0,
      atr14,atrPct:atr14/b.close*100,ema9:ema9[i],ema21:ema21[i],sma50:sma50[i],ema9SlopePct:(ema9[i]/ema9[i-1]-1)*100,ema21SlopePct:(ema21[i]/ema21[i-1]-1)*100,
      priceToEma9Pct:(b.close/ema9[i]-1)*100,ema9ToEma21Pct:(ema9[i]/ema21[i]-1)*100,priceToSma50Pct:(b.close/sma50[i]-1)*100,
      priorPeakDrawdownPct:(b.close/Math.max(...bars.slice(Math.max(0,i-288),i).map(c=>c.high))-1)*100,supportArmed:false,supportAnchor:null,supportLower:null,supportUpper:null,supportTestCount:0,supportTouchAgeBars:null,closesBelowSupport:0,riskPct:null,
      conditions:{green:b.close>b.open,closeInZone:false,volume:mean>0&&b.volume/mean>=1.2,strongClose:range>0&&(b.close-b.low)/range>=.65,aboveEma9:b.close>ema9[i],ema9Rising:ema9[i]>ema9[i-1],emaAlignment:ema9[i]>=ema21[i]*.985,risk:false}};
  }
  return { setups, detail, latest };
}
