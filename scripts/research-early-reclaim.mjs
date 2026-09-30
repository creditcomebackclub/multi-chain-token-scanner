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

function findSignals(bars, options) {
  if (bars.length < 80) return [];
  const ema9 = ema(bars, 9), ema21 = ema(bars, 21), sma50 = sma(bars, 50), signals = [];
  let arm;
  for (let i = 79; i < bars.length - 1; i++) {
    const bar = bars[i];
    if (arm) {
      arm.below = bar.close < arm.lower ? arm.below + 1 : 0;
      if (bar.at - arm.touched > 6 * HOUR || arm.below >= 2) arm = undefined;
    }
    if (!arm && ema21[i] < sma50[i] && bar.close < Math.max(...bars.slice(Math.max(0, i - DAY / BAR), i).map(row => row.high)) * .94) {
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
    const ratio = average > 0 ? bar.volume / average : 0;
    const stop = arm.lower * .995, risk = 1 - stop / bar.close, extension = bar.close / arm.upper - 1;
    const momentum = bar.close > ema9[i] && ema9[i] > ema9[i - 1]
      && (!options.requireEmaCross || ema9[i] > ema21[i])
      && (!options.requireSma || bar.close > sma50[i]);
    if (bar.close > bar.open && bar.close > arm.upper && ratio >= options.volumeRatio && momentum
      && risk <= options.maxRisk && extension <= options.maxExtension) {
      signals.push({ at: bar.at + BAR, entry: bar.close, stop, target: bar.close * (1 + options.target), risk, extension, volumeRatio: ratio });
      arm = undefined;
    }
  }
  return signals;
}

function outcome(bars, signal) {
  const future = bars.filter(bar => bar.at >= signal.at && bar.at < signal.at + 24 * HOUR);
  for (const bar of future) {
    const stop = bar.low <= signal.stop, target = bar.high >= signal.target;
    if (stop && target) return 'ambiguous';
    if (stop) return 'stop';
    if (target) return 'target';
  }
  return 'open';
}

const variants = [];
for (const volumeRatio of [1.25, 1.5, 2]) for (const requireEmaCross of [false, true]) for (const requireSma of [false, true]) for (const target of [.05, .08, .1]) {
  const options = { volumeRatio, requireEmaCross, requireSma, target, maxRisk: .08, maxExtension: .03 };
  const rows = datasets.flatMap(({ pair, rows }) => {
    const bars = parse(rows);
    return findSignals(bars, options).map(signal => ({ pair: `${pair.chain}:${pair.symbol}`, signal, outcome: outcome(bars, signal) }));
  });
  const count = result => rows.filter(row => row.outcome === result).length;
  variants.push({ options, signals: rows.length, target: count('target'), stop: count('stop'), ambiguous: count('ambiguous'), open: count('open'), rows });
}
variants.sort((a, b) => (b.target - b.stop) - (a.target - a.stop) || Math.abs(a.signals - 4) - Math.abs(b.signals - 4));
await writeFile(new URL('../research/early-reclaim-study.json', import.meta.url), JSON.stringify({ datasets: datasets.length, variants }, null, 2));
console.log(JSON.stringify(variants.slice(0, 12).map(({ rows, ...summary }) => summary), null, 2));
