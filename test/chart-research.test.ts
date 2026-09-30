import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResearch } from '../src/chart-research.js';
import { analyze, BAR, type Candle } from '../src/chart-pattern.js';
import { DAY, MINUTE } from '../src/config.js';
import type { DiscoveryCandidate } from '../src/providers/discovery.js';
import { testStore, TOKEN } from './helpers.js';

const now=Date.now(),at=Math.floor((now-30*MINUTE)/BAR)*BAR;
const history:Candle[]=Array.from({length:90},(_,i)=>({at:at-(90-i)*BAR,open:100,high:101,low:99,close:100,volume:100}));
const features=analyze(history).latest!;
const pair:DiscoveryCandidate={chain:'ethereum',token:TOKEN,pool:TOKEN,createdAt:now-3*DAY,fetchedAt:now,liquidity:100_000,volume5m:8_000,volume24h:500_000,buys5m:30,sells5m:12,buyers5m:24,sellers5m:10,name:'Research',symbol:'RCH',priceUsd:100,source:'geckoterminal',url:'https://www.geckoterminal.com/eth/pools/'+TOKEN};

test('research labels use the first executable quote, fixed horizons, MFE/MAE and modeled costs',()=>{
  const future:Candle[]=Array.from({length:6},(_,i)=>({at:at+i*BAR,open:100+i,high:102+i*2,low:98-i,close:101+i,volume:200}));
  const outcome=evaluateResearch(at,future,features,undefined,200,at+30*MINUTE,{price:101,fetchedAt:at+1_000});
  assert.equal(outcome.entryModel,'first_dex_quote');assert.equal(outcome.entry,101);assert.equal(outcome.observedMinutes,30);
  assert.equal(outcome.horizons['15m']?.price,103);assert.ok(Math.abs(outcome.horizons['15m']!.netReturnPct-(-0.01980198019801982))<1e-9);
  assert.equal(outcome.maxPrice,112);assert.equal(outcome.minPrice,93);assert.equal(outcome.complete,false);
});

test('research persistence keeps controls, full candles, features and refreshable outcomes',async()=>{
  const store=await testStore();
  try{
    const future:Candle[]=Array.from({length:6},(_,i)=>({at:at+i*BAR,open:100,high:102+i,low:98-i,close:101+i,volume:200}));
    await store.saveChartResearch('observation',pair,[...history,...future],features);
    assert.equal(Number((await store.db.query("SELECT count(*)::int n FROM chart_candles WHERE pool=$1",[TOKEN])).rows[0].n),96);
    const observation=(await store.db.query("SELECT kind,data FROM chart_research_observations WHERE id='observation'")).rows[0];
    assert.equal(observation.kind,'control');assert.equal(observation.data.features.atrPct,features.atrPct);
    assert.equal(await store.updateChartResearchOutcomes(at+30*MINUTE,200),1);
    const outcome=(await store.db.query("SELECT data FROM chart_research_outcomes WHERE observation_id='observation'")).rows[0].data;
    assert.equal(outcome.entryModel,'next_5m_open_proxy');assert.equal(outcome.observedMinutes,30);
    const stats=await store.chartResearchStats();assert.equal(stats.controls,1);assert.equal(stats.signals,0);assert.equal(stats.measured,1);
  }finally{await store.db.close();}
});

test('mature observations remain queued for a one-pool historical backfill after watchlist rotation',async()=>{
  const store=await testStore();
  try{
    const oldAt=Math.floor((Date.now()-25*60*MINUTE)/BAR)*BAR,oldFeatures={...features,at:oldAt};
    await store.saveChartResearch('old-control',pair,history,oldFeatures);
    const candidate=await store.chartResearchBackfillCandidate(Date.now());
    assert.equal(candidate?.token,TOKEN);assert.equal(candidate?.pool,TOKEN);
  }finally{await store.db.close();}
});
