import test from 'node:test';
import assert from 'node:assert/strict';
import { config, DAY, HOUR } from '../src/config.js';
import { ResearchMilestones, crossedStorageThresholds } from '../src/research-milestones.js';
import type { ShadowProgress } from '../src/shadow-research.js';
import { Telegram } from '../src/telegram.js';
import { Http } from '../src/providers/http.js';
import type { ResearchCollectorCoverage } from '../src/store.js';
import { testStore } from './helpers.js';

const shadow=(overrides:Partial<ShadowProgress>={}):ShadowProgress=>({
  id:'variant-test',label:'Variant <test>',lockedStart:0,requiredSignals:180,requiredDays:20,
  resolvedSignals:180,resolvedControls:200,signalDays:20,controlDays:20,sharedDays:20,
  signalExpectancyPct:2.5,signalInterval:{low:1,high:4,blocks:20},controlExpectancyPct:.5,controlInterval:{low:-1,high:2,blocks:20},
  edgePct:2,edgeInterval:{low:.5,high:3,blocks:20},realCostSignals:180,costStatus:'logged real',eligible:true,blockers:[],...overrides,
});
const lowStorage=async()=>({usageMb:100,tables:[]});
const setup=async(env:Record<string,string>={},inputs:any={})=>{
  const store=await testStore(),sent:string[]=[],c=config({TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake',...env});
  const chatKey='validated-chat';await store.validateChat(chatKey);
  const milestones=new ResearchMilestones(c,store,{chatKey,send:async text=>{sent.push(text);return sent.length;}},{shadows:async()=>[],storage:lowStorage,...inputs});
  return{store,sent,c,chatKey,milestones};
};

test('Phase 4 ready and preferred checkpoints fire at 21 and 28 days and never repeat after restart',async()=>{
  const activation=Date.parse('2026-10-03T15:22:45Z');
  const coverage:ResearchCollectorCoverage[]=[
    {collector:'regime',activatedAt:activation,days:15,observations:1_000,lastObservationAt:activation+30*DAY},
    {collector:'young_pool',activatedAt:activation,days:16,observations:200,lastObservationAt:activation+30*DAY},
  ];
  const h=await setup({REGIME_CANDLES_ENABLED:'true',YOUNG_POOL_RESEARCH_ENABLED:'true'},{coverage:async()=>coverage});
  try{
    assert.equal(await h.milestones.run(activation+21*DAY),1);assert.match(h.sent[0],/PHASE 4 COVERAGE READY/);
    const restarted=new ResearchMilestones(h.c,h.store,{chatKey:h.chatKey,send:async text=>{h.sent.push(text);return h.sent.length;}},{coverage:async()=>coverage,shadows:async()=>[],storage:lowStorage});
    assert.equal(await restarted.run(activation+28*DAY),1);assert.match(h.sent[1],/PREFERRED CHECKPOINT/);
    assert.equal(await restarted.run(activation+29*DAY),0);assert.equal(h.sent.length,2);
  }finally{await h.store.db.close();}
});

test('Phase 4 waits for 21 elapsed days and 15 distinct UTC observation days for every enabled collector',async()=>{
  const now=Date.now(),activation=now-21*DAY,coverage:ResearchCollectorCoverage[]=[
    {collector:'regime',activatedAt:activation,days:15,observations:100,lastObservationAt:now},
    {collector:'young_pool',activatedAt:activation,days:14,observations:100,lastObservationAt:now},
  ];
  const h=await setup({REGIME_CANDLES_ENABLED:'true',YOUNG_POOL_RESEARCH_ENABLED:'true'},{coverage:async()=>coverage});
  try{assert.equal(await h.milestones.run(now),0);assert.equal(h.sent.length,0);}
  finally{await h.store.db.close();}
});

test('shadow 25%, 50%, 100%, day, and owner-review milestones include the current summary',async()=>{
  const h=await setup({}, {shadows:async()=>[shadow()]});
  try{
    assert.equal(await h.milestones.run(Date.now()),5);assert.equal(h.sent.length,5);
    for(const text of h.sent)assert.match(text,/180\/180 resolved signals.*modeled expectancy \+2\.50%/s);
    assert.match(h.sent[0],/25% SAMPLE/);assert.match(h.sent[1],/50% SAMPLE/);assert.match(h.sent[2],/100% SAMPLE/);
    assert.match(h.sent[3],/DAY REQUIREMENT REACHED/);assert.match(h.sent[4],/eligible for OWNER REVIEW\. Nothing has changed automatically\./);
    assert.ok(h.sent.every(text=>!text.includes('<test>')),'variant label must be HTML escaped');
    const restarted=new ResearchMilestones(h.c,h.store,{chatKey:h.chatKey,send:async text=>{h.sent.push(text);return h.sent.length;}},{shadows:async()=>[shadow()],storage:lowStorage});
    assert.equal(await restarted.run(Date.now()+HOUR+1),0);assert.equal(h.sent.length,5);
    const counts=await Promise.all(['chart_setup_alerts','shortlist_alerts','alerts'].map(async table=>Number((await h.store.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n)));
    assert.deepEqual(counts,[0,0,0]);
  }finally{await h.store.db.close();}
});

test('storage warnings use configured-volume percentage math and fire once at 80% and 90%',async()=>{
  const below=crossedStorageThresholds(399.9,500);assert.ok(Math.abs(below.percent-79.98)<1e-10);assert.equal(below.crossed80,false);assert.equal(below.crossed90,false);
  assert.deepEqual(crossedStorageThresholds(400,500),{percent:80,crossed80:true,crossed90:false});
  assert.deepEqual(crossedStorageThresholds(450,500),{percent:90,crossed80:true,crossed90:true});
  const h=await setup({DB_VOLUME_LIMIT_MB:'500'},{storage:async()=>({usageMb:450,tables:[{name:'chart_candles',sizeMb:300}]})});
  try{
    assert.equal(await h.milestones.run(Date.now()),2);assert.match(h.sent[0],/80% WARNING/);assert.match(h.sent[1],/90% WARNING/);
    assert.match(h.sent[1],/450\.0 MB \/ 500\.0 MB/);assert.match(h.sent[1],/chart_candles: 300\.0 MB/);
  }finally{await h.store.db.close();}
});

test('collector sends one 12-hour stall warning and one recovery when observations resume',async()=>{
  const now=Date.now();let current:ResearchCollectorCoverage={collector:'regime',activatedAt:now-2*DAY,days:1,observations:3,lastObservationAt:now-13*HOUR};
  const h=await setup({REGIME_CANDLES_ENABLED:'true'},{coverage:async()=>[current]});
  try{
    assert.equal(await h.milestones.run(now),1);assert.match(h.sent[0],/COLLECTOR STALLED/);
    current={...current,days:2,observations:4,lastObservationAt:now+30*60_000};
    assert.equal(await h.milestones.run(now+HOUR+1),1);assert.match(h.sent[1],/COLLECTOR RECOVERED/);
    assert.equal(await h.milestones.run(now+2*HOUR+2),0);assert.equal(h.sent.length,2);
  }finally{await h.store.db.close();}
});

test('an ambiguous milestone send is persisted and never retried after restart',async()=>{
  const store=await testStore(),c=config({TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake'}),chatKey='chat';let calls=0;
  try{
    await store.validateChat(chatKey);
    const inputs={shadows:async()=>[shadow({resolvedSignals:45,signalDays:2,eligible:false,signalInterval:null,blockers:['sample']})],storage:lowStorage};
    const first=new ResearchMilestones(c,store,{chatKey,send:async()=>{calls++;throw new Error('ambiguous');}},inputs);
    assert.equal(await first.run(Date.now()),1);assert.equal(calls,1);
    const restarted=new ResearchMilestones(c,store,{chatKey,send:async()=>{calls++;return 2;}},inputs);
    assert.equal(await restarted.run(Date.now()+HOUR+1),0);assert.equal(calls,1);
    assert.equal((await store.researchMilestoneEvents())[0].status,'unknown');
  }finally{await store.db.close();}
});

test('hourly database gate survives concurrent calls and /milestones uses private command handling',async()=>{
  const h=await setup();let reads=0;
  try{
    const service=new ResearchMilestones(h.c,h.store,{chatKey:h.chatKey,send:async text=>{h.sent.push(text);return h.sent.length;}},{
      shadows:async()=>{reads++;return[];},storage:lowStorage,
    });
    await Promise.all([service.run(Date.now()),service.run(Date.now())]);assert.equal(reads,1);
    const payloads:any[]=[],bot=new Telegram(h.c,h.store,new Http(0,async(_url,init)=>{payloads.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:1}});}));
    await h.store.validateChat(bot.chatKey);bot.attachResearchMilestones(service);
    await bot.handle({message:{chat:{id:999,type:'private'},text:'/milestones'}});assert.equal(payloads.length,0);
    await bot.handle({message:{chat:{id:123,type:'private'},text:'/milestones'}});assert.equal(payloads.length,1);assert.match(payloads[0].text,/RESEARCH MILESTONES/);
  }finally{await h.store.db.close();}
});

test('disabled milestone monitoring sends nothing and reports checkpoints as not applicable',async()=>{
  const h=await setup({RESEARCH_MILESTONES_ENABLED:'false'},{shadows:async()=>[shadow()],storage:async()=>({usageMb:500,tables:[]})});
  try{
    assert.equal(await h.milestones.run(Date.now()),0);assert.equal(h.sent.length,0);
    assert.ok((await h.milestones.statuses()).every(item=>item.status==='not applicable'));
  }finally{await h.store.db.close();}
});

test('configured collector activation is persisted once and prospective coverage excludes older rows',async()=>{
  const store=await testStore(),activation=Date.parse('2026-10-03T15:22:45Z');
  try{
    await store.ensureResearchCollectorActivations(['regime'],activation);
    await store.ensureResearchCollectorActivations(['regime'],activation+DAY);
    await store.db.query(`INSERT INTO research_regime_candles(asset,chain,token,pool,at,open,high,low,close,volume) VALUES
      ('SOL','solana','t','p',$1,1,1,1,1,1),('ETH','ethereum','t','p',$2,1,1,1,1,1),('BNB','bnb','t','p',$3,1,1,1,1,1)`,
      [new Date(activation-DAY).toISOString(),new Date(activation+HOUR).toISOString(),new Date(activation+DAY+HOUR).toISOString()]);
    const result=(await store.researchCollectorCoverage(['regime']))[0];
    assert.equal(result.activatedAt,activation);assert.equal(result.observations,2);assert.equal(result.days,2);
  }finally{await store.db.close();}
});
