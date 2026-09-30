import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChartLearning, failureTags, simulateTrade, type LearningRow } from '../src/chart-learning.js';
import type { AlertOutcome } from '../src/chart-monitor.js';
import type { ResearchFeatures, Setup } from '../src/chart-pattern.js';

const feature=(volumeRatio:number,riskPct:number):ResearchFeatures=>({at:300_000,open:1,high:1.02,low:.98,close:1,volume:1_000,meanVolume20:500,volumeRatio,
  bodyPct:.5,upperWickPct:.1,lowerWickPct:.4,closePosition:.8,atr14:.04,atrPct:4,ema9:.99,ema21:.98,sma50:.97,ema9SlopePct:.5,ema21SlopePct:.2,
  priceToEma9Pct:1,ema9ToEma21Pct:1,priceToSma50Pct:3,priorPeakDrawdownPct:-10,supportArmed:true,supportAnchor:0,supportLower:.9,supportUpper:.99,
  supportTestCount:2,supportTouchAgeBars:1,closesBelowSupport:0,riskPct,conditions:{green:true,closeInZone:true,volume:true,strongClose:true,aboveEma9:true,ema9Rising:true,emaAlignment:true,risk:true}});
const outcome=(firstHit:'tp1'|'stop',minPrice:number,maxPrice:number):AlertOutcome=>({startedAt:300_000,lastAt:600_000,entry:1,stop:.95,tp1:1.05,tp2:1.1,minPrice,maxPrice,firstHit,
  stopAt:firstHit==='stop'?600_000:null,tp1At:firstHit==='tp1'?600_000:null,tp2At:null,complete:false});
const row=(symbol:string,firstHit:'tp1'|'stop',next:{open:number;close:number;volume:number},volumeRatio:number,riskPct:number):LearningRow=>{
  const features=feature(volumeRatio,riskPct),setup:Setup={at:300_000,anchor:0,lower:.9,upper:.99,price:1,ema9:.99,ema21:.98,sma50:.97,volumeRatio,features};
  return {at:300_000,chain:'ethereum',token:symbol,symbol,decision:'sent',setup,outcome:outcome(firstHit,firstHit==='stop'?.8:.97,firstHit==='tp1'?1.1:1.01),
    signalCandle:{at:0,open:.98,high:1.01,low:.97,close:1,volume:1_000},confirmationCandle:{at:300_000,open:next.open,high:1.01,low:.95,close:next.close,volume:next.volume}};
};

test('learning report compares winners and losses and scores confirmation screens',()=>{
  const report=analyzeChartLearning([
    row('WIN1','tp1',{open:1,close:1.01,volume:800},2.5,4),row('WIN2','tp1',{open:.99,close:1.005,volume:500},2,5),
    row('LOSS1','stop',{open:1,close:.97,volume:100},1.3,7),row('LOSS2','stop',{open:1,close:.96,volume:200},1.4,8),
  ]);
  assert.equal(report.resolved,4);assert.equal(report.wins,2);assert.equal(report.losses,2);assert.equal(report.baselineWinRate,50);
  assert.ok(Math.abs(report.modeledGrossExpectancyPct)<1e-10);assert.equal(report.averageWinnerTargetPct,5.000000000000004);assert.equal(report.averageLoserStopPct,-5.000000000000004);
  assert.equal(report.features.find(f=>f.id==='volumeRatio')?.winnerMedian,2.25);
  const hold=report.screens.find(s=>s.id==='hold')!;
  assert.deepEqual({wins:hold.winnersKept,losses:hold.lossesKept,avoided:hold.lossesAvoided,missed:hold.winnersMissed},{wins:2,losses:0,avoided:2,missed:0});
  assert.equal(report.leadingScreen?.id,'hold');assert.equal(report.promotionReady,false);
});

test('failed next candle is tagged as red, below entry, midpoint loss, and volume collapse',()=>{
  const tags=failureTags(row('SEND','stop',{open:1,close:.97,volume:100},2,5));
  assert.deepEqual(tags,['next candle red','next close below signal entry','lost signal-candle midpoint','next-candle volume collapsed','fell back below support-zone top']);
});

test('shadow variants use delayed fills, partial exits, modeled costs and account drawdown',()=>{
  const win=row('WIN','tp1',{open:1,close:1.01,volume:800},2.5,4),loss=row('LOSS','stop',{open:1,close:1.01,volume:800},2.5,4);
  win.futureCandles=[win.confirmationCandle!,{at:600_000,open:1.02,high:1.12,low:1.011,close:1.1,volume:700}];
  loss.futureCandles=[loss.confirmationCandle!,{at:600_000,open:1,high:1.02,low:.88,close:.9,volume:700}];
  const report=analyzeChartLearning([win,loss],200),variant=report.shadow.variants.find(v=>v.id==='greenHold')!;
  assert.equal(variant.resolved,2);assert.equal(variant.wins,1);assert.equal(variant.losses,1);assert.equal(variant.tp2,1);
  assert.ok(variant.endingBalanceUsd<1_000);assert.ok(variant.maxDrawdownUsd>0);assert.equal(report.shadow.costBps,200);
  assert.equal(report.shadow.variants.find(v=>v.id==='ethereumForward')?.eligible,0);
});

test('exported trade simulator preserves the existing green-hold payoff',()=>{
  const win=row('WIN','tp1',{open:1,close:1.01,volume:800},2.5,4);
  win.futureCandles=[win.confirmationCandle!,{at:600_000,open:1.02,high:1.12,low:1.011,close:1.1,volume:700}];
  assert.deepEqual(simulateTrade(win,true,200),{chain:'ethereum',token:'WIN',entryAt:600_000,exitAt:900_000,status:'tp2',grossReturnPct:7.5,netReturnPct:5.5,resolved:true});
});
