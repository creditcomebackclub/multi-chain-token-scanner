import test from 'node:test';
import assert from 'node:assert/strict';
import { config, DAY, MINUTE } from '../src/config.js';
import { BAR } from '../src/chart-pattern.js';
import { ResearchCollector, type RegimePair } from '../src/research-collection.js';
import { marketResearchOutcome } from '../src/store.js';
import { ShortlistWorker } from '../src/shortlist.js';
import { WalletWatch } from '../src/wallet-watch.js';
import type { DiscoveryCandidate } from '../src/providers/discovery.js';
import type { Market, Security, WalletTrade } from '../src/types.js';
import { testStore, TOKEN } from './helpers.js';

const now=Math.floor(Date.now()/BAR)*BAR;
const candidate:DiscoveryCandidate={chain:'ethereum',token:TOKEN,pool:TOKEN,createdAt:now-60*MINUTE,fetchedAt:now,
  liquidity:100_000,volume5m:20_000,volume24h:500_000,buys5m:30,sells5m:10,buyers5m:20,sellers5m:8,
  name:'Research token',symbol:'RCH',priceUsd:.01,source:'geckoterminal',url:'https://www.geckoterminal.com/eth/pools/'+TOKEN};
const market:Market={chain:'ethereum',token:TOKEN,pool:TOKEN,name:'Research token',symbol:'RCH',chart:'https://dexscreener.com/ethereum/'+TOKEN,
  createdAt:candidate.createdAt,fetchedAt:now,price:.01,liquidity:100_000,fdv:1_000_000,marketCap:900_000,priceChange5m:1,raw:{}};
const security:Security={status:'PASS',reasons:[],checkedAt:now,buyTax:0,sellTax:0,raw:{ok:true}};

test('phase 2 collection flags default off and retention keeps its prior default',()=>{
  const c=config({});
  assert.equal(c.regimeCandlesEnabled,false);assert.equal(c.youngPoolResearchEnabled,false);
  assert.equal(c.executionCostLoggingEnabled,false);assert.equal(c.walletWatchEnabled,false);assert.equal(c.candleRetentionDays,35);
  assert.throws(()=>config({CANDLE_RETENTION_DAYS:'0'}),/CANDLE_RETENTION_DAYS/);
});

test('disabled collectors make no provider or research-storage calls',async()=>{
  let calls=0;
  const fail=async()=>{calls++;throw new Error('collector should be inert')};
  const collector=new ResearchCollector(config({CHAINS:'ethereum'}),{health:fail} as any,{json:fail} as any,{batch:fail} as any,{check:fail} as any,[]);
  await collector.tick();assert.equal(await collector.observeYoungPools([candidate],now),0);assert.equal(calls,0);
});

test('a research collector failure cannot abort shortlist or reserve an alert',async()=>{
  const store=await testStore();let attempted=0;
  try{
    const c=config({CHAINS:'ethereum',SCAN_MODE:'shortlist',YOUNG_POOL_RESEARCH_ENABLED:'true'});
    const discovery={discover:async()=>({candidates:[],health:{ethereum:{ok:true,detail:'ok'}}})};
    const research={observeYoungPools:async()=>{attempted++;throw new Error('research only')}};
    const worker=new ShortlistWorker(c,store,discovery as any,{batch:async()=>new Map()} as any,{check:async()=>security} as any,undefined,research as any);
    await worker.tick();assert.equal(attempted,1);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM alerts')).rows[0].n),0);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM shortlist_alerts')).rows[0].n),0);
  }finally{await store.db.close();}
});

test('regime collection stores closed five-minute bars through the injected paced client',async()=>{
  const store=await testStore();
  try{
    const pair:RegimePair={asset:'ETH',chain:'ethereum',token:TOKEN,pool:TOKEN};let requests=0;
    const rows=Array.from({length:3},(_,i)=>[(now-(i+1)*BAR)/1000,100,105,99,100+i,1000]).reverse();
    const http={json:async()=>{requests++;return{meta:{base:{address:TOKEN}},data:{attributes:{ohlcv_list:rows}}}}};
    const collector=new ResearchCollector(config({CHAINS:'ethereum',REGIME_CANDLES_ENABLED:'true'}),store,http as any,{batch:async()=>new Map()} as any,{check:async()=>security} as any,[pair]);
    await collector.tick();
    assert.equal(requests,1);assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM research_regime_candles')).rows[0].n),3);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM alerts')).rows[0].n),0);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM chart_setup_alerts')).rows[0].n),0);
  }finally{await store.db.close();}
});

test('young-pool cohort records a control and GoPlus result without reserving an alert',async()=>{
  const store=await testStore();let checks=0;
  try{
    const collector=new ResearchCollector(config({CHAINS:'ethereum',YOUNG_POOL_RESEARCH_ENABLED:'true'}),store,{json:async()=>({})} as any,
      {batch:async()=>new Map([[TOKEN,[market]]])} as any,{check:async()=>{checks++;return security}} as any,[]);
    assert.equal(await collector.observeYoungPools([candidate],now),1);
    assert.equal(await collector.observeYoungPools([candidate],now),0);
    const row=(await store.db.query('SELECT data FROM young_pool_research_observations')).rows[0];
    assert.equal(row.data.security.status,'PASS');assert.equal(checks,1);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM alerts')).rows[0].n),0);
    assert.equal(Number((await store.db.query('SELECT count(*)::int n FROM chart_setup_alerts')).rows[0].n),0);
  }finally{await store.db.close();}
});

test('wallet research stores detection delay without exporting wallet identity fields',async()=>{
  const store=await testStore();
  try{
    const trade:WalletTrade={id:'wallet-research',trader:'private',wallet:'0x3333333333333333333333333333333333333333',chain:'ethereum',tx:'0x'+'a'.repeat(64),
      at:now-2*MINUTE,side:'buy',token:TOKEN,tokenAmount:'100',tokenSymbol:'RCH',quoteSymbol:'USDC',quoteAmount:'10',quoteUsd:10,chart:null};
    await store.saveWalletWatchResearch(trade,now,market);
    const row=(await store.db.query('SELECT delay_ms,data FROM wallet_watch_research_observations')).rows[0];
    assert.equal(Number(row.delay_ms),2*MINUTE);assert.equal(JSON.stringify(row.data).includes('private'),false);
    assert.equal(JSON.stringify(row.data).includes(trade.wallet),false);assert.equal(JSON.stringify(row.data).includes(trade.tx),false);
  }finally{await store.db.close();}
});

test('wallet research persistence failure cannot suppress wallet alert delivery',async()=>{
  let sent=0;
  const store={saveWalletWatchResearch:async()=>{throw new Error('research database unavailable')}};
  const telegram={walletTrade:async()=>{sent++}};
  const dex={batch:async()=>new Map([[TOKEN,[market]]])};
  const watcher=new WalletWatch(config({CHAINS:'ethereum',WALLET_WATCH_ENABLED:'true'}),store as any,telegram as any,dex as any);
  const trade:WalletTrade={id:'delivery',trader:'private',wallet:'0x3333333333333333333333333333333333333333',chain:'ethereum',tx:'0x'+'b'.repeat(64),
    at:now,side:'buy',token:TOKEN,tokenAmount:'100',tokenSymbol:'RCH',quoteSymbol:'USDC',quoteAmount:'10',quoteUsd:10,chart:null};
  await (watcher as any).deliver(trade);assert.equal(sent,1);
});

test('research outcomes treat a near-zero liquidity collapse as a complete total loss',()=>{
  const outcome=marketResearchOutcome(now,1,100_000,[
    {at:now,price:1,liquidity:100_000},{at:now+MINUTE,price:1.5,liquidity:90_000},{at:now+2*MINUTE,price:.4,liquidity:500},
  ],now+2*MINUTE);
  assert.equal(outcome.complete,true);assert.equal(outcome.returnPct,-100);assert.equal(outcome.maePct,-100);assert.equal(outcome.mfePct,50);
});

test('research outcomes accept the first sample after a fixed horizon',()=>{
  const outcome=marketResearchOutcome(now,1,100_000,[{at:now,price:1,liquidity:100_000},{at:now+24*60*MINUTE+MINUTE,price:2,liquidity:90_000}],now+25*60*MINUTE);
  assert.equal(outcome.complete,true);assert.equal(outcome.horizons['24h'],100);assert.equal(outcome.returnPct,100);
});

test('stored young-pool samples produce a refreshable 24-hour outcome',async()=>{
  const store=await testStore();
  try{
    await store.saveYoungPoolResearch('young-outcome',candidate,market,security);
    await store.saveYoungPoolResearchSample('young-outcome',now+24*60*MINUTE+MINUTE,.015,80_000);
    const updated=await store.updateMarketResearchOutcomes(now+25*60*MINUTE);assert.equal(updated.youngPool,1);
    const outcome=(await store.db.query("SELECT data FROM young_pool_research_outcomes WHERE observation_id='young-outcome'")).rows[0].data;
    assert.equal(outcome.complete,true);assert.ok(Math.abs(outcome.returnPct-50)<1e-9);
  }finally{await store.db.close();}
});

test('configured candle retention removes only bars older than the requested window',async()=>{
  const store=await testStore();
  try{
    const bars=[{at:now-3*DAY,open:1,high:1,low:1,close:1,volume:1},{at:now-DAY,open:1,high:1,low:1,close:1,volume:1}];
    await store.saveChartCandles(candidate,bars);await store.retention(2);
    const rows=(await store.db.query('SELECT extract(epoch FROM at)*1000 AS "at" FROM chart_candles ORDER BY at')).rows;
    assert.equal(rows.length,1);assert.equal(Number(rows[0].at),now-DAY);
  }finally{await store.db.close();}
});
