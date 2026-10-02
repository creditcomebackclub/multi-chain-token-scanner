import type { AlertOutcome } from './chart-monitor.js';
import { BAR, type Candle, type Setup } from './chart-pattern.js';
import { DAY } from './config.js';

export type LearningRow = {
  at: number; chain: string; token: string; symbol: string; decision: string; setup: Setup;
  outcome?: AlertOutcome; signalCandle?: Candle; confirmationCandle?: Candle; futureCandles?: Candle[];
};
export type FeatureComparison = { id:string; label:string; winnerMedian:number|null; loserMedian:number|null; winnerCount:number; loserCount:number };
export type ConfirmationScreen = { id:string; label:string; evaluated:number; passed:number; winnersKept:number; winnersMissed:number; lossesKept:number; lossesAvoided:number; passWinRate:number|null };
export type ShadowVariant = {
  id:string; label:string; eligible:number; duplicateSkipped:number; trades:number; resolved:number; open:number;
  wins:number; losses:number; winRate:number|null; tp2:number; runnerBreakeven:number;
  averageGrossReturnPct:number|null; averageNetReturnPct:number|null; netPnlUsd:number;
  endingBalanceUsd:number; maxDrawdownUsd:number; maxDrawdownPct:number; profitFactor:number|null;
  byChain:Record<string,{resolved:number;wins:number;losses:number;netPnlUsd:number}>;
};
// Locked before deployment so this cohort can never absorb the history that suggested it.
export const ETHEREUM_FORWARD_START = Date.parse('2026-09-28T18:15:00Z');
export type ChartLearning = {
  total:number; resolved:number; wins:number; losses:number; baselineWinRate:number|null;
  modeledGrossExpectancyPct:number|null; averageWinnerTargetPct:number|null; averageLoserStopPct:number|null;
  medianWinnerMfePct:number|null; medianLoserMaePct:number|null; features:FeatureComparison[];
  failureTags:Record<string,number>; screens:ConfirmationScreen[]; leadingScreen:ConfirmationScreen|null;
  confirmationCoverage:number; promotionReady:boolean;
  shadow:{costBps:number;positionUsd:number;startingBalanceUsd:number;ethereumForwardStartAt:number;variants:ShadowVariant[]};
  chains:Record<string,{resolved:number;wins:number;losses:number;winRate:number}>;
  recentResolved:{at:number;chain:string;symbol:string;result:'win'|'loss';tags:string[]}[];
};

const median=(values:number[])=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;const m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;};
const percent=(value:number|null|undefined)=>value==null?value:value*100;
const finite=(value:number|null|undefined):value is number=>typeof value==='number'&&Number.isFinite(value);
const mean=(values:number[])=>{const valid=values.filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;};
const result=(row:LearningRow):'win'|'loss'|null=>row.outcome?.firstHit==='tp1'?'win':row.outcome?.firstHit==='stop'?'loss':null;
const features:{id:string;label:string;value:(row:LearningRow)=>number|null|undefined}[]=[
  {id:'volumeRatio',label:'signal volume ratio',value:r=>r.setup.features?.volumeRatio??r.setup.volumeRatio},
  {id:'riskPct',label:'planned risk %',value:r=>r.setup.features?.riskPct},
  {id:'atrPct',label:'ATR %',value:r=>r.setup.features?.atrPct},
  {id:'bodyPct',label:'candle body % of range',value:r=>percent(r.setup.features?.bodyPct)},
  {id:'closePosition',label:'close position %',value:r=>percent(r.setup.features?.closePosition)},
  {id:'upperWickPct',label:'upper wick % of range',value:r=>percent(r.setup.features?.upperWickPct)},
  {id:'lowerWickPct',label:'lower wick % of range',value:r=>percent(r.setup.features?.lowerWickPct)},
  {id:'ema9SlopePct',label:'EMA9 slope %',value:r=>r.setup.features?.ema9SlopePct},
  {id:'ema21SlopePct',label:'EMA21 slope %',value:r=>r.setup.features?.ema21SlopePct},
  {id:'priceToEma9Pct',label:'price above EMA9 %',value:r=>r.setup.features?.priceToEma9Pct},
  {id:'ema9ToEma21Pct',label:'EMA9 vs EMA21 %',value:r=>r.setup.features?.ema9ToEma21Pct},
  {id:'priceToSma50Pct',label:'price vs SMA50 %',value:r=>r.setup.features?.priceToSma50Pct},
  {id:'priorPeakDrawdownPct',label:'drawdown from prior peak %',value:r=>r.setup.features?.priorPeakDrawdownPct},
  {id:'supportTestCount',label:'support tests',value:r=>r.setup.features?.supportTestCount},
  {id:'supportTouchAgeBars',label:'bars since support touch',value:r=>r.setup.features?.supportTouchAgeBars},
];
export const ML_FEATURE_IDS=features.map(feature=>feature.id);

export function failureTags(row:LearningRow):string[]{
  const signal=row.signalCandle,next=row.confirmationCandle,entry=row.setup.price;if(!next)return['next candle unavailable'];const tags:string[]=[];
  if(next.close<=next.open)tags.push('next candle red');
  if(next.close<entry)tags.push('next close below signal entry');
  if(signal&&next.close<(signal.open+signal.close)/2)tags.push('lost signal-candle midpoint');
  if(signal?.volume&&next.volume/signal.volume<.35)tags.push('next-candle volume collapsed');
  if(next.close<row.setup.upper)tags.push('fell back below support-zone top');
  return tags.length?tags:['no immediate confirmation failure'];
}
export const screenDefinitions=[
  {id:'hold',label:'next close holds within 0.5% of signal entry',pass:(r:LearningRow)=>r.confirmationCandle!.close>=r.setup.price*.995},
  {id:'greenHold',label:'next candle is green and holds within 0.5%',pass:(r:LearningRow)=>r.confirmationCandle!.close>=r.setup.price*.995&&r.confirmationCandle!.close>r.confirmationCandle!.open},
  {id:'holdVolume',label:'next close holds and retains 35% of signal volume',pass:(r:LearningRow)=>r.confirmationCandle!.close>=r.setup.price*.995&&!!r.signalCandle?.volume&&r.confirmationCandle!.volume>=r.signalCandle!.volume*.35},
  {id:'greenHoldVolume',label:'next candle is green, holds, and retains 35% volume',pass:(r:LearningRow)=>r.confirmationCandle!.close>=r.setup.price*.995&&r.confirmationCandle!.close>r.confirmationCandle!.open&&!!r.signalCandle?.volume&&r.confirmationCandle!.volume>=r.signalCandle!.volume*.35},
];

export type SimulatedTrade={chain:string;token:string;entryAt:number;exitAt:number;status:'tp2'|'runner_breakeven'|'stop'|'time'|'open';grossReturnPct:number;netReturnPct:number;resolved:boolean};
export type ExitStructure='half_runner'|'single_tp'|'trailing';
export type ExitStop='support'|'fixed3'|'fixed5'|'atr1_5';
export type PathExitReason='tp'|'tp2'|'trail'|'stop'|'breakeven'|'time'|'open';
export type PathSimulationConfig={
  structure:ExitStructure;tp1Pct:number;stop:ExitStop;timeHours:number;costBps:number;
  supportStop:number|null;atr14:number|null;
};
export type PathSimulationInput={chain:string;token:string;entryAt:number;entryPrice:number;candles:Candle[]};
export type PathSimulationResult={chain:string;token:string;entryAt:number;exitAt:number;exitReason:PathExitReason;
  grossReturnPct:number;netReturnPct:number;resolved:boolean;barsHeld:number;exitPrice:number};

const pathResult=(input:PathSimulationInput,config:PathSimulationConfig,exitAt:number,exitReason:PathExitReason,
  grossReturnPct:number,resolved:boolean,barsHeld:number,exitPrice:number):PathSimulationResult=>({
  chain:input.chain,token:input.token,entryAt:input.entryAt,exitAt,exitReason,grossReturnPct,
  netReturnPct:grossReturnPct-config.costBps/100,resolved,barsHeld,exitPrice,
});

/**
 * Point-in-time OHLC path simulator used by offline research. Candles must begin
 * with the next tradable bar and entryPrice must be that bar's open. Stops are
 * checked before targets on every bar, including activation bars.
 */
export function simulatePath(input:PathSimulationInput,config:PathSimulationConfig):PathSimulationResult|null{
  const {entryPrice:entry,entryAt}=input;
  const stop=config.stop==='support'?config.supportStop
    :config.stop==='fixed3'?entry*.97
    :config.stop==='fixed5'?entry*.95
    :finite(config.atr14)&&config.atr14!>0?entry-1.5*config.atr14!:null;
  if(!finite(entry)||entry<=0||!finite(entryAt)||!finite(stop)||stop!<=0||stop!>=entry)return null;
  if(config.structure==='trailing'&&(!finite(config.atr14)||config.atr14!<=0))return null;
  const target=entry*(1+config.tp1Pct/100),tp2=entry*(1+config.tp1Pct/50);
  const end=entryAt+config.timeHours*60*60*1000;
  const path=input.candles.filter(c=>c.at>=entryAt&&c.at<end).sort((a,b)=>a.at-b.at);
  if(!path.length)return null;
  let activated=false,trail=stop!;
  for(let index=0;index<path.length;index++){
    const candle=path[index],bars=index+1;
    if(!activated){
      if(candle.low<=stop!){const exit=Math.min(stop!,candle.open);return pathResult(input,config,candle.at+BAR,'stop',(exit/entry-1)*100,true,bars,exit);}
      if(candle.high<target)continue;
      if(config.structure==='single_tp')return pathResult(input,config,candle.at+BAR,'tp',config.tp1Pct,true,bars,target);
      activated=true;
      if(config.structure==='half_runner'){
        if(candle.low<=entry)return pathResult(input,config,candle.at+BAR,'breakeven',config.tp1Pct/2,true,bars,entry);
        if(candle.high>=tp2)return pathResult(input,config,candle.at+BAR,'tp2',config.tp1Pct*1.5,true,bars,tp2);
      }else{
        trail=Math.max(stop!,candle.high-config.atr14!);
        if(candle.low<=trail){const runner=trail;const gross=(config.tp1Pct+(runner/entry-1)*100)/2;return pathResult(input,config,candle.at+BAR,'trail',gross,true,bars,runner);}
      }
    }else if(config.structure==='half_runner'){
      if(candle.low<=entry)return pathResult(input,config,candle.at+BAR,'breakeven',config.tp1Pct/2,true,bars,entry);
      if(candle.high>=tp2)return pathResult(input,config,candle.at+BAR,'tp2',config.tp1Pct*1.5,true,bars,tp2);
    }else{
      const activeTrail=trail;
      if(candle.low<=activeTrail){const runner=Math.min(activeTrail,candle.open);const gross=(config.tp1Pct+(runner/entry-1)*100)/2;return pathResult(input,config,candle.at+BAR,'trail',gross,true,bars,runner);}
      trail=Math.max(trail,candle.high-config.atr14!);
    }
  }
  const last=path.at(-1)!,complete=last.at+BAR>=end;
  const gross=activated&&config.structure!=='single_tp'?(config.tp1Pct+(last.close/entry-1)*100)/2:(last.close/entry-1)*100;
  return pathResult(input,config,last.at+BAR,complete?'time':'open',gross,complete,path.length,last.close);
}

/** Exact adapter for the currently deployed immediate half-TP1 shadow rule. */
export function simulateCurrentPath(row:LearningRow,costBps:number):PathSimulationResult|null{
  const result=simulatePath({chain:row.chain,token:row.token,entryAt:row.at,entryPrice:row.setup.price,candles:row.futureCandles??[]},{
    structure:'half_runner',tp1Pct:5,stop:'support',timeHours:24,costBps,supportStop:row.setup.lower*.995,atr14:row.setup.features?.atr14??null,
  });
  return result;
}
export const shadowDefinitions=[
  {id:'immediate',label:'Immediate signal entry',confirm:false,dedupe:false,pass:(_r:LearningRow)=>true},
  {id:'greenHold',label:'Next candle green + holds within 0.5%',confirm:true,dedupe:false,pass:(r:LearningRow)=>!!r.confirmationCandle&&r.confirmationCandle.close>=r.setup.price*.995&&r.confirmationCandle.close>r.confirmationCandle.open},
  {id:'greenHoldVolume',label:'Green hold + retains 35% signal volume',confirm:true,dedupe:false,pass:(r:LearningRow)=>!!r.confirmationCandle&&r.confirmationCandle.close>=r.setup.price*.995&&r.confirmationCandle.close>r.confirmationCandle.open&&!!r.signalCandle?.volume&&r.confirmationCandle.volume>=r.signalCandle.volume*.35},
  {id:'qualityUnique',label:'Green-volume hold + 2× signal volume + one trade per support',confirm:true,dedupe:true,pass:(r:LearningRow)=>!!r.confirmationCandle&&r.confirmationCandle.close>=r.setup.price*.995&&r.confirmationCandle.close>r.confirmationCandle.open&&!!r.signalCandle?.volume&&r.confirmationCandle.volume>=r.signalCandle.volume*.35&&r.setup.volumeRatio>=2},
  {id:'ethereumForward',label:'Ethereum-only forward cohort (locked Sep 28)',confirm:false,dedupe:false,pass:(r:LearningRow)=>r.chain==='ethereum'&&r.at>=ETHEREUM_FORWARD_START},
];

export function simulateTrade(row:LearningRow,confirm:boolean,costBps:number):SimulatedTrade|null{
  const confirmation=row.confirmationCandle;
  if(confirm&&!confirmation)return null;
  const entry=confirm?confirmation!.close:row.setup.price,entryAt=confirm?confirmation!.at+BAR:row.at,stop=row.setup.lower*.995;
  if(![entry,entryAt,stop].every(Number.isFinite)||entry<=0||stop<=0||stop>=entry)return null;
  const tp1=entry*1.05,tp2=entry*1.10,end=entryAt+DAY;
  const candles=(row.futureCandles??[]).filter(c=>c.at>=entryAt&&c.at<end).sort((a,b)=>a.at-b.at);
  if(!candles.length)return null;
  let halfSold=false;
  for(const candle of candles){
    if(!halfSold){
      const hitStop=candle.low<=stop,hitTp1=candle.high>=tp1;
      if(hitStop){const exit=Math.min(stop,candle.open),gross=(exit/entry-1)*100;return{chain:row.chain,token:row.token,entryAt,exitAt:candle.at+BAR,status:'stop',grossReturnPct:gross,netReturnPct:gross-costBps/100,resolved:true};}
      if(hitTp1){
        halfSold=true;
        // With only OHLC, count a same-bar TP2/breakeven conflict conservatively as breakeven.
        if(candle.low<=entry)return{chain:row.chain,token:row.token,entryAt,exitAt:candle.at+BAR,status:'runner_breakeven',grossReturnPct:2.5,netReturnPct:2.5-costBps/100,resolved:true};
        if(candle.high>=tp2)return{chain:row.chain,token:row.token,entryAt,exitAt:candle.at+BAR,status:'tp2',grossReturnPct:7.5,netReturnPct:7.5-costBps/100,resolved:true};
      }
    }else{
      if(candle.low<=entry)return{chain:row.chain,token:row.token,entryAt,exitAt:candle.at+BAR,status:'runner_breakeven',grossReturnPct:2.5,netReturnPct:2.5-costBps/100,resolved:true};
      if(candle.high>=tp2)return{chain:row.chain,token:row.token,entryAt,exitAt:candle.at+BAR,status:'tp2',grossReturnPct:7.5,netReturnPct:7.5-costBps/100,resolved:true};
    }
  }
  const last=candles.at(-1)!,complete=last.at+BAR>=end;
  const gross=halfSold?2.5+.5*(last.close/entry-1)*100:(last.close/entry-1)*100;
  return{chain:row.chain,token:row.token,entryAt,exitAt:last.at+BAR,status:complete?'time':'open',grossReturnPct:gross,netReturnPct:gross-costBps/100,resolved:complete};
}

export function learningFlags(row:LearningRow):Record<string,boolean>{
  const flags:Record<string,boolean>={};
  for(const definition of shadowDefinitions.filter(item=>item.id!=='ethereumForward'))flags[`rule_${definition.id}`]=definition.pass(row);
  for(const screen of screenDefinitions)flags[`screen_${screen.id}`]=!!row.confirmationCandle&&screen.pass(row);
  return flags;
}

function summarizeShadow(rows:LearningRow[],costBps:number):ShadowVariant[]{
  const positionUsd=50,startingBalanceUsd=1_000;
  return shadowDefinitions.map(definition=>{
    const seen=new Set<string>(),trades:SimulatedTrade[]=[];let eligible=0,duplicateSkipped=0;
    for(const row of rows.slice().sort((a,b)=>a.at-b.at)){
      if(!definition.pass(row))continue;eligible++;
      const identity=`${row.chain}:${row.token}:${row.setup.anchor}`;
      if(definition.dedupe&&seen.has(identity)){duplicateSkipped++;continue;}
      if(definition.dedupe)seen.add(identity);
      const trade=simulateTrade(row,definition.confirm,costBps);if(trade)trades.push(trade);
    }
    const resolved=trades.filter(t=>t.resolved),wins=resolved.filter(t=>t.netReturnPct>0),losses=resolved.filter(t=>t.netReturnPct<0);
    const pnl=resolved.map(t=>positionUsd*t.netReturnPct/100),netPnlUsd=pnl.reduce((sum,value)=>sum+value,0);
    let balance=startingBalanceUsd,peak=balance,maxDrawdownUsd=0,maxDrawdownPct=0;
    for(const trade of resolved.slice().sort((a,b)=>a.exitAt-b.exitAt)){balance+=positionUsd*trade.netReturnPct/100;peak=Math.max(peak,balance);const dd=peak-balance;maxDrawdownUsd=Math.max(maxDrawdownUsd,dd);maxDrawdownPct=Math.max(maxDrawdownPct,peak?dd/peak*100:0);}
    const gains=pnl.filter(v=>v>0).reduce((s,v)=>s+v,0),loss=Math.abs(pnl.filter(v=>v<0).reduce((s,v)=>s+v,0));
    const byChain=Object.fromEntries([...new Set(resolved.map(t=>t.chain))].map(chain=>{const values=resolved.filter(t=>t.chain===chain),w=values.filter(t=>t.netReturnPct>0).length;return[chain,{resolved:values.length,wins:w,losses:values.filter(t=>t.netReturnPct<0).length,netPnlUsd:values.reduce((s,t)=>s+positionUsd*t.netReturnPct/100,0)}];}));
    return{id:definition.id,label:definition.label,eligible,duplicateSkipped,trades:trades.length,resolved:resolved.length,open:trades.length-resolved.length,wins:wins.length,losses:losses.length,
      winRate:resolved.length?wins.length/resolved.length*100:null,tp2:resolved.filter(t=>t.status==='tp2').length,runnerBreakeven:resolved.filter(t=>t.status==='runner_breakeven').length,
      averageGrossReturnPct:mean(resolved.map(t=>t.grossReturnPct)),averageNetReturnPct:mean(resolved.map(t=>t.netReturnPct)),netPnlUsd,endingBalanceUsd:startingBalanceUsd+netPnlUsd,
      maxDrawdownUsd,maxDrawdownPct,profitFactor:loss?gains/loss:gains?Infinity:null,byChain};
  });
}

export function analyzeChartLearning(rows:LearningRow[],costBps=200):ChartLearning{
  const resolved=rows.filter(row=>result(row)),winners=resolved.filter(row=>result(row)==='win'),losers=resolved.filter(row=>result(row)==='loss');
  const comparisons=features.map(feature=>{const w=winners.map(feature.value).filter(finite),l=losers.map(feature.value).filter(finite);return{id:feature.id,label:feature.label,winnerMedian:median(w),loserMedian:median(l),winnerCount:w.length,loserCount:l.length};});
  const tagCounts:Record<string,number>={};for(const row of losers)for(const tag of failureTags(row))tagCounts[tag]=(tagCounts[tag]??0)+1;
  const evaluable=resolved.filter(row=>row.confirmationCandle);
  const screens=screenDefinitions.map(screen=>{const passed=evaluable.filter(screen.pass),keptWins=passed.filter(row=>result(row)==='win').length,keptLosses=passed.filter(row=>result(row)==='loss').length;return{id:screen.id,label:screen.label,evaluated:evaluable.length,passed:passed.length,winnersKept:keptWins,winnersMissed:winners.filter(row=>row.confirmationCandle&&!screen.pass(row)).length,lossesKept:keptLosses,lossesAvoided:losers.filter(row=>row.confirmationCandle&&!screen.pass(row)).length,passWinRate:passed.length?keptWins/passed.length*100:null};});
  const leadingScreen=screens.slice().sort((a,b)=>(b.lossesAvoided-b.winnersMissed)-(a.lossesAvoided-a.winnersMissed)||(b.passWinRate??-1)-(a.passWinRate??-1))[0]??null;
  const chains=Object.fromEntries([...new Set(resolved.map(row=>row.chain))].map(chain=>{const values=resolved.filter(row=>row.chain===chain),wins=values.filter(row=>result(row)==='win').length;return[chain,{resolved:values.length,wins,losses:values.length-wins,winRate:wins/values.length*100}];}));
  return{total:rows.length,resolved:resolved.length,wins:winners.length,losses:losers.length,baselineWinRate:resolved.length?winners.length/resolved.length*100:null,
    modeledGrossExpectancyPct:mean(resolved.map(row=>row.outcome?((result(row)==='win'?row.outcome.tp1:row.outcome.stop)/row.outcome.entry-1)*100:NaN)),
    averageWinnerTargetPct:mean(winners.map(row=>row.outcome?(row.outcome.tp1/row.outcome.entry-1)*100:NaN)),
    averageLoserStopPct:mean(losers.map(row=>row.outcome?(row.outcome.stop/row.outcome.entry-1)*100:NaN)),
    medianWinnerMfePct:median(winners.map(row=>row.outcome?(row.outcome.maxPrice/row.outcome.entry-1)*100:NaN)),medianLoserMaePct:median(losers.map(row=>row.outcome?(row.outcome.minPrice/row.outcome.entry-1)*100:NaN)),
    features:comparisons,failureTags:Object.fromEntries(Object.entries(tagCounts).sort((a,b)=>b[1]-a[1])),screens,leadingScreen,confirmationCoverage:evaluable.length,promotionReady:resolved.length>=50&&evaluable.length>=40,
    shadow:{costBps,positionUsd:50,startingBalanceUsd:1_000,ethereumForwardStartAt:ETHEREUM_FORWARD_START,variants:summarizeShadow(rows,costBps)},chains,
    recentResolved:resolved.slice().sort((a,b)=>b.at-a.at).slice(0,5).map(row=>({at:row.at,chain:row.chain,symbol:row.symbol,result:result(row)!,tags:result(row)==='loss'?failureTags(row):[]}))};
}
