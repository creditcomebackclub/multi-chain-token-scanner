import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR, type Candle, type ResearchFeatures, type Setup } from '../src/chart-pattern.js';
import { DAY } from '../src/config.js';
import { config } from '../src/config.js';
import { Http } from '../src/providers/http.js';
import type { DiscoveryCandidate } from '../src/providers/discovery.js';
import { Telegram } from '../src/telegram.js';
import {
  SHADOW_LOCKED_START, dayBlockInterval, forwardShadowVariants, simulateForwardShadow,
  summarizeForwardShadow, type ShadowOutcome,
} from '../src/shadow-research.js';
import { testStore, TOKEN } from './helpers.js';

const features=(at:number):ResearchFeatures=>({at,open:100,high:101,low:99,close:100,volume:100,meanVolume20:50,volumeRatio:2,
  bodyPct:.5,upperWickPct:.2,lowerWickPct:.3,closePosition:.7,atr14:2,atrPct:2,ema9:100,ema21:99,sma50:98,
  ema9SlopePct:.2,ema21SlopePct:.1,priceToEma9Pct:0,ema9ToEma21Pct:1,priceToSma50Pct:2,priorPeakDrawdownPct:-10,
  supportArmed:true,supportAnchor:0,supportLower:97,supportUpper:103,supportTestCount:2,supportTouchAgeBars:1,closesBelowSupport:0,riskPct:3,
  conditions:{green:true,closeInZone:true,volume:true,strongClose:true,aboveEma9:true,ema9Rising:true,emaAlignment:true,risk:true}});
const setup=(at:number):Setup=>({at,anchor:at-BAR,lower:97,upper:103,price:100,ema9:100,ema21:99,sma50:98,volumeRatio:2,features:features(at)});
const pair=(at:number):DiscoveryCandidate=>({chain:'ethereum',token:TOKEN,pool:TOKEN,createdAt:at-DAY,fetchedAt:at,liquidity:100_000,
  volume5m:8_000,volume24h:500_000,buys5m:30,sells5m:12,buyers5m:24,sellers5m:10,name:'Shadow',symbol:'SHD',priceUsd:100,
  source:'geckoterminal',url:'https://example.com'});
const candle=(at:number,open=100,high=101,low=99,close=100):Candle=>({at,open,high,low,close,volume:100});
const outcome=(entryAt:number,netReturnPct:number,population:'signal'|'control'='signal',costSource:'modeled'|'logged_real'='modeled'):ShadowOutcome=>({
  chain:'ethereum',token:TOKEN,entryAt,exitAt:entryAt+DAY,exitReason:'time',grossReturnPct:netReturnPct+2,netReturnPct,resolved:true,barsHeld:288,
  exitPrice:100,population,observationAt:entryAt,costBps:200,costSource,
});

test('locked challenger uses next-bar open and the shared conservative simulator',()=>{
  const at=SHADOW_LOCKED_START+BAR,candles=[candle(at,100,110,96,108)];
  const result=simulateForwardShadow(forwardShadowVariants[0].id,{at,chain:'ethereum',token:TOKEN,population:'signal',features:features(at)},candles,200);
  assert.equal(result?.entryAt,at);assert.equal(result?.exitReason,'stop');assert.ok(Math.abs((result?.grossReturnPct??0)+3)<1e-10);assert.ok(Math.abs((result?.netReturnPct??0)+5)<1e-10);
  assert.equal(simulateForwardShadow(forwardShadowVariants[0].id,{at:SHADOW_LOCKED_START-1,chain:'ethereum',token:TOKEN,population:'signal',features:features(at)},candles,200),null);
});

test('day-block intervals are not estimable below three distinct days',()=>{
  assert.equal(dayBlockInterval([outcome(SHADOW_LOCKED_START,1),outcome(SHADOW_LOCKED_START+DAY,2)]),null);
  const interval=dayBlockInterval([outcome(SHADOW_LOCKED_START,1),outcome(SHADOW_LOCKED_START+DAY,2),outcome(SHADOW_LOCKED_START+2*DAY,3)]);
  assert.ok(interval);assert.equal(interval.blocks,3);assert.ok(interval.high>interval.low);
});

test('promotion remains blocked until sample, comparative CI, and real-cost gates all pass',()=>{
  const modeled:{variantId:string;outcome:ShadowOutcome}[]=[];
  for(let i=0;i<180;i++)modeled.push({variantId:forwardShadowVariants[0].id,outcome:outcome(SHADOW_LOCKED_START+(i%20)*DAY,8+(i%20)/10,'signal')});
  for(let i=0;i<200;i++)modeled.push({variantId:forwardShadowVariants[0].id,outcome:outcome(SHADOW_LOCKED_START+(i%20)*DAY,(i%4)-1,'control')});
  const blocked=summarizeForwardShadow(modeled)[0];assert.equal(blocked.eligible,false);assert.ok(blocked.blockers.includes('no eligible observed or valid cost-model expectancy CI'));
  const real=modeled.map(row=>({...row,outcome:{...row.outcome,costSource:'logged_real' as const}}));
  const eligible=summarizeForwardShadow(real)[0];assert.equal(eligible.eligible,true);assert.deepEqual(eligible.blockers,[]);
  assert.equal(eligible.costViews.find(view=>view.provenance==='modeled:flat-bps')?.eligibleCostGate,false);
  assert.equal(eligible.costViews.find(view=>view.provenance==='observed')?.eligibleCostGate,true);
});

test('a complete valid v1 model view can satisfy the cost gate while flat bps never can',()=>{
  const rows:{variantId:string;outcome:ShadowOutcome;modelCostBps?:number;modelValid?:boolean}[]=[];
  for(let i=0;i<180;i++)rows.push({variantId:forwardShadowVariants[0].id,outcome:outcome(SHADOW_LOCKED_START+(i%20)*DAY,8+(i%20)/10,'signal'),modelCostBps:300,modelValid:true});
  for(let i=0;i<200;i++)rows.push({variantId:forwardShadowVariants[0].id,outcome:outcome(SHADOW_LOCKED_START+(i%20)*DAY,(i%4)-1,'control')});
  const valid=summarizeForwardShadow(rows)[0];assert.equal(valid.eligible,true);assert.equal(valid.costStatus,'model:cost-model-v1');
  assert.equal(valid.costViews.find(view=>view.provenance==='modeled:flat-bps')?.eligibleCostGate,false);
  const invalid=summarizeForwardShadow(rows.map(row=>row.outcome.population==='signal'?{...row,modelValid:false}:row))[0];
  assert.equal(invalid.eligible,false);assert.equal(invalid.costViews.find(view=>view.provenance==='model:cost-model-v1')?.status,'invalidated');
});

test('store enrolls only post-lock signal and control rows and resolves them without an alert row',async()=>{
  const store=await testStore();
  try{
    const at=SHADOW_LOCKED_START+BAR,history=Array.from({length:289},(_,i)=>candle(at+i*BAR));
    await store.db.query(`INSERT INTO chart_research_observations(id,rule,chain,token,pool,at,kind,data,created_at)
      VALUES('pre-activation','test','ethereum',$1,$1,$2,'control',$3,
        (SELECT activated_at-interval '1 minute' FROM shadow_variant_registry WHERE variant_id=$4))`,
      [TOKEN,new Date(at).toISOString(),JSON.stringify({pair:pair(at),features:features(at)}),forwardShadowVariants[0].id]);
    await store.saveChartResearch('before',pair(at),history,{...features(at),at:SHADOW_LOCKED_START-1});
    await store.saveChartResearch('control',pair(at),history,features(at));
    await store.saveChartResearch('signal',pair(at),history,features(at),setup(at),'signal-id');
    const enrolled=await store.db.query('SELECT population FROM shadow_variant_observations ORDER BY population');
    assert.deepEqual(enrolled.rows.map(row=>row.population),['control','signal']);
    assert.equal((await store.db.query('SELECT count(*)::int n FROM chart_setup_alerts')).rows[0].n,0);
    assert.equal(await store.updateShadowVariantOutcomes(at+DAY+BAR,200),2);
    assert.equal((await store.db.query("SELECT count(*)::int n FROM shadow_variant_observations WHERE observation_id='pre-activation'")).rows[0].n,0);
    const progress=(await store.shadowVariantProgress())[0];
    assert.equal(progress.resolvedSignals,1);assert.equal(progress.resolvedControls,1);assert.equal(progress.eligible,false);
  }finally{await store.db.close();}
});

test('/shadow reports locked progress without reserving or sending a BUY alert',async()=>{
  const store=await testStore(),sent:any[]=[];
  try{
    const bot=new Telegram(config({TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake'}),store,new Http(0,async(_url,init)=>{
      sent.push(JSON.parse(init!.body as string));return new Response(JSON.stringify({ok:true,result:{message_id:sent.length}}));
    }));
    await store.validateChat(bot.chatKey);
    await bot.handle({message:{chat:{id:123,type:'private'},text:'/shadow'}});
    assert.equal(sent.length,1);assert.match(sent[0].text,/LOCKED FORWARD SHADOW TESTS/);assert.match(sent[0].text,/0\/180 resolved/);
    assert.equal((await store.db.query('SELECT count(*)::int n FROM chart_setup_alerts')).rows[0].n,0);
  }finally{await store.db.close();}
});
