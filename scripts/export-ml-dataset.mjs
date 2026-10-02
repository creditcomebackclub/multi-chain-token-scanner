import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import pg from 'pg';
import { BAR } from '../dist/chart-pattern.js';
import { DAY } from '../dist/config.js';
import { learningFlags, ML_FEATURE_IDS, simulateCurrentPath, simulatePath, simulateTrade } from '../dist/chart-learning.js';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error('DATABASE_URL is required');
const outDir=path.resolve('research/ml/data');
const csvPath=path.join(outDir,'snapshot.csv'),metaPath=path.join(outDir,'snapshot.meta.json'),pathsPath=path.join(outDir,'paths.csv.gz'),gridPath=path.join(outDir,'exit-grid.csv.gz');
const client=new pg.Client({connectionString:databaseUrl});
const gitSha=()=>{
  if(process.env.ML_EXPORT_GIT_SHA)return process.env.ML_EXPORT_GIT_SHA;
  try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}
  catch{return process.env.RAILWAY_GIT_COMMIT_SHA??'unknown';}
};
const numeric=(value)=>typeof value==='number'&&Number.isFinite(value)?value:'';
const bool=(value)=>value===true?'true':value===false?'false':'';
const csv=(value)=>{const text=value===null||value===undefined?'':String(value);return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text;};
const simColumns=(prefix)=>[`${prefix}_sim_status`,`${prefix}_sim_net_return_pct`,`${prefix}_sim_net_return_pct_300bps`,`${prefix}_sim_entry_at`,`${prefix}_sim_exit_at`];
const ruleColumns=['rule_immediate','rule_greenHold','rule_greenHoldVolume','rule_qualityUnique','screen_hold','screen_greenHold','screen_holdVolume','screen_greenHoldVolume'];
const columns=['id','source','chain','token','pool','support_anchor','detected_at','entry_price','support_stop_price','atr14',...ML_FEATURE_IDS,'first_hit','label_resolved_at','y',...simColumns('immediate'),...simColumns('greenHold'),...ruleColumns];
const makeGzipWriter=(file)=>{const gzip=createGzip({level:9}),output=createWriteStream(file);gzip.pipe(output);return{gzip,output,hash:createHash('sha256'),rows:0};};
const writeLine=async(writer,line)=>{writer.hash.update(line);writer.rows++;if(!writer.gzip.write(line))await once(writer.gzip,'drain');};
const closeWriter=async writer=>{writer.gzip.end();await finished(writer.output);return writer.hash.digest('hex');};
const sameNumber=(a,b)=>a===b||(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-10);
const assertParity=(id,old,next)=>{
  if(!old&&!next)return;if(!old||!next)throw new Error(`Current-rule parity failed for ${id}: null mismatch`);
  const reason=old.status==='runner_breakeven'?'breakeven':old.status;
  if(next.exitReason!==reason||next.entryAt!==old.entryAt||next.exitAt!==old.exitAt||next.resolved!==old.resolved||!sameNumber(next.grossReturnPct,old.grossReturnPct)||!sameNumber(next.netReturnPct,old.netReturnPct))throw new Error(`Current-rule parity failed for ${id}`);
};
const structures=['half_runner','single_tp','trailing'],targets=[5,8,10,15],stops=['support','fixed3','fixed5','atr1_5'],times=[2,6,24],costs=[100,200,300];

await client.connect();
try{
  const observations=(await client.query(`
    SELECT o.id,o.chain,o.token,o.pool,extract(epoch FROM o.at)*1000 AS detected_at,o.kind,o.data,
      r.data AS outcome,s.decision,a.status AS alert_status
    FROM chart_research_observations o
    LEFT JOIN chart_research_outcomes r ON r.observation_id=o.id
    LEFT JOIN chart_signals s ON s.id=o.data->>'signalId'
    LEFT JOIN chart_setup_alerts a ON a.id=s.id AND a.status IN ('sent','unknown')
    ORDER BY o.at,o.id
  `)).rows;
  const minAt=Math.min(...observations.map(row=>Number(row.detected_at)).filter(Number.isFinite));
  const maxAt=Math.max(...observations.map(row=>Number(row.detected_at)).filter(Number.isFinite));
  const candleRows=Number.isFinite(minAt)?(await client.query(`
    SELECT chain,pool,extract(epoch FROM at)*1000 AS at,open,high,low,close,volume
    FROM chart_candles WHERE at >= to_timestamp($1::double precision/1000)-interval '5 minutes'
      AND at < to_timestamp($2::double precision/1000)+interval '25 hours' ORDER BY at
  `,[minAt,maxAt])).rows:[];
  const histories=new Map();
  for(const row of candleRows){const key=`${row.chain}:${row.pool}`,items=histories.get(key)??[];items.push({at:Number(row.at),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)});histories.set(key,items);}
  await mkdir(outDir,{recursive:true});
  const pathWriter=makeGzipWriter(pathsPath),gridWriter=makeGzipWriter(gridPath);
  await writeLine(pathWriter,'id,bar_index,at,open,high,low,close,volume\n');
  await writeLine(gridWriter,'id,rule_id,structure,tp1_pct,stop,time_hours,cost_bps,net_return_pct,gross_return_pct,exit_reason,exit_at,bars_held,resolved\n');
  const rows=[];let parityRows=0,skippedWithoutEntryBar=0;
  for(const record of observations){
    const at=Number(record.detected_at),data=record.data??{},features=data.features??{},setup=data.setup??null,outcome=record.outcome??null;
    const history=histories.get(`${record.chain}:${record.pool}`)??[];
    const signalCandle=history.find(candle=>candle.at===at-BAR),confirmationCandle=history.find(candle=>candle.at===at);
    const futureCandles=history.filter(candle=>candle.at>=at&&candle.at<at+25*60*60*1000),entryCandle=futureCandles.find(candle=>candle.at===at);
    if(!entryCandle){skippedWithoutEntryBar++;continue;}
    const supportLower=setup?.lower??features.supportLower;
    const compatSetup=setup??{at,anchor:features.supportAnchor??at,lower:supportLower??NaN,upper:features.supportUpper??NaN,price:entryCandle?.open??NaN,ema9:features.ema9??NaN,ema21:features.ema21??NaN,sma50:features.sma50??NaN,volumeRatio:features.volumeRatio??NaN,features};
    const learningRow={at,chain:record.chain,token:record.token,symbol:String(data.pair?.symbol??'?'),decision:String(record.decision??''),setup:compatSetup,outcome:undefined,signalCandle,confirmationCandle,futureCandles};
    const immediate200=learningRow?simulateTrade(learningRow,false,200):null,immediate300=learningRow?simulateTrade(learningRow,false,300):null;
    const green200=learningRow?simulateTrade(learningRow,true,200):null,green300=learningRow?simulateTrade(learningRow,true,300):null;
    const flags=setup?learningFlags(learningRow):{};
    assertParity(record.id,immediate200,simulateCurrentPath(learningRow,200));parityRows++;
    const firstHit=outcome?.firstHit??'';
    const hitTimes=[outcome?.tp1At,outcome?.stopAt].filter(value=>typeof value==='number'&&Number.isFinite(value));
    const resolvedAt=hitTimes.length?Math.min(...hitTimes):outcome?.complete?at+DAY:'';
    const row={id:record.id,source:record.kind==='control'?'control':record.alert_status?'alert':'signal',chain:record.chain,token:record.token,pool:record.pool,
      support_anchor:numeric(setup?.anchor??features.supportAnchor),detected_at:at,entry_price:numeric(entryCandle?.open),support_stop_price:numeric(supportLower==null?null:supportLower*.995),atr14:numeric(features.atr14??setup?.features?.atr14),first_hit:firstHit,label_resolved_at:resolvedAt,y:firstHit==='tp1'?1:firstHit==='stop'?0:'',
      immediate_sim_status:immediate200?.status??'',immediate_sim_net_return_pct:numeric(immediate200?.netReturnPct),immediate_sim_net_return_pct_300bps:numeric(immediate300?.netReturnPct),immediate_sim_entry_at:numeric(immediate200?.entryAt),immediate_sim_exit_at:numeric(immediate200?.exitAt),
      greenHold_sim_status:green200?.status??'',greenHold_sim_net_return_pct:numeric(green200?.netReturnPct),greenHold_sim_net_return_pct_300bps:numeric(green300?.netReturnPct),greenHold_sim_entry_at:numeric(green200?.entryAt),greenHold_sim_exit_at:numeric(green200?.exitAt)};
    for(const feature of ML_FEATURE_IDS)row[feature]=numeric(features[feature]??setup?.features?.[feature]);
    for(const column of ruleColumns)row[column]=column in flags?bool(flags[column]):'';
    rows.push(row);
    for(let index=0;index<futureCandles.length&&futureCandles[index].at<at+DAY;index++){
      const candle=futureCandles[index];await writeLine(pathWriter,[record.id,index,candle.at,candle.open,candle.high,candle.low,candle.close,candle.volume].map(csv).join(',')+'\n');
    }
    if(entryCandle){
      const input={chain:record.chain,token:record.token,entryAt:at,entryPrice:entryCandle.open,candles:futureCandles};
      for(const structure of structures)for(const tp1Pct of targets)for(const stop of stops)for(const timeHours of times)for(const costBps of costs){
        const ruleId=`${structure}|tp${tp1Pct}|${stop}|${timeHours}h|${costBps}bps`;
        const result=simulatePath(input,{structure,tp1Pct,stop,timeHours,costBps,supportStop:supportLower==null?null:supportLower*.995,atr14:features.atr14??null});
        if(result)await writeLine(gridWriter,[record.id,ruleId,structure,tp1Pct,stop,timeHours,costBps,result.netReturnPct,result.grossReturnPct,result.exitReason,result.exitAt,result.barsHeld,result.resolved].map(csv).join(',')+'\n');
      }
    }
  }
  const pathsSha256=await closeWriter(pathWriter),gridSha256=await closeWriter(gridWriter);
  const csvText=[columns.join(','),...rows.map(row=>columns.map(column=>csv(row[column])).join(','))].join('\n')+'\n';
  const tableNames=['chart_research_observations','chart_research_outcomes','chart_signals','chart_setup_alerts','chart_candles'];
  const tableCounts={};for(const table of tableNames)tableCounts[table]=Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const sourceCounts=Object.fromEntries([...new Set(rows.map(row=>row.source))].sort().map(source=>[source,rows.filter(row=>row.source===source).length]));
  const labelCounts=Object.fromEntries(['tp1','stop','ambiguous','unresolved'].map(label=>[label,rows.filter(row=>label==='unresolved'?!row.first_hit:row.first_hit===label).length]));
  await writeFile(csvPath,csvText);
  const metadata={schema_version:2,exported_at:new Date().toISOString(),git_sha:gitSha(),csv_sha256:createHash('sha256').update(csvText).digest('hex'),rows:rows.length,observations_skipped_without_entry_bar:skippedWithoutEntryBar,paths:{file:'paths.csv.gz',rows:pathWriter.rows-1,ids:rows.length,uncompressed_csv_sha256:pathsSha256,window_hours:24},exit_grid:{file:'exit-grid.csv.gz',rows:gridWriter.rows-1,uncompressed_csv_sha256:gridSha256,cells:structures.length*targets.length*stops.length*times.length*costs.length},parity:{rows_checked:parityRows,status:'passed'},source_counts:sourceCounts,label_counts:labelCounts,table_counts:tableCounts,feature_columns:ML_FEATURE_IDS,cost_scenarios_bps:costs,notes:['One canonical row per research observation with an exact next-bar entry candle; delivered signals use source=alert.','Observations without the exact entry bar are excluded rather than simulated with a later bar.','Every path begins at the next tradable five-minute bar at detected_at; grid entries use that bar open.','Controls are eligible non-signal candles from the selected-pair universe.','Wallet-watch, Telegram identity, and credentials are never queried.']};
  await writeFile(metaPath,JSON.stringify(metadata,null,2)+'\n');
  console.log(`Wrote ${rows.length} rows to ${csvPath}`);
  console.log(`SHA-256 ${metadata.csv_sha256}`);
  console.log(`Wrote ${metadata.paths.rows} path rows and ${metadata.exit_grid.rows} exit-grid rows; current-rule parity passed for ${parityRows} snapshot rows`);
}finally{await client.end();}
