import { CHAINS, HOUR, MINUTE, rules, type Config } from './config.js';
import { unknownSecurity } from './security.js';
import type { Market, Security } from './types.js';
import type { Store } from './store.js';
import type { Telegram } from './telegram.js';
import type { DexScreener, GoPlus } from './providers/enrichment.js';
import type { DiscoveryCandidate, FreeDiscovery } from './providers/discovery.js';
import type { ResearchCollector } from './research-collection.js';

export interface ShortlistEntry extends DiscoveryCandidate {
  at: number;
  marketPass: boolean;
  reasons: string[];
  priority: number;
  security: Security;
  dex: { priceUsd: number; liquidity: number; fdv: number; marketCap: number | null;
    priceChange5m: number; chart: string; fetchedAt: number } | null;
}

// Public pool feeds do not provide a trustworthy "memecoin" classification.
// Exclude obvious stablecoins, wrapped majors, liquid-staking assets, and established base assets.
export const excludedSymbols = new Set([
  'BTC', 'WBTC', 'CBBTC', 'TBTC', 'LBTC', 'BTCB', 'ETH', 'WETH', 'STETH', 'WSTETH', 'RETH',
  'SOL', 'WSOL', 'BNB', 'WBNB', 'ZEC', 'USDC', 'USDT', 'USDS', 'DAI', 'BUSD', 'FDUSD',
  'PYUSD', 'USDE', 'USDD', 'TUSD', 'FRAX', 'LUSD', 'GUSD', 'EURC', 'RLUSD', 'USDT0',
]);
const excludedName = /^(?:wrapped |bridged |binance-peg )?(?:bitcoin|ether(?:eum)?|solana|bnb|zcash|usd coin|tether)(?: token)?$/i;
const symbolKey = (symbol: string) => symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
export function shortlistEligible(candidate: DiscoveryCandidate, now: number): boolean {
  const age = now - candidate.createdAt;
  return age >= rules.minPoolAgeMinutes * MINUTE && age <= rules.maxPoolAgeHours * HOUR
    && !excludedSymbols.has(symbolKey(candidate.symbol)) && !excludedName.test(candidate.name.trim());
}

// This market screen never fabricates the original strategy's score or trade evidence.
export function screenMarket(candidate: DiscoveryCandidate, now: number, dex?: Market | null): ShortlistEntry {
  const reasons: string[] = [], age = now - candidate.createdAt;
  if (age < rules.minPoolAgeMinutes * MINUTE) reasons.push('Pool younger than 10 minutes');
  if (age > rules.maxPoolAgeHours * HOUR) reasons.push('Pool older than 24 hours');
  if (candidate.liquidity < CHAINS[candidate.chain].minLiquidity) reasons.push('Liquidity below strategy minimum');
  if (candidate.volume5m < rules.minVolume5mUsd) reasons.push('Five-minute volume below strategy minimum');
  if (candidate.priceUsd === null) reasons.push('Price unavailable');
  if (candidate.buys5m + candidate.sells5m < rules.minSwaps5m) reasons.push('Too few recent swaps');
  if (candidate.buys5m / Math.max(1, candidate.sells5m) < rules.minBuySellCountRatio) reasons.push('Buy/sell transaction ratio below minimum');
  if (candidate.buyers5m === null) reasons.push('Buyer count unavailable');
  else if (candidate.buyers5m < rules.minBuyers5m) reasons.push('Too few reported buyers');
  if (dex !== undefined) {
    if (!dex || dex.chain !== candidate.chain || dex.token !== candidate.token || dex.pool !== candidate.pool) reasons.push('DEX Screener exact-pool confirmation unavailable');
    else {
      if (dex.liquidity < CHAINS[candidate.chain].minLiquidity) reasons.push('DEX Screener liquidity below strategy minimum');
      if (dex.fdv / dex.liquidity > rules.maxFdvLiquidity) reasons.push('FDV/liquidity ratio above strategy maximum');
      if (dex.priceChange5m > rules.maxPriceChange5mPercent) reasons.push('Five-minute price move already extended');
    }
  }
  return { ...candidate, at: candidate.fetchedAt, marketPass: reasons.length === 0, reasons,
    priority: -reasons.length,
    security: unknownSecurity(now, 'Security check pending; market shortlist is not an executable trade signal'),
    dex: dex ? { priceUsd: dex.price, liquidity: dex.liquidity, fdv: dex.fdv, marketCap: dex.marketCap,
      priceChange5m: dex.priceChange5m, chart: dex.chart, fetchedAt: dex.fetchedAt } : null };
}

export class ShortlistWorker {
  private securityCache = new Map<string, Security>();
  private lastRetention = 0;
  constructor(private c: Config, private store: Store, private discovery: FreeDiscovery, private dex: DexScreener, private security: GoPlus, private telegram?: Telegram, private research?:Pick<ResearchCollector,'observeYoungPools'>) {}
  async tick() {
    const result = await this.discovery.discover(this.c.chains), now = Date.now();
    if (this.c.chartSetupsEnabled) await this.store.saveSetupCandidates(result.candidates,this.c.candleRetentionDays);
    if (this.c.youngPoolResearchEnabled) {
      try{await this.research?.observeYoungPools(result.candidates,now);}
      catch{await this.store.health('research-young-pools','degraded','Research cohort collection failed; shortlist and alert delivery continued').catch(()=>undefined);}
    }
    for (const chain of this.c.chains) {
      const health = result.health[chain];
      await this.store.health(`discovery:${chain}`, health?.ok ? 'healthy' : 'degraded', health?.detail || 'Discovery unavailable');
    }
    const fresh = result.candidates.filter(candidate => now - candidate.fetchedAt < 15 * MINUTE && candidate.fetchedAt <= now);
    const eligible = fresh.filter(candidate => shortlistEligible(candidate, now));
    const dexMarkets = new Map<string, Market>(), dexFailed: string[] = [];
    let dexRequests = 0;
    for (const chain of this.c.chains) {
      const group = eligible.filter(candidate => candidate.chain === chain);
      if (!group.length) continue;
      dexRequests++;
      try {
        const markets = await this.dex.batch(chain, group.map(candidate => candidate.token));
        for (const candidate of group) {
          const exact = markets.get(candidate.token)?.find(market => market.pool === candidate.pool);
          if (exact) dexMarkets.set(`${chain}:${candidate.pool}`, exact);
        }
      } catch { dexFailed.push(chain); }
    }
    const entries = eligible.map(candidate => screenMarket(candidate, now, dexMarkets.get(`${candidate.chain}:${candidate.pool}`) ?? null));
    await this.store.health('dexscreener', !dexRequests ? 'disabled' : dexFailed.length ? 'degraded' : 'healthy',
      !dexRequests ? 'Waiting for a 10m–24h speculative-token candidate' : `Confirmed ${dexMarkets.size}/${eligible.length} exact pools; ${dexFailed.length ? `requests failed for ${dexFailed.join(', ')}` : 'batched API responding'}. Missing confirmation blocks the market screen.`);
    const checked: Security[] = [], alertCandidates: ShortlistEntry[] = [];
    // One market-qualified candidate per chain receives a fresh risk check per cycle.
    // Other rows remain explicitly UNKNOWN. Failed checks are never promoted to PASS.
    for (const chain of this.c.chains) {
      const group = entries.filter(row => row.chain === chain && row.marketPass)
        .sort((a, b) => b.volume5m - a.volume5m);
      const selected = group[0];
      if (selected) {
        const key = `${chain}:${selected.token}`, cached = this.securityCache.get(key);
        selected.security = cached && now - cached.checkedAt < 5 * MINUTE ? cached : await this.security.check(chain, selected.token, selected.pool);
        this.securityCache.set(key, selected.security);
        checked.push(selected.security);
        alertCandidates.push(selected);
      }
    }
    for (const row of entries) {
      const cached = this.securityCache.get(`${row.chain}:${row.token}`);
      if (cached && now - cached.checkedAt < 5 * MINUTE) row.security = cached;
      if (row.security.status === 'REJECT') row.priority -= 100;
    }
    for (const [key, value] of this.securityCache) if (now - value.checkedAt > HOUR) this.securityCache.delete(key);
    await this.store.saveShortlist(entries);
    if (this.telegram && this.c.scoutPushEnabled) {
      for (const row of alertCandidates.sort((a, b) => b.volume5m - a.volume5m)) await this.telegram.shortlistAlert(row);
    }
    if (checked.length) await this.store.health('goplus', checked.every(value => value.raw) ? 'healthy' : 'degraded', `Checked ${checked.length} shortlisted tokens; ${checked.filter(value => value.status === 'UNKNOWN').length} incomplete or unavailable. Results do not prove sellability.`);
    // Keep the most recent chart/audit health instead of overwriting it with
    // "disabled" merely because this shortlist cycle had no market match.
    const allFeedsHealthy = this.c.chains.every(chain => result.health[chain]?.ok);
    await this.store.health('shortlist', allFeedsHealthy && !dexFailed.length ? 'healthy' : 'degraded', `Reviewed ${fresh.length} pools; ${entries.length} are 10m–24h speculative-token candidates after major/stable exclusions; ${entries.filter(row => row.marketPass).length} pass the GeckoTerminal + DEX Screener market screen. Quotes and full trade analysis remain unverified.`);
    if (now - this.lastRetention > HOUR) { await this.store.retention(this.c.candleRetentionDays); this.lastRetention = now; }
    console.log(JSON.stringify({ event: 'shortlist_refreshed', pools: entries.length, marketMatches: entries.filter(row => row.marketPass).length }));
  }
}
