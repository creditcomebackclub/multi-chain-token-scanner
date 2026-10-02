import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BAR, type Candle, type Setup } from '../src/chart-pattern.js';
import { simulateCurrentPath, simulatePath, simulateTrade, type LearningRow } from '../src/chart-learning.js';

const candle=(at:number,open:number,high:number,low:number,close:number):Candle=>({at,open,high,low,close,volume:100});
const row=(candles:Candle[]):LearningRow=>{
  const setup:Setup={at:BAR,anchor:0,lower:95/.995,upper:103,price:100,ema9:100,ema21:99,sma50:98,volumeRatio:2,
    features:{at:BAR,open:99,high:101,low:98,close:100,volume:100,meanVolume20:50,volumeRatio:2,bodyPct:.5,upperWickPct:.2,lowerWickPct:.3,closePosition:.7,atr14:2,atrPct:2,ema9:100,ema21:99,sma50:98,ema9SlopePct:.2,ema21SlopePct:.1,priceToEma9Pct:0,ema9ToEma21Pct:1,priceToSma50Pct:2,priorPeakDrawdownPct:-10,supportArmed:true,supportAnchor:0,supportLower:95/.995,supportUpper:103,supportTestCount:2,supportTouchAgeBars:1,closesBelowSupport:0,riskPct:5,conditions:{green:true,closeInZone:true,volume:true,strongClose:true,aboveEma9:true,ema9Rising:true,emaAlignment:true,risk:true}}};
  return{at:BAR,chain:'solana',token:'x',symbol:'X',decision:'sent',setup,futureCandles:candles};
};

test('current path adapter exactly matches the deployed simulator outcomes',()=>{
  const cases=[
    [candle(BAR,100,101,94,95)],
    [candle(BAR,100,106,101,105),candle(2*BAR,105,111,104,110)],
    [candle(BAR,100,106,99,104)],
    Array.from({length:288},(_,i)=>candle((i+1)*BAR,100,102,98,101)),
  ];
  for(const candles of cases){
    const learning=row(candles),old=simulateTrade(learning,false,200),next=simulateCurrentPath(learning,200);
    assert.ok(old&&next);
    assert.equal(next.exitReason,old.status==='runner_breakeven'?'breakeven':old.status);
    assert.equal(next.entryAt,old.entryAt);assert.equal(next.exitAt,old.exitAt);
    assert.equal(next.grossReturnPct,old.grossReturnPct);assert.equal(next.netReturnPct,old.netReturnPct);assert.equal(next.resolved,old.resolved);
  }
});

test('same-bar stop and target conflict resolves to the stop',()=>{
  const result=simulatePath({chain:'bnb',token:'x',entryAt:BAR,entryPrice:100,candles:[candle(BAR,100,120,94,110)]},
    {structure:'single_tp',tp1Pct:10,stop:'fixed5',timeHours:2,costBps:100,supportStop:null,atr14:2});
  assert.equal(result?.exitReason,'stop');assert.ok(Math.abs((result?.netReturnPct??0)+6)<1e-10);
});

test('ATR trail activates after TP1 and exits the half runner pessimistically',()=>{
  const result=simulatePath({chain:'bnb',token:'x',entryAt:BAR,entryPrice:100,candles:[candle(BAR,100,106,103,105)]},
    {structure:'trailing',tp1Pct:5,stop:'fixed5',timeHours:2,costBps:0,supportStop:null,atr14:2});
  assert.equal(result?.exitReason,'trail');assert.ok(Math.abs((result?.grossReturnPct??0)-4.5)<1e-10);
});

test('committed production export passed current-rule parity on every snapshot row',()=>{
  const meta=JSON.parse(readFileSync(new URL('../research/ml/data/snapshot.meta.json',import.meta.url),'utf8'));
  const snapshot=readFileSync(new URL('../research/ml/data/snapshot.csv',import.meta.url),'utf8');
  const rows=snapshot.trimEnd().split('\n').length-1;
  assert.equal(meta.parity.status,'passed');
  assert.equal(meta.parity.rows_checked,rows);
  assert.equal(meta.rows,rows);
  assert.equal(meta.paths.ids,rows);
});
