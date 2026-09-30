import test from 'node:test';
import assert from 'node:assert/strict';
import {chartTradePlan,chartEntryAvailable} from '../src/chart-trade-plan.js';
import {renderSetup} from '../src/chart-setups.js';
import {config} from '../src/config.js';
import type {DiscoveryCandidate} from '../src/providers/discovery.js';
const s={at:1789318200000,ema9:.01498,ema21:.01492,sma50:.01487,lower:.014298523344179685,price:.0153182537648433,upper:.01517843247305228,anchor:1789295400000,volumeRatio:4.474979513199911};
test('super-aggressive scalp plan is fixed at alert time with two gross targets',()=>{
 const p=chartTradePlan(s);
 assert.equal(p.entryMin,Math.max(s.lower,s.price*.99));assert.equal(p.entryMax,Math.min(s.price*1.02,p.stop/.90));
 assert.ok(p.stop<s.lower);assert.equal(p.takeProfit,s.price*1.05);assert.equal(p.sellPct,50);
 assert.equal(p.runnerTarget,s.price*1.1);assert.equal(p.runnerSellPct,50);
 assert.equal(p.expiresAt,s.at+600000);assert.ok(p.maxRiskPct>p.riskPct);
 assert.throws(()=>chartTradePlan({...s,price:s.lower*.99}));
 assert.throws(()=>chartTradePlan({...s,lower:NaN}));
});
test('entry permits fresh in-range quotes only, blocks chasing, broken support and late signals',()=>{
 const now=s.at+120000, m={price:s.price,fetchedAt:now};
 assert.equal(chartEntryAvailable(s,m,now),true);
 const p=chartTradePlan(s);
 for(const price of [NaN,Infinity,0,p.entryMin*.99,p.entryMax*1.001])assert.equal(chartEntryAvailable(s,{...m,price},now),false);
 for(const fetchedAt of [now+1,now-60001,NaN])assert.equal(chartEntryAvailable(s,{...m,fetchedAt},now),false);
 assert.equal(chartEntryAvailable(s,{...m,fetchedAt:s.at-1},s.at-1),false);
 assert.equal(chartEntryAvailable(s,{...m,fetchedAt:s.at+600000},s.at+600000),false);
});
test('buy alert explains entry expiry, stop, actual-fill target and lack of automatic execution',()=>{
 const p={symbol:'AKE',chain:'bnb',token:'0x2c3a8ee94ddd97244a93bc48298f97d2c412f7db',url:'https://www.geckoterminal.com/bsc/pools/example'} as DiscoveryCandidate;
 const text=renderSetup(p,s,config({}));
 for(const term of ['SUPER AGGRESSIVE 5M BUY','BUY only within','STOP:','TP1:','TP2:','YOUR actual entry','Entry window expires','No order or exit is automatic'])assert.ok(text.includes(term),term);
});
test('buy alert makes accepted launchpad security risk unmistakable',()=>{
 const p={symbol:'AKE',chain:'bnb',token:'0x2c3a8ee94ddd97244a93bc48298f97d2c412f7db',url:'https://www.geckoterminal.com/bsc/pools/example'} as DiscoveryCandidate;
 const text=renderSetup(p,s,config({}),{allowed:true,warnings:['Dangerous holder concentration','is_proxy'],blockers:[]});
 for(const term of ['HIGH-RISK 5M WATCH','POTENTIAL ENTRY RANGE','not a buy instruction','AGGRESSIVE RISK ACCEPTED','Dangerous holder concentration','is_proxy','rug'])assert.ok(text.includes(term),term);
 assert.ok(!text.includes('SUPER AGGRESSIVE 5M BUY'));
});
