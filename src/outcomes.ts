import { HOUR, MINUTE, rules } from './config.js';
import type { Reference, Trade } from './types.js';
export interface Sample { at: number; price: number; liquidity: number }
export function measure(ref: Reference, hours: number, trades: Trade[], samples: Sample[], gap: boolean) {
  const target = ref.at + hours * HOUR, base = ref.snapshot.market!;
  const end = trades.find(t => t.at >= target && t.at <= target + 5 * MINUTE && t.pool === base.pool);
  const market = samples.find(s => s.at >= target && s.at <= target + 5 * MINUTE);
  const path = trades.filter(t => t.at >= ref.at && t.at <= target && t.pool === base.pool).map(t => t.price);
  const returnPercent = end ? (end.price / base.price - 1) * 100 : null;
  const mfe = path.length && !gap ? (path.reduce((a, b) => Math.max(a, b), base.price) / base.price - 1) * 100 : null;
  const mae = path.length && !gap ? (path.reduce((a, b) => Math.min(a, b), base.price) / base.price - 1) * 100 : null;
  return { targetAt: target, measuredAt: end?.at ?? null, price: end?.price ?? null,
    liquidity: market?.liquidity ?? null, liquidityMeasuredAt: market?.at ?? null, returnPercent,
    maximumFavorablePercent: mfe, maximumAdversePercent: mae, complete: !!end && !!market && !gap && path.length > 0,
    hit: returnPercent === null || mae === null ? null : returnPercent >= rules.hitTargetPercent && mae >= -rules.hitMaxDrawdownPercent,
    caveat: gap ? 'Provider gap: excursions unknown' : 'Observed confirmed trades; excludes fees and execution slippage',
  };
}
export const median = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length ? a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 : null;
};
