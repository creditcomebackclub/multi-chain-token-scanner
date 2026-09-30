import { MINUTE, HOUR } from './config.js';
import type { Flow, Metrics, Trade } from './types.js';
export function flow(events: Trade[]): Flow {
  const buy = events.filter(e => e.side === 'buy'), sell = events.filter(e => e.side === 'sell');
  const buyers = new Map<string, number>();
  for (const e of buy) buyers.set(e.trader, (buyers.get(e.trader) || 0) + e.usd);
  const shares = [...buyers.values()].sort((a, b) => b - a);
  const buyUsd = buy.reduce((s, e) => s + e.usd, 0), sellUsd = sell.reduce((s, e) => s + e.usd, 0);
  // Count distinct transactions for activity thresholds; distinct swap legs still contribute USD.
  const buys = new Set(buy.map(e => e.tx)).size, sells = new Set(sell.map(e => e.tx)).size;
  return { buys, sells, buyUsd, sellUsd, volume: buyUsd + sellUsd,
    buyers: buyers.size, sellers: new Set(sell.map(e => e.trader)).size,
    largestBuyerShare: buyUsd ? (shares[0] || 0) / buyUsd : 1,
    topFiveShare: buyUsd ? shares.slice(0, 5).reduce((a, b) => a + b, 0) / buyUsd : 1,
    countRatio: sells ? buys / sells : buys ? 1e6 : 0,
    usdRatio: sellUsd ? buyUsd / sellUsd : buyUsd ? 1e6 : 0,
  };
}
export function aggregate(input: Trade[], now: number): Metrics {
  const events = [...new Map(input.filter(e => e.at <= now && e.at > now - HOUR).map(e => [e.id, e])).values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const window = (minutes: number, offset = 0) => events.filter(e => e.at > now - (minutes + offset) * MINUTE && e.at <= now - offset * MINUTE);
  const five = window(5), volumes = new Map<number, number>();
  for (const e of five) volumes.set(Math.floor(e.at / MINUTE), (volumes.get(Math.floor(e.at / MINUTE)) || 0) + e.usd);
  const candles = new Map<number, { close: number; low: number; high: number }>();
  for (const e of events) {
    const minute = Math.floor(e.at / MINUTE);
    if (minute >= Math.floor(now / MINUTE)) continue; // no incomplete-candle indicators
    const c = candles.get(minute);
    candles.set(minute, { close: e.price, low: Math.min(c?.low ?? e.price, e.price), high: Math.max(c?.high ?? e.price, e.price) });
  }
  // Only contiguous completed minutes. Gaps cannot manufacture 21/50-candle indicators.
  const path: { close: number; low: number; high: number }[] = [];
  for (let m = Math.floor(now / MINUTE) - 1; candles.has(m); m--) path.unshift(candles.get(m)!);
  let ema21: number | null = null;
  if (path.length >= 21) {
    ema21 = path.slice(0, 21).reduce((s, c) => s + c.close, 0) / 21;
    for (const c of path.slice(21)) ema21 = c.close * (2 / 22) + ema21 * (20 / 22);
  }
  const sma50 = path.length >= 50 ? path.slice(-50).reduce((s, c) => s + c.close, 0) / 50 : null;
  const lows = [path.slice(-9, -6), path.slice(-6, -3), path.slice(-3)].map(a => Math.min(...a.map(c => c.low)));
  const peak = Math.max(...path.slice(-10).map(c => c.high));
  const m5 = flow(five);
  return { m1: flow(window(1)), m5, h1: flow(events), previous5m: flow(window(5, 5)).volume,
    preceding5m: flow(window(5, 10)).volume,
    priceChange5m: five.length >= 2 ? (five.at(-1)!.price / five[0].price - 1) * 100 : null,
    ema21, sma50, higherLows: path.length >= 9 && lows[1] > lows[0] && lows[2] > lows[1],
    pullback: path.length >= 10 ? (peak - path.at(-1)!.close) / peak : null,
    minuteCount: path.length, largestMinuteShare: m5.volume ? Math.max(...volumes.values()) / m5.volume : 1,
  };
}
