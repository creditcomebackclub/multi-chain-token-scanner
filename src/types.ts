import type { Chain } from './config.js';
export interface Trade {
  id: string; chain: Chain; token: string; quote: string; pool: string; trader: string;
  tx: string; side: 'buy' | 'sell'; baseAmount: string; usd: number; price: number;
  at: number; source: 'bitquery'; confirmed: true;
}
export interface Discovery { chain: Chain; token: string; tx: string; at: number; source: 'helius' }
export interface Market {
  chain: Chain; token: string; pool: string; name: string; symbol: string; chart: string;
  createdAt: number; fetchedAt: number; price: number; liquidity: number; fdv: number;
  marketCap: number | null; priceChange5m: number; raw: unknown;
}
export interface Flow {
  buys: number; sells: number; buyUsd: number; sellUsd: number; volume: number;
  buyers: number; sellers: number; largestBuyerShare: number; topFiveShare: number;
  countRatio: number; usdRatio: number;
}
export interface Metrics {
  m1: Flow; m5: Flow; h1: Flow; previous5m: number; preceding5m: number;
  priceChange5m: number | null; ema21: number | null; sma50: number | null;
  higherLows: boolean; pullback: number | null; minuteCount: number; largestMinuteShare: number;
}
export interface Security {
  status: 'PASS' | 'REJECT' | 'UNKNOWN'; reasons: string[]; checkedAt: number;
  buyTax: number | null; sellTax: number | null; raw: unknown;
}
export interface Snapshot {
  id: string; chain: Chain; token: string; at: number; ruleId: string;
  market: Market | null; metrics: Metrics; security: Security;
  score: number | null; components: Record<string, number>; reasons: string[];
  why: string[]; qualifies: boolean; confirmed: boolean;
}
export interface Health {
  provider: string; state: 'healthy' | 'degraded' | 'disabled'; detail: string;
  lastEventAt: number | null; checkedAt: number; since: number; warned: boolean;
}
export interface Reference { id: string; chain: Chain; token: string; snapshot: Snapshot; at: number; kind: 'shadow' | 'alert' }
export interface WalletTrade {
  id: string; trader: string; wallet: string; chain: Chain; tx: string; at: number;
  side: 'buy' | 'sell'; token: string; tokenAmount: string | null; tokenSymbol: string | null;
  quoteSymbol: string; quoteAmount: string; quoteUsd: number | null;
  chart: string | null;
}
