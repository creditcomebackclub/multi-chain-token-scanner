import { MINUTE } from './config.js';
import type { Setup } from './chart-pattern.js';
export const OWNER_PLAN_VERSION='owner-double-trail20-v1';
export const OWNER_RUNNER_TRAIL_PCT=20;

// Signal levels, not an execution quote or a position-management service.
export function chartTradePlan(s: Setup) {
  if (![s.at,s.lower,s.upper,s.price].every(n=>Number.isFinite(n)&&n>0) || s.lower>=s.upper || s.price<s.lower || s.price>s.upper*1.05) throw new Error('Invalid chart trade plan');
  const stop=s.lower*.995, entryMin=Math.max(s.lower,s.price*.99), entryMax=Math.min(s.price*1.02,stop/.90);
  return {version:OWNER_PLAN_VERSION,entryMin,entryMax,referenceEntry:s.price,stop,
    riskPct:(1-stop/s.price)*100,maxRiskPct:(1-stop/entryMax)*100,
    takeProfit:s.price*2,sellPct:50,runnerTarget:null,runnerTrailPct:OWNER_RUNNER_TRAIL_PCT,runnerSellPct:50,
    expiresAt:s.at+10*MINUTE};
}
export function chartEntryAvailable(s: Setup, market: {price:number;fetchedAt:number}, now:number): boolean {
  const p=chartTradePlan(s);
  return Number.isFinite(market.price) && Number.isFinite(market.fetchedAt)
    && now>=s.at && now<p.expiresAt && market.fetchedAt<=now && now-market.fetchedAt<=60_000
    && market.price>=p.entryMin && market.price<=p.entryMax;
}
