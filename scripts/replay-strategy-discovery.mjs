import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, rename } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { simulatePath } from '../src/chart-learning.ts';

export const BAR=300_000;
export const EXITS=[
  {id:'scalp',structure:'single_tp',tp1Pct:10,stop:'fixed3',timeHours:2},
  {id:'runner',structure:'half_runner',tp1Pct:10,stop:'fixed5',timeHours:6},
  {id:'trail',structure:'trailing',tp1Pct:8,stop:'fixed3',timeHours:6},
];

export function parseCsvLine(line) {
  const fields=[]; let value='',quoted=false;
  for(let i=0;i<line.length;i++) {
    const c=line[i];
    if(c==='"') { if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted; }
    else if(c===','&&!quoted){fields.push(value);value='';}else value+=c;
  }
  if(quoted)throw new Error('Unclosed CSV quote');
  fields.push(value);return fields;
}
const valid=c=>Number.isFinite(c.at)&&c.at%BAR===0&&[c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)
  &&Math.min(c.open,c.high,c.low,c.close)>0&&c.volume>=0&&c.low<=Math.min(c.open,c.close)&&c.high>=Math.max(c.open,c.close);

export function replayObservation(row,candles) {
  const output=[];
  for(const delay of [0,1]) {
    const entryAt=Number(row.detected_at)+delay*BAR;
    const sorted=candles.filter(c=>c.at>=entryAt).sort((a,b)=>a.at-b.at);
    const prefix=[];let expected=entryAt;
    for(const candle of sorted) { if(candle.at!==expected||!valid(candle))break;prefix.push(candle);expected+=BAR; }
    for(const exit of EXITS) {
      const entry=prefix[0]?.open;
      const result=entry?simulatePath({chain:row.chain,token:row.token,entryAt,entryPrice:entry,candles:prefix},
        {...exit,costBps:200,supportStop:null,atr14:Number(row.atr14)}):null;
      output.push({id:row.id,exit:exit.id,delay_bars:delay,entry_at:entryAt,entry_price:entry??null,
        gross_return_pct:result?.resolved?result.grossReturnPct:null,net_return_pct:result?.resolved?result.netReturnPct:null,
        resolved:result?.resolved??false,exit_at:result?.resolved?result.exitAt:entryAt+exit.timeHours*3_600_000,
        exit_reason:result?.exitReason??'missing_entry',contiguous_bars:prefix.length,held_bars:result?.barsHeld??0});
    }
  }
  return output;
}

export async function replayDataset(snapshotFile,pathsFile,outputFile) {
  const meta=JSON.parse(await readFile(path.join(path.dirname(snapshotFile),'snapshot.meta.json'),'utf8'));
  const text=await readFile(snapshotFile,'utf8');
  const snapshotHash=createHash('sha256').update(text).digest('hex');
  if(snapshotHash!==meta.csv_sha256)throw new Error('Snapshot SHA-256 mismatch');
  const lines=text.trimEnd().split(/\r?\n/),header=parseCsvLine(lines.shift());
  const rows=new Map(lines.map(line=>{const values=parseCsvLine(line);const row=Object.fromEntries(header.map((key,i)=>[key,values[i]]));return[row.id,row];}));
  await mkdir(path.dirname(outputFile),{recursive:true});
  const writer=createWriteStream(`${outputFile}.part`);
  const columns=['id','exit','delay_bars','entry_at','entry_price','gross_return_pct','net_return_pct','resolved','exit_at','exit_reason','contiguous_bars','held_bars'];
  writer.write(columns.join(',')+'\n');
  let current,group=[],written=0;const seen=new Set(),hash=createHash('sha256');
  const flush=async()=>{
    if(!current)return;
    if(seen.has(current))throw new Error('Path IDs must be contiguous groups');
    seen.add(current);
    const row=rows.get(current);if(!row)return;
    for(const result of replayObservation(row,group)) { if(!writer.write(columns.map(k=>result[k]??'').join(',')+'\n'))await once(writer,'drain');written++; }
  };
  const stream=createReadStream(pathsFile).pipe(createGunzip()).pipe(new Transform({transform(chunk,_encoding,done){hash.update(chunk);done(null,chunk);}}));
  let first=true;
  for await(const line of createInterface({input:stream,crlfDelay:Infinity})) {
    if(first){first=false;if(line!=='id,bar_index,at,open,high,low,close,volume')throw new Error('Unsupported paths header');continue;}
    const [id,,at,open,high,low,close,volume]=parseCsvLine(line);
    if(id!==current){await flush();current=id;group=[];}
    group.push({at:Number(at),open:Number(open),high:Number(high),low:Number(low),close:Number(close),volume:Number(volume)});
  }
  await flush();
  for(const [id,row] of rows)if(!seen.has(id))for(const result of replayObservation(row,[])){if(!writer.write(columns.map(k=>result[k]??'').join(',')+'\n'))await once(writer,'drain');written++;}
  writer.end();await finished(writer);
  const pathsHash=hash.digest('hex');
  if(pathsHash!==meta.paths.uncompressed_csv_sha256)throw new Error('Paths SHA-256 mismatch; results remain unpublished .part');
  await rename(`${outputFile}.part`,outputFile);
  console.log(`Verified snapshot and paths; replayed ${rows.size} observations into ${written} exit/delay rows.`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [snapshot,paths,out]=process.argv.slice(2);
  if(!snapshot||!paths||!out)throw new Error('Usage: node --import tsx scripts/replay-strategy-discovery.mjs SNAPSHOT PATHS OUTPUT');
  await replayDataset(snapshot,paths,out);
}
