import { DAY } from './config.js';
import type { Candle, ResearchFeatures } from './chart-pattern.js';
import { simulatePath, type PathSimulationResult } from './chart-learning.js';

export const SHADOW_LOCKED_START = Date.parse('2026-10-03T14:33:12Z');
export const SHADOW_REQUIRED_SIGNALS = 180;
export const SHADOW_REQUIRED_DAYS = 20;

export type ForwardShadowVariant = {
  id:string; label:string; lockedStart:number; requiredSignals:number; requiredDays:number;
};

export const forwardShadowVariants:ForwardShadowVariant[]=[{
  id:'trailing-tp8-fixed3-24h-v1',
  label:'Trailing · TP1 +8% · fixed 3% · 24h',
  lockedStart:SHADOW_LOCKED_START,
  requiredSignals:SHADOW_REQUIRED_SIGNALS,
  requiredDays:SHADOW_REQUIRED_DAYS,
}];

export type ShadowOutcome=PathSimulationResult&{
  population:'signal'|'control'; observationAt:number; costBps:number; costSource:'modeled'|'logged_real';
};

export type Interval={low:number;high:number;blocks:number};
export type ShadowProgress={
  id:string;label:string;lockedStart:number;requiredSignals:number;requiredDays:number;
  resolvedSignals:number;resolvedControls:number;signalDays:number;controlDays:number;sharedDays:number;
  signalExpectancyPct:number|null;signalInterval:Interval|null;
  controlExpectancyPct:number|null;controlInterval:Interval|null;
  edgePct:number|null;edgeInterval:Interval|null;realCostSignals:number;
  costStatus:'logged real'|'modeled only';eligible:boolean;blockers:string[];
};

export function simulateForwardShadow(
  variantId:string,
  observation:{at:number;chain:string;token:string;population:'signal'|'control';features:ResearchFeatures},
  candles:Candle[],costBps:number,
):ShadowOutcome|null{
  if(variantId!==forwardShadowVariants[0].id||observation.at<SHADOW_LOCKED_START)return null;
  const ordered=candles.filter(c=>c.at>=observation.at).sort((a,b)=>a.at-b.at),entry=ordered[0];
  if(!entry)return null;
  const result=simulatePath({chain:observation.chain,token:observation.token,entryAt:entry.at,entryPrice:entry.open,candles:ordered},{
    structure:'trailing',tp1Pct:8,stop:'fixed3',timeHours:24,costBps,supportStop:null,atr14:observation.features.atr14??null,
  });
  return result?{...result,population:observation.population,observationAt:observation.at,costBps,costSource:'modeled'}:null;
}

const day=(at:number)=>new Date(at).toISOString().slice(0,10);
const average=(values:number[])=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const grouped=(rows:ShadowOutcome[])=>{
  const groups=new Map<string,number[]>();
  for(const row of rows){const key=day(row.entryAt),values=groups.get(key)??[];values.push(row.netReturnPct);groups.set(key,values);}
  return groups;
};
const rng=(seed:number)=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/0x100000000;};
const quantile=(values:number[],p:number)=>{const sorted=values.slice().sort((a,b)=>a-b),i=(sorted.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return sorted[lo]+(sorted[hi]-sorted[lo])*(i-lo);};

export function dayBlockInterval(rows:ShadowOutcome[],iterations=2000):Interval|null{
  const groups=[...grouped(rows).values()];
  if(groups.length<3||rows.length<3)return null;
  const random=rng(0x5ad0c0de),samples:number[]=[];
  for(let i=0;i<iterations;i++){
    const values:number[]=[];
    for(let j=0;j<groups.length;j++)values.push(...groups[Math.floor(random()*groups.length)]);
    samples.push(average(values)!);
  }
  const low=quantile(samples,.025),high=quantile(samples,.975);
  return high>low?{low,high,blocks:groups.length}:null;
}

export function pairedDayBlockInterval(signals:ShadowOutcome[],controls:ShadowOutcome[],iterations=2000):Interval|null{
  const signalDays=grouped(signals),controlDays=grouped(controls),blocks:{signals:number[];controls:number[]}[]=[];
  for(const [key,s] of signalDays){const c=controlDays.get(key);if(c)blocks.push({signals:s,controls:c});}
  if(blocks.length<3)return null;
  const random=rng(0x51a1cafe),samples:number[]=[];
  for(let i=0;i<iterations;i++){
    const signalDraw:number[]=[],controlDraw:number[]=[];
    for(let j=0;j<blocks.length;j++){const block=blocks[Math.floor(random()*blocks.length)];signalDraw.push(...block.signals);controlDraw.push(...block.controls);}
    samples.push(average(signalDraw)!-average(controlDraw)!);
  }
  const low=quantile(samples,.025),high=quantile(samples,.975);
  return high>low?{low,high,blocks:blocks.length}:null;
}

export function summarizeForwardShadow(rows:{variantId:string;outcome:ShadowOutcome}[]):ShadowProgress[]{
  return forwardShadowVariants.map(variant=>{
    const outcomes=rows.filter(row=>row.variantId===variant.id&&row.outcome.resolved).map(row=>row.outcome);
    const signals=outcomes.filter(row=>row.population==='signal'),controls=outcomes.filter(row=>row.population==='control');
    const signalDaySet=new Set(signals.map(row=>day(row.entryAt))),controlDaySet=new Set(controls.map(row=>day(row.entryAt)));
    const sharedDaySet=new Set([...signalDaySet].filter(value=>controlDaySet.has(value)));
    const signalDays=signalDaySet.size,controlDays=controlDaySet.size,sharedDays=sharedDaySet.size;
    const signalExpectancyPct=average(signals.map(row=>row.netReturnPct)),controlExpectancyPct=average(controls.map(row=>row.netReturnPct));
    const signalInterval=dayBlockInterval(signals),controlInterval=dayBlockInterval(controls),edgeInterval=pairedDayBlockInterval(signals,controls);
    const sharedSignals=signals.filter(row=>sharedDaySet.has(day(row.entryAt))),sharedControls=controls.filter(row=>sharedDaySet.has(day(row.entryAt)));
    const sharedSignalMean=average(sharedSignals.map(row=>row.netReturnPct)),sharedControlMean=average(sharedControls.map(row=>row.netReturnPct));
    const edgePct=sharedSignalMean===null||sharedControlMean===null?null:sharedSignalMean-sharedControlMean;
    const realCostSignals=signals.filter(row=>row.costSource==='logged_real').length,blockers:string[]=[];
    if(signals.length<variant.requiredSignals)blockers.push(`${signals.length}/${variant.requiredSignals} resolved signals`);
    if(signalDays<variant.requiredDays)blockers.push(`${signalDays}/${variant.requiredDays} signal days`);
    if(!signalInterval||signalInterval.low<=0)blockers.push('positive expectancy CI not established');
    if(!edgeInterval||edgeInterval.low<=0)blockers.push('universe-beating CI not established');
    if(realCostSignals<signals.length||!signals.length)blockers.push('logged real costs unavailable');
    return{id:variant.id,label:variant.label,lockedStart:variant.lockedStart,requiredSignals:variant.requiredSignals,requiredDays:variant.requiredDays,
      resolvedSignals:signals.length,resolvedControls:controls.length,signalDays,controlDays,sharedDays,signalExpectancyPct,signalInterval,controlExpectancyPct,controlInterval,
      edgePct,edgeInterval,realCostSignals,costStatus:signals.length>0&&realCostSignals===signals.length?'logged real':'modeled only',eligible:!blockers.length,blockers};
  });
}

export const shadowMaturityCutoff=(now:number)=>now-DAY;
