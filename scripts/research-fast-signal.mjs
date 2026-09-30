import { readdir, readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../research/candles/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.json'));
const datasets = await Promise.all(files.map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
const BAR = 5 * 60_000;

const series = (bars, length, exponential) => {
  const output = [];
  for (let i = 0; i < bars.length; i++) {
    if (exponential) output[i] = i ? bars[i].close * (2 / (length + 1)) + output[i - 1] * (1 - 2 / (length + 1)) : bars[i].close;
    else output[i] = i >= length - 1 ? bars.slice(i - length + 1, i + 1).reduce((sum, bar) => sum + bar.close, 0) / length : NaN;
  }
  return output;
};

function parse(rows) {
  const bars = rows.map(([seconds, open, high, low, close, volume]) => ({ at: seconds * 1000, open, high, low, close, volume }))
    .sort((a, b) => a.at - b.at);
  let start = bars.length - 1;
  while (start > 0 && bars[start].at - bars[start - 1].at === BAR) start--;
  return bars.slice(start);
}

function signals(bars, options) {
  const ema9 = series(bars, 9, true), ema21 = series(bars, 21, true), sma50 = series(bars, 50, false), output = [];
  let lastSignal = 0;
  for (let i = 55; i < bars.length - 1; i++) {
    const bar = bars[i], previous = bars[i - 1];
    const averageVolume = bars.slice(i - 20, i).reduce((sum, row) => sum + row.volume, 0) / 20;
    const pullback = bars.slice(i - options.pullbackBars, i).some((row, offset) => row.low <= ema21[i - options.pullbackBars + offset] * 1.01);
    const range = bar.high - bar.low, closeLocation = range > 0 ? (bar.close - bar.low) / range : 0;
    const recentLow = Math.min(...bars.slice(i - 4, i + 1).map(row => row.low));
    const stop = recentLow * 0.995, risk = 1 - stop / bar.close;
    const trend = bar.close > sma50[i] && ema9[i] > ema21[i] && ema21[i] > ema21[i - 3]
      && (!options.requireEma21AboveSma50 || ema21[i] > sma50[i]);
    const reclaim = previous.close <= ema9[i - 1] * 1.005 && bar.close > ema9[i] && bar.close > previous.high;
    if (trend && pullback && reclaim && bar.close > bar.open && closeLocation >= .65
      && averageVolume > 0 && bar.volume / averageVolume >= options.volumeRatio
      && bar.close / ema21[i] - 1 <= .06 && risk >= .015 && risk <= options.maxRisk
      && bar.at - lastSignal >= options.cooldownBars * BAR) {
      output.push({ at: bar.at + BAR, entry: bar.close, stop, target: bar.close * (1 + options.target), volumeRatio: bar.volume / averageVolume, risk });
      lastSignal = bar.at;
    }
  }
  return output;
}

function outcome(bars, signal) {
  const future = bars.filter(bar => bar.at >= signal.at && bar.at < signal.at + 24 * 60 * 60_000);
  for (const bar of future) {
    const stop = bar.low <= signal.stop, target = bar.high >= signal.target;
    if (stop && target) return { result: 'ambiguous', at: bar.at };
    if (stop) return { result: 'stop', at: bar.at };
    if (target) return { result: 'target', at: bar.at };
  }
  const last = future.at(-1)?.close;
  return { result: 'open', returnPct: last ? 100 * (last / signal.entry - 1) : null };
}

const variants = [];
for (const volumeRatio of [1, 1.25, 1.5]) for (const maxRisk of [.05, .06, .08]) for (const target of [.08, .1, .12]) for (const requireEma21AboveSma50 of [false, true]) {
  const options = { volumeRatio, maxRisk, target, requireEma21AboveSma50, pullbackBars: 8, cooldownBars: 72 };
  const rows = datasets.flatMap(({ pair, rows }) => {
    const bars = parse(rows);
    return signals(bars, options).map(signal => ({ pair: `${pair.chain}:${pair.symbol}`, signal, outcome: outcome(bars, signal) }));
  });
  const counts = Object.fromEntries(['target', 'stop', 'ambiguous', 'open'].map(result => [result, rows.filter(row => row.outcome.result === result).length]));
  variants.push({ options, signals: rows.length, ...counts, rows });
}

variants.sort((a, b) => (b.target - b.stop * 2) - (a.target - a.stop * 2) || Math.abs(a.signals - 4) - Math.abs(b.signals - 4));
await writeFile(new URL('../research/fast-signal-study.json', import.meta.url), JSON.stringify({ datasets: datasets.length, variants }, null, 2));
console.log(JSON.stringify(variants.slice(0, 12).map(({ rows, ...summary }) => summary), null, 2));
