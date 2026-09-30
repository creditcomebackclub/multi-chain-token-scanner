import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, BAR, candles, selectPairs, watchDay, type Candle } from '../src/chart-pattern.js';
import { ChartSetupWorker } from '../src/chart-setups.js';
import { config, DAY } from '../src/config.js';
import type { DiscoveryCandidate } from '../src/providers/discovery.js';
import { Http } from '../src/providers/http.js';
import type { DexScreener, GoPlus } from '../src/providers/enrichment.js';
import { Telegram } from '../src/telegram.js';
import { testStore, TOKEN } from './helpers.js';
function fixture(): Candle[] {
  const base = Math.floor(Date.now()/BAR)*BAR-140*BAR;
  const bars = Array.from({length:120},(_,i)=>{
    let close=i<50?11:i<70?11-(i-50)*.045:10.1;
    if(i===111)close=10.04;if(i===112)close=10.15;if(i===113)close=10.25;if(i===114)close=10.4;
    const open=i===114?10.2:close-.02;
    let low=Math.min(open,close)-.05,high=Math.max(open,close)+.05;
    if(i===75||i===90){close=10.05;low=9.9;high=10.12;}
    return {at:base+i*BAR,open,high,low,close,volume:i===114?220:100};
  });
  const at=analyze(bars).setups[0].at;
  const selected=bars.filter(b=>b.at+BAR<=at), shift=Math.floor(Date.now()/BAR)*BAR-at;
  return selected.map(b=>({...b,at:b.at+shift}));
}
const pair = (token=TOKEN): DiscoveryCandidate => ({chain:'ethereum',token,pool:token,createdAt:Date.now()-3*DAY,fetchedAt:Date.now(),liquidity:100000,volume24h:500000,volume5m:5000,buys5m:20,sells5m:10,buyers5m:20,sellers5m:10,name:'Example',symbol:'EX',priceUsd:11,source:'geckoterminal',url:'https://www.geckoterminal.com/eth/pools/'+token});
test('uses closed validated candles; gaps reset history and stale/flat history cannot trigger',()=>{
  const bars=fixture(), rows=bars.map(b=>[b.at/1000,b.open,b.high,b.low,b.close,b.volume]);
  const end=bars.at(-1)!.at+BAR;
  assert.equal(candles([...rows,[end/1000,10,11,9,10,100]],end).length,bars.length);
  assert.throws(()=>candles([...rows,[rows[0][0],10,11,9,10,100]],end),/Conflicting/);
  assert.throws(()=>candles([[end/1000,10,9,11,10,1]],end),/Invalid/);
  assert.equal(analyze(candles(rows.filter((_,i)=>i!==rows.length-20),end)).setups.length,0);
  assert.equal(analyze(bars.map(b=>({...b,open:10,high:10,low:10,close:10,volume:0}))).setups.length,0);
});
test('causal support-rejection detection has no future lookahead and requires green volume',()=>{
  const bars=fixture(), result=analyze(bars);
  assert.equal(result.setups.length,1);
  assert.equal(result.setups[0].at,bars.at(-1)!.at+BAR);
  for(let n=80;n<bars.length;n++) assert.deepEqual(analyze(bars.slice(0,n)).setups,result.setups.filter(s=>s.at<=bars[n-1].at+BAR));
  assert.equal(analyze(bars.map(b=>({...b,volume:100}))).setups.length,0);
  const after=bars.concat(Array.from({length:20},(_,i)=>({...bars.at(-1)!,at:bars.at(-1)!.at+(i+1)*BAR,open:1,high:1,low:1,close:1})));
  assert.deepEqual(analyze(after).setups.filter(s=>s.at<=result.setups[0].at),result.setups);
});
test('daily selection includes older tokens, diversifies chains, excludes stablecoins and duplicate pools',()=>{
  const all=Array.from({length:30},(_,i)=>({...pair('0x'+i.toString(16).padStart(40,'0')),chain:i%2?'bnb' as const:'ethereum' as const}));
  all.push({...all[0],pool:'other'}, {...pair(),symbol:'USDC'});
  const chosen=selectPairs(all,['ethereum','bnb'],Date.now());
  assert.equal(chosen.length,10);assert.equal(new Set(chosen.map(p=>p.chain+':'+p.token)).size,10);
  assert.equal(chosen.filter(p=>p.chain==='bnb').length,5);
  assert.ok(!chosen.some(p=>p.symbol==='USDC'));
  assert.notEqual(watchDay(Date.UTC(2026,8,12,6,59)),watchDay(Date.UTC(2026,8,12,7,1)));
});
async function harness(status='PASS',reasons:string[]=[]) {
  const store=await testStore(), p=pair(), bars=fixture(), c=config({SCAN_MODE:'shortlist',CHART_SETUPS_ENABLED:'true',PUSH_ENABLED:'true',TELEGRAM_BOT_TOKEN:'test',TELEGRAM_CHAT_ID:'1',CHAINS:'ethereum'});
  let sends=0, unavailable=false, quoteFactor=1;
  const tg=new Telegram(c,store,new Http(0,async()=>{sends++;return Response.json({ok:true,result:{message_id:sends}})}));
  await store.validateChat(tg.chatKey);await store.saveChartWatchlist(watchDay(Date.now()),[p]);
  const http=new Http(0,async(url)=>{assert.ok(String(url).includes('include_empty_intervals=true'));return unavailable ? new Response('',{status:503}) : Response.json({meta:{base:{address:p.token}},data:{attributes:{ohlcv_list:bars.map(b=>[b.at/1000,b.open,b.high,b.low,b.close,b.volume])}}});});
  const dex={batch:async()=>new Map([[p.token,[{pool:p.pool,fetchedAt:Date.now(),liquidity:100000,price:bars.at(-1)!.close*quoteFactor}]]])} as unknown as DexScreener;
  const security={check:async()=>({status,reasons})} as unknown as GoPlus;
  const worker=new ChartSetupWorker(c,store,http,dex,security,tg);
  return {store,p,bars,worker,sends:()=>sends,unavailable:(value:boolean)=>{unavailable=value},quoteFactor:(value:number)=>{quoteFactor=value}};
}
test('end-to-end sends one fresh setup and restart does not duplicate it',async()=>{
  const h=await harness();try {
    await h.store.saveChartState(h.p.chain,h.p.pool,{lastAt:h.bars.at(-1)!.at,checkedAt:Date.now(),detail:'watching'});
    await h.worker.tick();assert.equal(h.sends(),1);
    await h.worker.tick();assert.equal(h.sends(),1);
    assert.equal((await h.store.chartStats()).sent7d,1);
    const saved=(await h.store.db.query('SELECT data FROM chart_setup_alerts')).rows[0].data;
    assert.equal(saved.plan.version,'super-scalp-entry-v3');
    assert.equal(saved.plan.takeProfit,saved.setup.price*1.05);
    assert.equal(saved.plan.runnerTarget,saved.setup.price*1.1);
    const signal=(await h.store.db.query('SELECT decision,data FROM chart_signals')).rows[0];
    assert.equal(signal.decision,'sent');assert.equal(signal.data.plan.version,'super-scalp-entry-v3');
    const research=(await h.store.db.query('SELECT kind,data FROM chart_research_observations')).rows[0];
    assert.equal(research.kind,'signal');assert.equal(research.data.evidence.market.liquidity,100000);assert.equal(research.data.evidence.security.status,'PASS');
    assert.ok(research.data.features.atrPct>0);assert.ok(Number.isFinite(research.data.features.ema9SlopePct));
  }finally{await h.store.db.close()}
});
test('first baseline does not replay historical setup',async()=>{
  const h=await harness();try{await h.worker.tick();assert.equal(h.sends(),0);}finally{await h.store.db.close()}
});
test('unknown security and global pause both prevent chart alerts',async()=>{
  for(const status of ['UNKNOWN','PASS']) {
    const h=await harness(status);try{
      await h.store.saveChartState(h.p.chain,h.p.pool,{lastAt:h.bars.at(-1)!.at,checkedAt:Date.now(),detail:'watching'});
      if(status==='PASS')await h.store.pause(true);
      await h.worker.tick();assert.equal(h.sends(),0);
    }finally{await h.store.db.close()}
  }
});
test('soft launchpad security risks send a warned BUY while hard risks remain blocked',async()=>{
  const soft=await harness('REJECT',['Dangerous holder concentration','is_proxy']);try{
    await soft.store.saveChartState(soft.p.chain,soft.p.pool,{lastAt:soft.bars.at(-1)!.at,checkedAt:Date.now(),detail:'watching'});
    await soft.worker.tick();assert.equal(soft.sends(),1);
    const data=(await soft.store.db.query('SELECT data FROM chart_setup_alerts')).rows[0].data;
    assert.deepEqual(data.riskWarnings,['Dangerous holder concentration','is_proxy']);
  }finally{await soft.store.db.close()}
  const hard=await harness('REJECT',['Dangerous holder concentration','is_mintable']);try{
    await hard.store.saveChartState(hard.p.chain,hard.p.pool,{lastAt:hard.bars.at(-1)!.at,checkedAt:Date.now(),detail:'watching'});
    await hard.worker.tick();assert.equal(hard.sends(),0);
  }finally{await hard.store.db.close()}
});
test('SCOUT reservations cannot consume BUY alert capacity',async()=>{
  const store=await testStore();try{
    await store.validateChat('chat');
    for(let i=0;i<10;i++)await store.db.query("INSERT INTO shortlist_alerts(id,chain,token,pool,data,status) VALUES($1,'bnb',$1,$1,'{}','sent')",['existing'+i]);
    assert.equal(await store.reserveChart('setup',pair(),analyze(fixture()).setups[0],'chat'),true);
  }finally{await store.db.close()}
});

test('a failed first request still requires a successful baseline before alerts',async()=>{
  const h=await harness();try{
    h.unavailable(true);await h.worker.tick();assert.equal(h.sends(),0);
    h.unavailable(false);await h.worker.tick();assert.equal(h.sends(),0);
    assert.ok((await h.store.chartState(h.p.chain,h.p.pool))?.detail.startsWith('Baseline recorded'));
  }finally{await h.store.db.close()}
});

test('worker withholds a buy alert when the market has already run beyond the entry cap',async()=>{
 const h=await harness();try {
  await h.store.saveChartState(h.p.chain,h.p.pool,{lastAt:h.bars.at(-1)!.at,checkedAt:Date.now(),detail:'watching'});
  h.quoteFactor(1.05);await h.worker.tick();assert.equal(h.sends(),0);
  assert.match((await h.store.chartState(h.p.chain,h.p.pool))!.detail,/outside entry range/);
 }finally{await h.store.db.close()}
});

test('free chart scheduling preserves oldest fairness and prioritizes pending setups within ten slots',async()=>{
 const {chartRefreshOrder}=await import('../src/chart-setups.js');const now=Date.now();
 const items=Array.from({length:20},(_,i)=>({id:i,state:{checkedAt:now-20000+i,lastAt:now-1000,detail:i>=10?'Support touched; waiting':'Waiting for support'}}));
 const selected=chartRefreshOrder(items,now);
 assert.equal(selected.length,10);assert.deepEqual(selected.slice(0,5).map(x=>x.id),[0,1,2,3,4]);
 assert.deepEqual(selected.slice(5).map(x=>x.id),[10,11,12,13,14]);
 const seen=new Set<number>();
 for(let cycle=0;cycle<4;cycle++)for(const item of chartRefreshOrder(items,now+cycle*300000)){seen.add(item.id);item.state.checkedAt=now+cycle*300000;}
 assert.equal(seen.size,20,'pending pairs cannot permanently starve other pairs');
});
