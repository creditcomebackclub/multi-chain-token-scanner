import { randomUUID } from 'node:crypto';
import { CHAINS, MINUTE, HOUR, RULE_ID, rules, type Chain } from './config.js';
import type { Market, Metrics, Security, Snapshot } from './types.js';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export function evaluate(args: { chain: Chain; token: string; now: number; market: Market | null; metrics: Metrics; security: Security; tradeable: boolean; covered: boolean; previous?: Snapshot }): Snapshot {
  const { chain, token, now, market: p, metrics: m, security: s, previous: prev } = args;
  const reasons: string[] = [], why: string[] = [], components: Record<string, number> = {};
  const reject = (condition: boolean, reason: string) => { if (condition) reasons.push(reason); };
  reject(!args.covered, 'Confirmed provider coverage unavailable');
  reject(!args.tradeable, 'Research only: FOMO support unconfirmed');
  reject(s.status !== 'PASS', `Security ${s.status}: ${s.reasons.join(', ')}`);
  reject(now - s.checkedAt > MINUTE || s.checkedAt > now, 'Security result stale');
  reject(!p, 'Market data unavailable');
  reject(m.m5.volume < rules.minVolume5mUsd, 'Five-minute volume below minimum');
  reject(m.m5.buys + m.m5.sells < rules.minSwaps5m, 'Too few five-minute swaps');
  reject(m.m5.buyers < rules.minBuyers5m, 'Too few unique buyers');
  reject(m.m5.countRatio < rules.minBuySellCountRatio, 'Buy/sell transaction ratio too low');
  reject(m.m5.usdRatio < rules.minBuySellUsdRatio, 'Buy/sell USD ratio too low');
  reject(m.m5.largestBuyerShare > rules.maxBuyerShare, 'Single buyer dominates flow');
  reject(m.m5.topFiveShare > rules.maxTopFiveShare, 'Top five buyers dominate flow');
  if (p) {
    const age = now - p.createdAt;
    reject(p.chain !== chain || p.token !== token, 'Market identity mismatch');
    reject(age < rules.minPoolAgeMinutes * MINUTE || age > rules.maxPoolAgeHours * HOUR, 'Pool age outside allowed range');
    reject(now - p.fetchedAt > MINUTE || p.fetchedAt > now, 'Market data stale');
    reject(!Number.isFinite(p.liquidity) || p.liquidity < CHAINS[chain].minLiquidity, 'Liquidity below minimum');
    reject(!Number.isFinite(p.fdv) || p.fdv <= 0 || p.fdv / p.liquidity > rules.maxFdvLiquidity, 'FDV/liquidity too high or unknown');
    reject(!Number.isFinite(p.price) || p.price <= 0, 'Price invalid');
    reject(!Number.isFinite(p.priceChange5m) || Math.max(p.priceChange5m, m.priceChange5m ?? 0) > rules.maxPriceChange5mPercent, 'Five-minute price move extended or unknown');
    if (prev?.market && prev.ruleId === RULE_ID && now - prev.at <= 3 * MINUTE && prev.market.pool === p.pool) reject(p.liquidity < prev.market.liquidity * 0.9, 'Liquidity fell more than 10%');
    if (!reasons.length) {
      const valuation = p.fdv / p.liquidity;
      components.liquidity = Math.round(10 * clamp(p.liquidity / (CHAINS[chain].minLiquidity * 3)) + 10 * clamp((20 - valuation) / 15) + (prev?.market && prev.market.pool === p.pool && p.liquidity >= prev.market.liquidity ? 5 : 2));
      components.buyers = Math.round(10 * clamp(m.m5.buyers / 100) + 8 * clamp((m.m5.usdRatio - 1) / 1.5) + 7 * clamp(1 - m.m5.topFiveShare / 0.6));
      components.acceleration = Math.round((m.previous5m > 0 ? 10 * clamp((m.m5.volume / m.previous5m - 1) / 1.5) : 0) + (m.preceding5m > 0 && m.previous5m > m.preceding5m && m.m5.volume > m.previous5m ? 5 : 0) + (m.largestMinuteShare <= 0.35 ? 5 : 0));
      components.structure = (m.higherLows ? 5 : 0) + (m.ema21 !== null && p.price > m.ema21 ? 4 : 0) + (m.ema21 !== null && m.sma50 !== null && m.ema21 > m.sma50 ? 3 : 0) + (m.pullback !== null && m.pullback >= 0.01 && m.pullback <= 0.15 ? 3 : 0);
      components.ageValuation = Math.round((age <= 12 * HOUR ? 8 : 4) + 7 * clamp((20 - valuation) / 15));
      if (m.m5.topFiveShare < 0.3) why.push('Distributed buy flow');
      if (m.preceding5m > 0 && m.previous5m > m.preceding5m && m.m5.volume > m.previous5m) why.push('Rising volume across three windows');
      if (m.ema21 && p.price > m.ema21 && m.pullback !== null && m.pullback >= 0.01 && m.pullback <= 0.15) why.push('Controlled pullback above 21 EMA');
      if (p.liquidity >= 2 * CHAINS[chain].minLiquidity) why.push('Liquidity comfortably above minimum');
    }
  }
  const score = reasons.length ? null : Object.values(components).reduce((a, b) => a + b, 0);
  const qualifies = score !== null && score >= rules.alertThreshold;
  const confirmed = !!(qualifies && p && prev?.qualifies && prev.ruleId === RULE_ID && prev.market && now - prev.at >= MINUTE && now - prev.at <= 3 * MINUTE && prev.market.pool === p.pool && p.liquidity >= prev.market.liquidity && m.m5.buyUsd >= prev.metrics.m5.buyUsd && m.m5.usdRatio >= prev.metrics.m5.usdRatio && s.buyTax !== null && s.sellTax !== null && s.buyTax <= (prev.security.buyTax ?? -1) && s.sellTax <= (prev.security.sellTax ?? -1));
  if (score !== null && !qualifies) reasons.push(`Score below ${rules.alertThreshold}`);
  return { id: randomUUID(), chain, token, at: now, ruleId: RULE_ID, market: p, metrics: m, security: s, score, components, reasons, why, qualifies, confirmed };
}
