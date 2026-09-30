import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { BAR } from '../dist/chart-pattern.js';
import { DAY } from '../dist/config.js';
import { learningFlags, ML_FEATURE_IDS, simulateTrade } from '../dist/chart-learning.js';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error('DATABASE_URL is required');
const outDir=path.resolve('research/ml/data');
const csvPath=path.join(outDir,'snapshot.csv'),metaPath=path.join(outDir,'snapshot.meta.json');
const client=new pg.Client({connectionString:databaseUrl});
const numeric=(value)=>typeof value==='number'&&Number.isFinite(value)?value:'';
const bool=(value)=>value===true?'true':value===false?'false':'';
const csv=(value)=>{const text=value===null||value===undefined?'':String(value);return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text;};
const simColumns=(prefix)=>[`${prefix}_sim_status`,`${prefix}_sim_net_return_pct`,`${prefix}_sim_net_return_pct_300bps`,`${prefix}_sim_entry_at`,`${prefix}_sim_exit_at`];
const ruleColumns=['rule_immediate','rule_greenHold','rule_greenHoldVolume','rule_qualityUnique','screen_hold','screen_greenHold','screen_holdVolume','screen_greenHoldVolume'];
const columns=['id','source','chain','token','pool','support_anchor','detected_at',...ML_FEATURE_IDS,'first_hit','label_resolved_at','y',...simColumns('immediate'),...simColumns('greenHold'),...ruleColumns];

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
    FROM chart_candles WHERE at >= to_timestamp($1/1000)-interval '5 minutes'
      AND at < to_timestamp($2/1000)+interval '25 hours' ORDER BY at
  `,[minAt,maxAt])).rows:[];
  const histories=new Map();
  for(const row of candleRows){const key=`${row.chain}:${row.pool}`,items=histories.get(key)??[];items.push({at:Number(row.at),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)});histories.set(key,items);}
  const rows=[];
  for(const record of observations){
    const at=Number(record.detected_at),data=record.data??{},features=data.features??{},setup=data.setup??null,outcome=record.outcome??null;
    const history=histories.get(`${record.chain}:${record.pool}`)??[];
    const signalCandle=history.find(candle=>candle.at===at-BAR),confirmationCandle=history.find(candle=>candle.at===at);
    const learningRow=setup?{at,chain:record.chain,token:record.token,symbol:String(data.pair?.symbol??'?'),decision:String(record.decision??''),setup,outcome:undefined,signalCandle,confirmationCandle,futureCandles:history.filter(candle=>candle.at>=at&&candle.at<at+25*60*60*1000)}:null;
    const immediate200=learningRow?simulateTrade(learningRow,false,200):null,immediate300=learningRow?simulateTrade(learningRow,false,300):null;
    const green200=learningRow?simulateTrade(learningRow,true,200):null,green300=learningRow?simulateTrade(learningRow,true,300):null;
    const flags=learningRow?learningFlags(learningRow):{};
    const firstHit=outcome?.firstHit??'';
    const hitTimes=[outcome?.tp1At,outcome?.stopAt].filter(value=>typeof value==='number'&&Number.isFinite(value));
    const resolvedAt=hitTimes.length?Math.min(...hitTimes):outcome?.complete?at+DAY:'';
    const row={id:record.id,source:record.kind==='control'?'control':record.alert_status?'alert':'signal',chain:record.chain,token:record.token,pool:record.pool,
      support_anchor:numeric(setup?.anchor??features.supportAnchor),detected_at:at,first_hit:firstHit,label_resolved_at:resolvedAt,y:firstHit==='tp1'?1:firstHit==='stop'?0:'',
      immediate_sim_status:immediate200?.status??'',immediate_sim_net_return_pct:numeric(immediate200?.netReturnPct),immediate_sim_net_return_pct_300bps:numeric(immediate300?.netReturnPct),immediate_sim_entry_at:numeric(immediate200?.entryAt),immediate_sim_exit_at:numeric(immediate200?.exitAt),
      greenHold_sim_status:green200?.status??'',greenHold_sim_net_return_pct:numeric(green200?.netReturnPct),greenHold_sim_net_return_pct_300bps:numeric(green300?.netReturnPct),greenHold_sim_entry_at:numeric(green200?.entryAt),greenHold_sim_exit_at:numeric(green200?.exitAt)};
    for(const feature of ML_FEATURE_IDS)row[feature]=numeric(features[feature]??setup?.features?.[feature]);
    for(const column of ruleColumns)row[column]=column in flags?bool(flags[column]):'';
    rows.push(row);
  }
  const csvText=[columns.join(','),...rows.map(row=>columns.map(column=>csv(row[column])).join(','))].join('\n')+'\n';
  const tableNames=['chart_research_observations','chart_research_outcomes','chart_signals','chart_setup_alerts','chart_candles'];
  const tableCounts={};for(const table of tableNames)tableCounts[table]=Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const sourceCounts=Object.fromEntries([...new Set(rows.map(row=>row.source))].sort().map(source=>[source,rows.filter(row=>row.source===source).length]));
  const labelCounts=Object.fromEntries(['tp1','stop','ambiguous','unresolved'].map(label=>[label,rows.filter(row=>label==='unresolved'?!row.first_hit:row.first_hit===label).length]));
  await mkdir(outDir,{recursive:true});await writeFile(csvPath,csvText);
  const metadata={schema_version:1,exported_at:new Date().toISOString(),git_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),csv_sha256:createHash('sha256').update(csvText).digest('hex'),rows:rows.length,source_counts:sourceCounts,label_counts:labelCounts,table_counts:tableCounts,feature_columns:ML_FEATURE_IDS,cost_scenarios_bps:[200,300],notes:['One canonical row per research observation; delivered signals use source=alert.','Controls are eligible non-signal candles from the selected-pair universe.','Wallet-watch, Telegram identity, and credentials are never queried.']};
  await writeFile(metaPath,JSON.stringify(metadata,null,2)+'\n');
  console.log(`Wrote ${rows.length} rows to ${csvPath}`);
  console.log(`SHA-256 ${metadata.csv_sha256}`);
}finally{await client.end();}
