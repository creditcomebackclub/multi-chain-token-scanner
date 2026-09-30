import { readdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../research/candles/', import.meta.url);
const datasets = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
  .map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
const BAR = 5 * 60_000, HOUR = 60 * 60_000, DAY = 24 * HOUR;

function parse(rows) {
  const bars = rows.map(([seconds, open, high, low, close, volume]) => ({ at: seconds * 1000, open, high, low, close, volume })).sort((a, b) => a.at - b.at);
  let start = bars.length - 1;
  while (start > 0 && bars[start].at - bars[start - 1].at === BAR) start--;
  return bars.slice(start);
}
const ema = (bars, length) => bars.reduce((out, bar, index) => [...out, index ? bar.close * (2 / (length + 1)) + out[index - 1] * (1 - 2 / (length + 1)) : bar.close], []);
const sma = (bars, length) => bars.map((_, index) => index < length - 1 ? NaN : bars.slice(index - length + 1, index + 1).reduce((sum, bar) => sum + bar.close, 0) / length);

function signals(bars, options) {
  if (bars.length < 80) return [];
  const ema9 = ema(bars, 9), ema21 = ema(bars, 21), sma50 = sma(bars, 50), found = [];
  let arm;
  for (let i = 79; i < bars.length - 1; i++) {
    const bar = bars[i];
    if (arm) {
      arm.below = bar.close < arm.lower ? arm.below + 1 : 0;
      if (bar.at - arm.touched > 6 * HOUR || arm.below >= 2) arm = undefined;
    }
    if (!arm && bar.close < Math.max(...bars.slice(Math.max(0, i - DAY / BAR), i).map(row => row.high)) * options.pullback) {
      const pivots = [];
      for (let j = Math.max(3, i - DAY / BAR); j <= i - 12; j++) {
        if (bars.slice(j - 3, j + 4).every((row, offset) => offset === 3 || row.low > bars[j].low)) pivots.push(bars[j]);
      }
      for (const pivot of pivots.slice().reverse()) {
        const peers = pivots.filter(peer => Math.abs(peer.low / pivot.low - 1) <= .04 && Math.abs(peer.at - pivot.at) >= 6 * BAR);
        if (!peers.length) continue;
        const level = (pivot.low + peers.at(-1).low) / 2, lower = level * .975, upper = level * 1.035;
        if (bar.low <= upper && bar.high >= lower && bar.close >= lower) { arm = { lower, upper, touched: bar.at, below: 0 }; break; }
      }
    }
    if (!arm) continue;
    const average = bars.slice(i - 20, i).reduce((sum, row) => sum + row.volume, 0) / 20;
    const volumeRatio = average > 0 ? bar.volume / average : 0;
    const stop = arm.lower * .995, risk = 1 - stop / bar.close;
    const range = bar.high - bar.low, closePosition = range > 0 ? (bar.close - bar.low) / range : 0;
    const threshold = options.zone === 'middle' ? (arm.lower + arm.upper) / 2 : arm.upper;
    if (bar.close > bar.open && bar.close >= threshold && bar.close <= arm.upper * 1.05
      && volumeRatio >= options.volumeRatio && closePosition >= .65
      && bar.close > ema9[i] && ema9[i] > ema9[i - 1] && ema9[i] >= ema21[i] * options.emaTolerance
      && (!options.requireSma || bar.close > sma50[i]) && risk <= options.maxRisk) {
      found.push({ at: bar.at + BAR, entry: bar.close, stop, target: bar.close * 1.05, risk, volumeRatio });
      arm = undefined;
    }
  }
  return found;
}

function outcome(bars, signal) {
  for (const bar of bars.filter(bar => bar.at >= signal.at && bar.at < signal.at + 24 * HOUR)) {
    const stop = bar.low <= signal.stop, target = bar.high >= signal.target;
    if (stop && target) return 'ambiguous';
    if (stop) return 'stop';
    if (target) return 'target';
  }
  return 'open';
}

const variants = [];
for (const zone of ['middle', 'upper']) for (const pullback of [.94, .96]) for (const volumeRatio of [1, 1.2, 1.5])
  for (const emaTolerance of [.985, 1]) for (const requireSma of [false, true]) for (const maxRisk of [.08, .1]) {
    const options = { zone, pullback, volumeRatio, emaTolerance, requireSma, maxRisk };
    const rows = datasets.flatMap(({ pair, rows }) => {
      const bars = parse(rows);
      return signals(bars, options).map(signal => ({ pair: `${pair.chain}:${pair.symbol}`, signal, outcome: outcome(bars, signal) }));
    });
    const count = result => rows.filter(row => row.outcome === result).length;
    variants.push({ options, signals: rows.length, target: count('target'), stop: count('stop'), ambiguous: count('ambiguous'), open: count('open'), rows });
  }
variants.sort((a, b) => (b.target / Math.max(1, b.target + b.stop) - a.target / Math.max(1, a.target + a.stop)) || b.signals - a.signals);
await writeFile(new URL('../research/super-aggressive-study.json', import.meta.url), JSON.stringify({ datasets: datasets.length, variants }, null, 2));
console.log(JSON.stringify(variants.filter(v => v.signals >= 12).slice(0, 20).map(({ rows, ...summary }) => summary), null, 2));
