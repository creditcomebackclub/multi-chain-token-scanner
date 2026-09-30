import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceOutcome, ChartMonitor, positionEvent, type ManagedPosition } from '../src/chart-monitor.js';
import { HOUR } from '../src/config.js';
import { config } from '../src/config.js';
import type { DexScreener } from '../src/providers/enrichment.js';
import { Http } from '../src/providers/http.js';
import type { Market } from '../src/types.js';
import { Telegram } from '../src/telegram.js';
import { testStore, TOKEN } from './helpers.js';

const levels={entry:1,stop:.92,tp1:1.05,tp2:1.10};
const plan={referenceEntry:1,stop:.92,takeProfit:1.05,runnerTarget:1.10,entryMin:.99,entryMax:1.02};
const pair={chain:'ethereum',token:TOKEN,pool:TOKEN,symbol:'TEST',liquidity:100_000};
const position=(stage:'open'|'tp1'='open'):ManagedPosition=>({id:'position',alertId:'alert',chain:'ethereum',token:TOKEN,pool:TOKEN,symbol:'TEST',amountUsd:50,entry:1,stop:.92,tp1:1.05,tp2:1.10,initialLiquidity:100_000,openedAt:1,stage,status:'open'});

test('free alert outcome keeps the first observed level and records later TP2',()=>{
  const start=1_000_000;
  let out=advanceOutcome(undefined,levels,1,start);
  out=advanceOutcome(out,levels,1.06,start+60_000);
  out=advanceOutcome(out,levels,.90,start+120_000);
  out=advanceOutcome(out,levels,1.11,start+180_000);
  assert.equal(out.firstHit,'tp1');assert.equal(out.tp2At,start+180_000);assert.equal(out.stopAt,null);
  out=advanceOutcome(out,levels,1,start+24*HOUR);assert.equal(out.complete,true);
});

test('position management prioritizes an actionable price level and then liquidity',()=>{
  assert.equal(positionEvent(position(),{price:.91,liquidity:1_000}),'stop');
  assert.equal(positionEvent(position(),{price:1.06,liquidity:1_000}),'tp1');
  assert.equal(positionEvent(position('tp1'),{price:1,liquidity:100_000}),'breakeven');
  assert.equal(positionEvent(position(),{price:1,liquidity:49_999}),'liquidity');
});

test('delivered chart alerts are sampled and actual entries can arm deduplicated management',async()=>{
  const store=await testStore();
  try{
    await store.db.query("INSERT INTO chart_setup_alerts(id,chain,token,pool,data,status,sent_at) VALUES('alert','ethereum',$1,$1,$2,'sent',clock_timestamp())",[TOKEN,JSON.stringify({pair,plan})]);
    await store.db.query("INSERT INTO chart_signals(id,rule,strategy,chain,token,pool,data,decision,detected_at) VALUES('signal','test','support-rejection','ethereum',$1,$1,$2,'sent',clock_timestamp())",[TOKEN,JSON.stringify({pair,plan})]);
    const market:Market={chain:'ethereum',token:TOKEN,pool:TOKEN,name:'Test',symbol:'TEST',chart:'https://dexscreener.com/ethereum/test',createdAt:Date.now()-HOUR,fetchedAt:Date.now(),price:1.06,liquidity:100_000,fdv:1_000_000,marketCap:1_000_000,priceChange5m:1,raw:{}};
    const dex={batch:async()=>new Map([[TOKEN,[market]]])} as unknown as DexScreener;
    await new ChartMonitor(store,dex).tick();
    const stats=await store.chartStats();assert.equal(stats.measured,1);assert.equal(stats.tp1First,1);
    const raw=await store.chartSignalStats();assert.equal(raw.detected,1);assert.equal(raw.tp1First,1);assert.deepEqual(raw.decisions,{sent:1});
    const p=await store.registerChartPosition(TOKEN,50,1);assert.equal(p.tp1,1.05);
    await assert.rejects(()=>store.registerChartPosition(TOKEN,25,1),/already has an open position monitor/i);
    await store.validateChat('chat');
    assert.equal(await store.reserveChartPositionEvent(p,'tp1',{price:1.05},'chat'),true);
    assert.equal(await store.reserveChartPositionEvent(p,'tp1',{price:1.06},'chat'),false);
    assert.equal((await store.openChartPositions())[0].stage,'tp1');
    assert.equal(await store.closeChartPosition(TOKEN),true);assert.equal((await store.openChartPositions()).length,0);
  }finally{await store.db.close()}
});

test('Telegram arms, lists and manually closes a position monitor',async()=>{
  const store=await testStore(),sent:any[]=[];
  try{
    await store.db.query("INSERT INTO chart_setup_alerts(id,chain,token,pool,data,status,sent_at) VALUES('alert','ethereum',$1,$1,$2,'sent',clock_timestamp())",[TOKEN,JSON.stringify({pair,plan})]);
    const c=config({SCAN_MODE:'shortlist',TELEGRAM_CHAT_ID:'123',TELEGRAM_BOT_TOKEN:'fake'});
    const bot=new Telegram(c,store,new Http(0,async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({ok:true,result:{message_id:sent.length}})}));
    await store.validateChat(bot.chatKey);
    const message=(text:string)=>({message:{chat:{id:123,type:'private'},text}});
    await bot.handle(message(`/entered ${TOKEN} $50 1`));
    await bot.handle(message('/positions'));
    await bot.handle(message(`/closed ${TOKEN}`));
    assert.equal(sent.length,3);assert.match(sent[0].text,/POSITION MONITOR ARMED/);assert.match(sent[1].text,/OPEN POSITION MONITORS/);assert.match(sent[2].text,/monitor closed/);
  }finally{await store.db.close()}
});
