import { readFile, writeFile } from 'node:fs/promises';

const snapshot = JSON.parse(await readFile(new URL('../research/live-snapshot.json', import.meta.url), 'utf8'));
const network = { solana: 'solana', bnb: 'bsc', ethereum: 'eth', robinhood: 'robinhood', base: 'base' };
const alerts = snapshot.chartAlerts.filter(({ data }) => data.plan?.version === 'chart-entry-v1');
const barsByPool = new Map();

for (const { data } of alerts) {
  const pair = data.pair;
  if (barsByPool.has(pair.pool)) continue;
  const url = `https://api.geckoterminal.com/api/v2/networks/${network[pair.chain]}/pools/${encodeURIComponent(pair.pool)}/ohlcv/minute?aggregate=15&limit=1000&currency=usd&token=${encodeURIComponent(pair.token)}&include_empty_intervals=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`GeckoTerminal HTTP ${response.status}`);
  const body = await response.json();
  const bars = (body.data?.attributes?.ohlcv_list ?? []).map(([seconds, open, high, low, close, volume]) => ({
    at: seconds * 1000, open, high, low, close, volume,
  })).sort((a, b) => a.at - b.at);
  barsByPool.set(pair.pool, bars);
  await new Promise(resolve => setTimeout(resolve, 1500));
}

const output = alerts.map(alert => {
  const { pair, plan } = alert.data;
  const sentAt = Date.parse(alert.sent_at);
  const bars = barsByPool.get(pair.pool).filter(bar => bar.at + 15 * 60_000 > sentAt);
  const completeAfterAlert = bars.filter(bar => bar.at >= Math.ceil(sentAt / (15 * 60_000)) * 15 * 60_000);
  const firstHit = completeAfterAlert.flatMap(bar => [
    ...(bar.low <= plan.stop ? [{ type: 'stop', at: bar.at }] : []),
    ...(bar.high >= plan.takeProfit ? [{ type: 'takeProfit', at: bar.at }] : []),
  ]).sort((a, b) => a.at - b.at)[0] ?? null;
  const closeAt = hours => bars.find(bar => bar.at + 15 * 60_000 >= sentAt + hours * 60 * 60_000)?.close ?? null;
  const pct = price => price === null ? null : 100 * (price / plan.referenceEntry - 1);
  return {
    sentAt: alert.sent_at, chain: pair.chain, symbol: pair.symbol,
    entry: plan.referenceEntry, stop: plan.stop, takeProfit: plan.takeProfit,
    firstHit, return1h: pct(closeAt(1)), return6h: pct(closeAt(6)), return24h: pct(closeAt(24)),
    maxReturn: pct(Math.max(...bars.map(bar => bar.high))),
    maxDrawdown: pct(Math.min(...bars.map(bar => bar.low))),
    currentReturn: pct(bars.at(-1)?.close ?? null),
  };
});

await writeFile(new URL('../research/chart-alert-outcomes.json', import.meta.url), JSON.stringify({ analyzedAt: new Date().toISOString(), output }, null, 2));
console.log(JSON.stringify(output, null, 2));
