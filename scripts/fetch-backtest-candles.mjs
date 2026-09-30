import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const snapshot = JSON.parse(await readFile(new URL('../research/live-snapshot.json', import.meta.url), 'utf8'));
const pairs = snapshot.watchlists[0]?.data ?? [];
const network = { solana: 'solana', bnb: 'bsc', ethereum: 'eth', robinhood: 'robinhood', base: 'base' };
const directory = new URL('../research/candles/', import.meta.url);
await mkdir(directory, { recursive: true });

let fetched = 0;
for (const [index, pair] of pairs.entries()) {
  const name = `${pair.chain}_${pair.pool.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
  const target = new URL(name, directory);
  if (existsSync(target)) continue;
  const url = `https://api.geckoterminal.com/api/v2/networks/${network[pair.chain]}/pools/${encodeURIComponent(pair.pool)}/ohlcv/minute?aggregate=5&limit=500&currency=usd&token=${encodeURIComponent(pair.token)}&include_empty_intervals=true`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    console.log(`${index + 1}/${pairs.length} ${pair.symbol}: HTTP ${response.status}`);
  } else {
    const body = await response.json();
    await writeFile(target, JSON.stringify({ pair, rows: body.data?.attributes?.ohlcv_list ?? [] }));
    fetched++;
    console.log(`${index + 1}/${pairs.length} ${pair.symbol}: saved`);
  }
  if (index + 1 < pairs.length) await new Promise(resolve => setTimeout(resolve, 7_000));
}
console.log(`Fetched ${fetched}; ${pairs.length} pairs total.`);
