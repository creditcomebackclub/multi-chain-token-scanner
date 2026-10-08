// Read-only export. Railway credentials stay in memory and are never written.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import pg from 'pg';

const root = 'research/ml/data/strategy-discovery-v1';
const cutoff = Date.parse('2026-10-08T00:00:00Z');
const BAR = 300_000;
const features = ['volumeRatio','riskPct','atrPct','bodyPct','closePosition','upperWickPct','lowerWickPct','ema9SlopePct','ema21SlopePct','priceToEma9Pct','ema9ToEma21Pct','priceToSma50Pct','priorPeakDrawdownPct','supportTestCount','supportTouchAgeBars'];
const columns = ['id','source','chain','token','pool','support_anchor','detected_at','entry_price','signal_close','support_stop_price','atr14',...features];
const csv = value => { const s = value == null ? '' : String(value); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s; };
const digest = value => createHash('sha256').update(value).digest('hex');
let connectionString = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (process.argv.includes('--railway')) {
  let output;
  try { output = execFileSync('npx', ['--yes','@railway/cli','variables','--project','39f52a77-9538-44fd-bac9-11829d6511c0','--environment','production','--service','Postgres','--json'], { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:60_000 }); }
  catch { throw new Error('Railway variable read unavailable. Credential output suppressed.'); }
  const parsed = JSON.parse(output);
  const vars = Array.isArray(parsed) ? Object.fromEntries(parsed.map(v => [v.name ?? v.key, v.value])) : parsed.variables ?? parsed;
  connectionString = vars.DATABASE_PUBLIC_URL;
  if (connectionString && !/^postgres(ql)?:\/\//.test(connectionString)) connectionString=undefined;
  if (!connectionString && vars.RAILWAY_TCP_PROXY_DOMAIN && vars.RAILWAY_TCP_PROXY_PORT) {
    const url = new URL(`postgresql://${vars.RAILWAY_TCP_PROXY_DOMAIN}:${vars.RAILWAY_TCP_PROXY_PORT}`);
    url.username = vars.PGUSER ?? vars.POSTGRES_USER;
    url.password = vars.PGPASSWORD ?? vars.POSTGRES_PASSWORD;
    url.pathname = `/${vars.PGDATABASE ?? vars.POSTGRES_DB}`;
    connectionString = url.toString();
  }
  if (!connectionString) throw new Error('Public database endpoint unavailable; no private URL was exposed.');
}
if (!connectionString) throw new Error('A public DATABASE_URL is required, or use --railway.');
let client;
try {
  client = new pg.Client({connectionString, connectionTimeoutMillis:15_000});
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='120s'");
  const records = (await client.query(`SELECT id,chain,token,pool,kind,extract(epoch FROM at)*1000 AS at,data
    FROM chart_research_observations WHERE at < to_timestamp($1::double precision/1000) ORDER BY at,id`, [cutoff])).rows;
  const candles = (await client.query(`SELECT chain,pool,extract(epoch FROM at)*1000 AS at,open,high,low,close,volume
    FROM chart_candles WHERE at < to_timestamp($1::double precision/1000) ORDER BY chain,pool,at`, [cutoff])).rows;
  const histories = new Map();
  for (const c of candles) {
    const key = `${c.chain}:${c.pool}`, list = histories.get(key) ?? [];
    list.push({at:Number(c.at),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),volume:Number(c.volume)});
    histories.set(key,list);
  }
  await mkdir(root,{recursive:true});
  const gzip = createGzip({level:6}), output = createWriteStream(`${root}/paths.csv.gz`);
  gzip.pipe(output);
  const hash = createHash('sha256');
  const line = async s => { hash.update(s); if (!gzip.write(s)) await once(gzip,'drain'); };
  await line('id,bar_index,at,open,high,low,close,volume\n');
  const rows = []; let timingRejected = 0, missingEntry = 0, futureContext = 0, pathRows = 0;
  for (const r of records) {
    const at = Number(r.at), d = r.data ?? {}, f = d.features ?? d.setup?.features;
    if (!f || Number(f.at) !== at) { timingRejected++; continue; }
    if (Number(d.pair?.fetchedAt) > at) futureContext++;
    const path = (histories.get(`${r.chain}:${r.pool}`) ?? []).filter(c => c.at >= at && c.at < at + 6*3_600_000 + BAR);
    const entry = path.find(c => c.at === at);
    if (!entry) missingEntry++;
    const row = {id:r.id,source:r.kind === 'control' ? 'control' : 'signal',chain:r.chain,token:r.token,pool:r.pool,
      support_anchor:d.setup?.anchor ?? f.supportAnchor,detected_at:at,entry_price:entry?.open,signal_close:f.close,
      support_stop_price:Number.isFinite(f.supportLower) ? f.supportLower*.995 : null,atr14:f.atr14,...Object.fromEntries(features.map(key => [key,f[key]]))};
    rows.push(row);
    for (let i=0;i<path.length;i++) { const c=path[i]; await line([r.id,i,c.at,c.open,c.high,c.low,c.close,c.volume].join(',')+'\n'); pathRows++; }
  }
  gzip.end(); await finished(output);
  const text = columns.join(',')+'\n'+rows.map(r=>columns.map(k=>csv(r[k])).join(',')).join('\n')+'\n';
  await writeFile(`${root}/snapshot.csv`,text);
  const meta = {exported_at:new Date().toISOString(),cutoff:new Date(cutoff).toISOString(),rows:rows.length,observations_read:records.length,
    feature_timing_rejected:timingRejected,missing_exact_entry:missingEntry,late_discovery_context_excluded:futureContext,
    csv_sha256:digest(text),paths:{file:'paths.csv.gz',rows:pathRows,uncompressed_csv_sha256:hash.digest('hex')},
    source:'production read-only repeatable-read snapshot',git_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()};
  await writeFile(`${root}/snapshot.meta.json`,JSON.stringify(meta,null,2)+'\n');
  await client.query('COMMIT');
  console.log(JSON.stringify(meta,null,2));
} catch (error) {
  // Connection strings, passwords, and Railway output must not enter logs.
  console.error(`Read-only export failed (${error?.code ?? error?.name ?? 'unknown'}). No credentials were printed.`);
  process.exitCode=1;
} finally { if (client) await client.end(); }
