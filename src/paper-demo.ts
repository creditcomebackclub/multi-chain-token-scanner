import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {newPaperAccount,enterPaper,markPaper,paperEquity,paperPolicySchema,type PaperSignal,type PaperQuote,type PaperFill} from './paper-bot.js';
const policy=paperPolicySchema.parse(JSON.parse(readFileSync(new URL('../config/paper-bot.example.json',import.meta.url),'utf8')));
const now=Date.now(),account=newPaperAccount(policy,now),fills:PaperFill[]=[];
for(const [index,strategy] of (['new-token','chart'] as const).entries()) {
 const token='0x'+String(index+1).repeat(40);
 const signal:PaperSignal={id:`demo-${strategy}`,strategy,chain:'ethereum',token,pool:token,symbol:`SIM-${index+1}`,at:now};
 const q:PaperQuote={chain:signal.chain,token,pool:token,price:1,at:now};
 const entry=enterPaper(account,policy,signal,q,now);if(entry.fill)fills.push(entry.fill);
 const positions=account.positions.map(pos=>({chain:pos.signal.chain,token:pos.signal.token,pool:pos.signal.pool,price:pos.signal.id===signal.id?(index===0?1.7:.7):1.2,at:now+1000+index*1000}));
 fills.push(...markPaper(account,policy,positions,now+1000+index*1000));
}
const report={mode:'PAPER ONLY — SYNTHETIC SCENARIO, NOT PERFORMANCE EVIDENCE',liveExecutionImplemented:false,approvedRealMoneyLimits:false,policy,account,estimatedEquityUsd:paperEquity(account,policy).toString(),fills};
mkdirSync('outputs',{recursive:true});writeFileSync('outputs/paper-bot-demo.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({mode:report.mode,signals:2,simulatedFills:fills.length,estimatedEquityUsd:report.estimatedEquityUsd,report:'outputs/paper-bot-demo.json'},null,2));
