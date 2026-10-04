import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { calibration, ExecutionCosts, liquidityBucket, modeledCostBps, observedCost } from '../src/execution-costs.js';
import type { DexScreener } from '../src/providers/enrichment.js';
import type { Market } from '../src/types.js';
import { Telegram } from '../src/telegram.js';
import { Http } from '../src/providers/http.js';
import { testStore, TOKEN } from './helpers.js';

const plan={referenceEntry:1,stop:.92,takeProfit:1.05,runnerTarget:1.10,entryMin:.99,entryMax:1.02};
const pair={chain:'ethereum',token:TOKEN,pool:TOKEN,symbol:'COST',liquidity:100_000,priceUsd:1};
const market=(price:number,liquidity:number):Market=>({chain:'ethereum',token:TOKEN,pool:TOKEN,name:'Cost',symbol:'COST',chart:'https://dexscreener.com/ethereum/cost',createdAt:1,fetchedAt:Date.now(),price,liquidity,fdv:1_000_000,marketCap:1_000_000,priceChange5m:0,raw:{}});

test('locked cost formulas, buckets and calibration rule match the preregistration',()=>{
  assert.equal(liquidityBucket(49_999),'<50k');assert.equal(liquidityBucket(50_000),'50k-<100k');assert.equal(liquidityBucket(1_000_000),'>=1m');
  assert.equal(modeledCostBps({dollars:50,entryLiquidity:100_000,exitLiquidity:100_000,feeBpsPerSide:100,networkFeeUsd:5}),2230);
  const entry={at:1,dollars:50,fillPrice:1.01,alertReferencePrice:1,alertSpotPrice:1,alertLiquidity:100_000,alertSpotAt:1,spotPrice:1,liquidity:100_000,spotAt:1};
  const exit={at:2,dollarsReceived:55,fillPrice:1.0891089108910892,feesUsd:.5,spotPrice:1.1,liquidity:100_000,spotAt:2};
  const actual=observedCost(entry,exit);assert.ok(Math.abs(actual.roundTripBps-300)<1e-8);assert.ok(Math.abs(actual.entryReferenceBps-100)<1e-8);
  const nineteen=Array.from({length:19},()=>({observedCostBps:300,modelCostBps:100}));assert.equal(calibration(nineteen).invalidated,false);
  const twenty=[...nineteen,{observedCostBps:50,modelCostBps:100}];assert.equal(calibration(twenty).invalidated,true);
  assert.equal(calibration(Array.from({length:20},()=>({observedCostBps:50,modelCostBps:100})),true).invalidated,true,'invalidation is sticky');
});

test('manual entry and exit save exact-pool evidence, close the monitor and leave alert caps untouched',async()=>{
  const c=config({SCAN_MODE:'shortlist',TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake'}),store=await testStore();let call=0;
  try{
    await store.db.query("INSERT INTO chart_setup_alerts(id,chain,token,pool,data,status,sent_at) VALUES('alert','ethereum',$1,$1,$2,'sent',clock_timestamp())",
      [TOKEN,JSON.stringify({pair,plan,evidence:{market:{price:1,liquidity:100_000}}})]);
    const dex={batch:async()=>new Map([[TOKEN,[call++===0?market(1,100_000):market(1.1,80_000)]]])} as unknown as DexScreener;
    const costs=new ExecutionCosts(c,store,dex),position=await costs.entered(TOKEN,50,1.01,1_000);
    assert.equal(position.status,'open');
    const completed=await costs.exited(TOKEN,55,1.0891089108910892,.5,2_000);
    assert.ok(Math.abs(completed.observed.roundTripBps-300)<1e-7);assert.equal((await store.openChartPositions()).length,0);
    const observations=await store.executionCostObservations();assert.equal(observations.length,1);assert.equal(observations[0].liquidityBucket,'100k-<250k');
    assert.equal(observations[0].entry.alertReferencePrice,1);assert.equal(observations[0].entry.spotPrice,1);assert.equal(observations[0].exit?.spotPrice,1.1);
    const summary=await costs.summary();assert.equal(summary.overall.count,1);assert.equal(summary.byChain.ethereum.count,1);assert.equal(summary.modeled250.count,1);
    const counts=await Promise.all(['chart_setup_alerts','shortlist_alerts','alerts'].map(async table=>Number((await store.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n)));
    assert.deepEqual(counts,[1,0,0]);
  }finally{await store.db.close();}
});

test('private Telegram commands capture fills, report costs and never expose a write interface',async()=>{
  const c=config({SCAN_MODE:'shortlist',TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake'}),store=await testStore(),sent:any[]=[];let call=0;
  try{
    await store.db.query("INSERT INTO chart_setup_alerts(id,chain,token,pool,data,status,sent_at) VALUES('alert','ethereum',$1,$1,$2,'sent',clock_timestamp())",[TOKEN,JSON.stringify({pair,plan})]);
    const dex={batch:async()=>new Map([[TOKEN,[call++===0?market(1,100_000):market(1.1,100_000)]]])} as unknown as DexScreener;
    const costs=new ExecutionCosts(c,store,dex),bot=new Telegram(c,store,new Http(0,async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:sent.length}})}));
    bot.attachExecutionCosts(costs);await store.validateChat(bot.chatKey);
    const message=(text:string,id=123)=>({message:{chat:{id,type:'private'},text}});
    await bot.handle(message(`/entered ${TOKEN} 50 1`));await bot.handle(message(`/exited ${TOKEN} 55 1.1 0.25`));await bot.handle(message('/costs'));
    assert.match(sent[0].text,/Observed entry evidence/);assert.match(sent[1].text,/OBSERVED EXIT SAVED/);assert.match(sent[2].text,/cost-model-v1 sensitivity/);
    await bot.handle(message('/costs',999));assert.equal(sent.length,3,'unconfigured chats receive nothing');
  }finally{await store.db.close();}
});
