import test from 'node:test';
import assert from 'node:assert/strict';
import {newPaperAccount,enterPaper,markPaper,paperEquity,paperPolicySchema,type PaperPolicy,type PaperSignal,type PaperQuote} from '../src/paper-bot.js';
const now=Date.UTC(2026,8,13,12),p:PaperPolicy={bankrollUsd:100,orderUsd:10,maxPositions:3,dailyLossUsd:10,maxEntriesPerDay:10,stopLossPercent:20,takeProfitPercent:50,takeProfitSellPercent:50,runnerTrailPercent:25,assumedFeePercent:0,assumedSlippagePercent:0,assumedNetworkFeeUsd:0};
const signal=(strategy:'new-token'|'chart'='new-token',token='0x1111111111111111111111111111111111111111'):PaperSignal=>({id:strategy+token,strategy,chain:'ethereum',token,pool:token,symbol:'TEST',at:now});
const quote=(s:PaperSignal,price=1,at=now):PaperQuote=>({chain:s.chain,token:s.token,pool:s.pool,price,at});
test('both strategies can enter and the same token cannot enter twice across strategies',()=>{
 const a=newPaperAccount(p,now),s=signal();assert.ok(enterPaper(a,p,s,quote(s),now).fill);
 assert.match(enterPaper(a,p,{...s,id:'chart-id',strategy:'chart'},quote(s),now).reason!,/already held/);
 const other=signal('chart','0x2222222222222222222222222222222222222222');assert.ok(enterPaper(a,p,other,quote(other),now).fill);assert.equal(a.cash,'80');
});
test('at +50% sell half once; 75% of principal is recovered before fees',()=>{
 const a=newPaperAccount(p,now),s=signal();enterPaper(a,p,s,quote(s),now);
 const fills=markPaper(a,p,[quote(s,1.5,now+1000)],now+1000);
 assert.equal(fills.length,1);assert.equal(fills[0].quantity,'5');assert.equal(fills[0].cashChange,'7.5');assert.equal(a.positions[0].costRemaining,'5');
 assert.equal(markPaper(a,p,[quote(s,1.6,now+2000)],now+2000).length,0);
 assert.equal(a.positions[0].quantity,'5');
 const exit=markPaper(a,p,[quote(s,1.1,now+3000)],now+3000);
 assert.match(exit[0].reason,/Runner/);assert.equal(a.positions.length,0);assert.equal(a.cash,'103');
});
test('stops use the observed gap price, not an invented fill at the stop threshold',()=>{
 const a=newPaperAccount(p,now),s=signal();enterPaper(a,p,s,quote(s),now);
 const fills=markPaper(a,p,[quote(s,.5,now+1000)],now+1000);
 assert.equal(fills[0].price,'0.5');assert.equal(a.cash,'95');assert.equal(a.realizedPnl,'-5');
});
test('daily loss threshold, max positions, cash, stale marks and pause prevent new entries',()=>{
 const s=signal(),other=signal('chart','0x2222222222222222222222222222222222222222');
 const policy={...p,dailyLossUsd:4,maxPositions:1};const a=newPaperAccount(policy,now);
 enterPaper(a,policy,s,quote(s),now);assert.match(enterPaper(a,policy,other,quote(other),now).reason!,/position limit/);
 markPaper(a,policy,[quote(s,.5,now+1000)],now+1000);
 assert.match(enterPaper(a,policy,other,quote(other,1,now+1000),now+1000).reason!,/loss threshold/);
 const b=newPaperAccount(p,now);enterPaper(b,p,s,quote(s),now);
 assert.match(enterPaper(b,p,other,quote(other,1,now+61000),now+61000).reason!,/stale/);
 b.paused=true;assert.match(enterPaper(b,p,other,quote(other),now).reason!,/paused/);
 assert.equal(markPaper(b,p,[quote(s,.5,now+1000)],now+1000).length,1);
});
test('historical/future signals, wrong-pool quotes, unknown numeric values and policy changes are blocked',()=>{
 const a=newPaperAccount(p,now),s=signal();
 for(const at of [now-1,now+1])assert.ok(enterPaper(a,p,{...s,at},quote(s),now).reason);
 for(const price of [NaN,Infinity,0,-1])assert.ok(enterPaper(a,p,s,quote(s,price),now).reason);
 assert.ok(enterPaper(a,p,s,{...quote(s),pool:'wrong'},now).reason);
 assert.ok(enterPaper(a,{...p,orderUsd:20},s,quote(s),now).reason);
 assert.throws(()=>paperPolicySchema.parse({...p,orderUsd:200}));
});
test('fees and slippage reduce equity and serialization preserves duplicate protection',()=>{
 const policy={...p,assumedFeePercent:1,assumedSlippagePercent:1,assumedNetworkFeeUsd:.1},a=newPaperAccount(policy,now),s=signal();
 enterPaper(a,policy,s,quote(s),now);assert.ok(paperEquity(a,policy).lt(100));
 const restored=JSON.parse(JSON.stringify(a));assert.match(enterPaper(restored,policy,s,quote(s),now).reason!,/already held/);
 assert.equal(markPaper(restored,policy,[quote(s,1.5,now+1000)],now+1000).length,0);
 assert.equal(markPaper(restored,policy,[quote(s,1.7,now+2000)],now+2000).length,1);
});
