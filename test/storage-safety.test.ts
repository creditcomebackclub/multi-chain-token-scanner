import assert from 'node:assert/strict';
import test from 'node:test';
import { config, MINUTE, HOUR } from '../src/config.js';
import { Store, type Database, type DatabaseStorage } from '../src/store.js';
import { analyze, BAR, type Candle } from '../src/chart-pattern.js';
import { ResearchCollector } from '../src/research-collection.js';
import { ChartMonitor } from '../src/chart-monitor.js';
import { ResearchMilestones } from '../src/research-milestones.js';
import { testStore, TOKEN } from './helpers.js';
import type { DiscoveryCandidate } from '../src/providers/discovery.js';

const measurement=(usageMb:number):DatabaseStorage=>({usageMb,databaseMb:usageMb-50,clusterMb:usageMb-50,walMb:50,measurement:'cluster-and-wal',tables:[]});

test('storage includes every database and WAL using Railway decimal MB',async()=>{
  const driver:Database={close:async()=>{},transaction:async()=>{throw new Error('unexpected transaction');},query:async sql=>{
    if(sql.includes('current_database'))return{rows:[{bytes:'300000000'}]};
    if(sql.includes('FROM pg_database'))return{rows:[{bytes:'320000000'}]};
    if(sql.includes('pg_ls_waldir'))return{rows:[{bytes:'100000000'}]};
    if(sql.includes('unnest'))return{rows:[{name:'chart_signal_samples',bytes:'90000000'}]};
    throw new Error('unexpected query');
  }};
  const storage=await new Store(driver).databaseStorage();
  assert.equal(storage.usageMb,420);assert.equal(storage.databaseMb,300);assert.equal(storage.clusterMb,320);assert.equal(storage.walMb,100);
  assert.equal(storage.measurement,'cluster-and-wal');assert.equal(storage.tables[0].sizeMb,90);
});

test('unavailable WAL inspection is explicitly incomplete and pauses new research',async t=>{
  const base=await testStore(),store=new Store(base.db,config({DB_VOLUME_LIMIT_MB:'5000'}));
  const query=base.db.query.bind(base.db);
  t.mock.method(base.db,'query',async(sql:string,params?:any[])=>{
    if(sql.includes('pg_ls_waldir'))throw new Error('permission denied for WAL inspection');
    return query(sql,params);
  });
  try{
    const storage=await store.databaseStorage();
    assert.equal(storage.measurement,'database-only');assert.equal(storage.walMb,null);
    t.mock.method(store,'databaseStorage',async()=>storage);
    assert.equal(await store.researchWritesAllowed(),false);
    assert.match((await store.healthAll()).find(h=>h.provider==='research-storage')!.detail,/measurement unavailable/);
  }finally{await base.db.close();}
});

test('research budget caches concurrent checks, pauses at 80%, and resumes below 70%',async t=>{
  const base=await testStore(),store=new Store(base.db,config({DB_VOLUME_LIMIT_MB:'1000'}));
  let current=measurement(800),reads=0;const now=Date.now();
  t.mock.method(store,'databaseStorage',async()=>{reads++;return current;});
  try{
    assert.deepEqual(await Promise.all([store.researchWritesAllowed(now),store.researchWritesAllowed(now)]),[false,false]);
    assert.equal(reads,1);
    current=measurement(750);assert.equal(await store.researchWritesAllowed(now+MINUTE),false);
    current=measurement(700);assert.equal(await store.researchWritesAllowed(now+2*MINUTE),false);
    current=measurement(699);assert.equal(await store.researchWritesAllowed(now+3*MINUTE),true);
    assert.equal((await store.healthAll()).find(h=>h.provider==='research-storage')!.state,'healthy');
    assert.equal(reads,4);
  }finally{await base.db.close();}
});

test('a measurement failure fails closed for research without changing alert state',async t=>{
  const base=await testStore(),store=new Store(base.db,config({DB_VOLUME_LIMIT_MB:'1000'}));
  t.mock.method(store,'databaseStorage',async()=>{throw new Error('measurement timeout');});
  try{
    const before=await store.state();
    assert.equal(await store.researchWritesAllowed(),false);
    assert.deepEqual(await store.state(),before);
    const caps=await Promise.all(['alerts','chart_setup_alerts','shortlist_alerts'].map(async table=>Number((await store.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n)));
    assert.deepEqual(caps,[0,0,0]);
  }finally{await base.db.close();}
});

test('pressure preserves stored candles and observations, blocks additions and labels, then resumes',async t=>{
  const base=await testStore(),c=config({DB_VOLUME_LIMIT_MB:'1000',REGIME_CANDLES_ENABLED:'true',YOUNG_POOL_RESEARCH_ENABLED:'true'}),store=new Store(base.db,c);
  const at=Math.floor(Date.now()/BAR)*BAR;
  const bars:Candle[]=Array.from({length:90},(_,i)=>({at:at-(90-i)*BAR,open:100,high:101,low:99,close:100,volume:100}));
  const features=analyze(bars).latest!;
  const pair:DiscoveryCandidate={chain:'ethereum',token:TOKEN,pool:TOKEN,createdAt:at-HOUR,fetchedAt:at,liquidity:100_000,
    volume5m:20_000,volume24h:500_000,buys5m:30,sells5m:10,buyers5m:20,sellers5m:8,name:'Test',symbol:'TST',priceUsd:100,source:'geckoterminal',url:'https://example.com'};
  let pressured=true;t.mock.method(store,'databaseStorage',async()=>measurement(pressured?810:600));
  try{
    await base.saveChartResearch('preserved',pair,bars,features);
    await store.saveChartResearch('paused',pair,bars,{...features,at:at+BAR});
    await store.saveChartCandles(pair,[{...bars[0],at:at+BAR}]);
    await store.saveRegimeCandles('ETH',pair,bars);
    assert.equal(await store.updateChartResearchOutcomes(at+HOUR,200),0);
    assert.equal(await store.updateShadowVariantOutcomes(at+HOUR,200),0);
    assert.deepEqual(await store.updateMarketResearchOutcomes(at+HOUR),{youngPool:0,walletWatch:0});
    const rows=(await base.db.query('SELECT id FROM chart_research_observations ORDER BY id')).rows;
    assert.deepEqual(rows,[{id:'preserved'}]);
    assert.equal(Number((await base.db.query('SELECT count(*)::int n FROM chart_candles')).rows[0].n),90);
    let providerCalls=0;
    const fail=async()=>{providerCalls++;throw new Error('must not fetch under storage pressure');};
    const collector=new ResearchCollector(c,store,{json:fail} as any,{batch:fail} as any,{check:fail} as any,[]);
    await collector.tick();assert.equal(await collector.observeYoungPools([pair]),0);assert.equal(providerCalls,0);
    pressured=false;assert.equal(await store.researchWritesAllowed(Date.now()+2*HOUR),true);
    await store.saveRegimeCandles('ETH',pair,bars);
    assert.equal(Number((await base.db.query('SELECT count(*)::int n FROM research_regime_candles')).rows[0].n),90);
  }finally{await base.db.close();}
});

test('storage pressure skips raw-signal sampling but still checks owner positions and delivered alerts',async()=>{
  let positions=0,alerts=0,raw=0;
  const store={researchWritesAllowed:async()=>false,chartAlertsForTracking:async()=>{alerts++;return[];},
    chartSignalsForTracking:async()=>{raw++;return[];},openChartPositions:async()=>{positions++;return[];},health:async()=>{}};
  await new ChartMonitor(store as any,{batch:async()=>new Map()} as any).tick();
  assert.equal(raw,0);assert.equal(positions,1);assert.equal(alerts,1);
});

test('storage warning precedes expensive summaries, includes WAL, and re-arms for a larger budget',async()=>{
  const store=await testStore(),sent:string[]=[],chatKey='owner',now=Date.now();
  await store.validateChat(chatKey);
  const monitor=(limit:number)=>new ResearchMilestones(config({DB_VOLUME_LIMIT_MB:String(limit)}),store,{chatKey,send:async text=>{sent.push(text);return sent.length;}},
    {storage:async()=>measurement(limit*.8),shadows:async()=>{throw new Error('expensive summary unavailable');}});
  try{
    await assert.rejects(monitor(500).run(now),/expensive/);
    assert.equal(sent.length,1);assert.match(sent[0],/cluster \+ WAL/);
    await assert.rejects(monitor(500).run(now+HOUR+1),/expensive/);assert.equal(sent.length,1);
    await assert.rejects(monitor(5000).run(now+2*HOUR+2),/expensive/);assert.equal(sent.length,2);
    // Both notices were persisted independently; summaries being down cannot consume the notice.
    const events=await store.researchMilestoneEvents();
    assert.equal(events.filter(event=>event.kind==='storage_warning').length,2);
  }finally{await store.db.close();}
});
