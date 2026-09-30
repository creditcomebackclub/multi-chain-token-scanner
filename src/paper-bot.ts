import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { address, MINUTE, HOUR, type Chain } from './config.js';
import { watchDay } from './chart-pattern.js';
const pct = z.number().finite().min(0).max(25);
export const paperPolicySchema = z.object({
  bankrollUsd:z.number().finite().positive(), orderUsd:z.number().finite().positive(),
  maxPositions:z.number().int().min(1).max(20), dailyLossUsd:z.number().finite().positive(),
  maxEntriesPerDay:z.number().int().min(1).max(10), stopLossPercent:z.number().positive().max(90),
  takeProfitPercent:z.number().positive().max(1000), takeProfitSellPercent:z.number().positive().max(100),
  runnerTrailPercent:z.number().positive().max(90), assumedFeePercent:pct, assumedSlippagePercent:pct,
  assumedNetworkFeeUsd:z.number().finite().min(0),
}).strict().refine(p=>p.orderUsd<=p.bankrollUsd && p.assumedNetworkFeeUsd<p.orderUsd && p.dailyLossUsd<=p.bankrollUsd,'Invalid bankroll, order size, or loss threshold');
export type PaperPolicy=z.infer<typeof paperPolicySchema>;
export type PaperSignal={id:string;strategy:'new-token'|'chart';chain:Chain;token:string;pool:string;symbol:string;at:number};
export type PaperQuote={chain:Chain;token:string;pool:string;price:number;at:number};
export type PaperPosition={id:string;signal:PaperSignal;quantity:string;costRemaining:string;entryPrice:string;high:string;tookProfit:boolean;openedAt:number;mark:string;markAt:number};
export type PaperFill={id:string;positionId:string;signalId:string;strategy:PaperSignal['strategy'];chain:Chain;token:string;at:number;side:'buy'|'sell';reason:string;quantity:string;price:string;cashChange:string;realizedPnl:string};
export type PaperAccount={version:1;createdAt:number;policyHash:string;cash:string;realizedPnl:string;paused:boolean;day:string;dayStartEquity:string;entriesToday:number;positions:PaperPosition[];cooldowns:Record<string,number>};
const d=(v:Decimal.Value)=>new Decimal(v);
export const paperPolicyHash=(p:PaperPolicy)=>createHash('sha256').update(JSON.stringify(paperPolicySchema.parse(p))).digest('hex');
export function newPaperAccount(policy:PaperPolicy,now:number):PaperAccount {
  const p=paperPolicySchema.parse(policy);
  return {version:1,createdAt:now,policyHash:paperPolicyHash(p),cash:String(p.bankrollUsd),realizedPnl:'0',paused:false,day:watchDay(now),dayStartEquity:String(p.bankrollUsd),entriesToday:0,positions:[],cooldowns:{}};
}
function proceeds(p:PaperPolicy,quantity:Decimal,mark:Decimal) {
  return Decimal.max(0,quantity.mul(mark).mul(d(1).minus(p.assumedSlippagePercent/100)).mul(d(1).minus(p.assumedFeePercent/100)).minus(p.assumedNetworkFeeUsd));
}
export function paperEquity(a:PaperAccount,p:PaperPolicy) {
  return a.positions.reduce((sum,pos)=>sum.plus(proceeds(p,d(pos.quantity),d(pos.mark))),d(a.cash));
}
const identity=(chain:Chain,token:string)=>`${chain}:${address(chain,token)}`;
const quoteValid=(q:PaperQuote,chain:Chain,token:string,pool:string,now:number)=>q.chain===chain && q.token===token && q.pool===pool && Number.isFinite(q.price) && q.price>0 && Number.isFinite(q.at) && q.at<=now && now-q.at<=MINUTE;
export function refreshPaperDay(a:PaperAccount,p:PaperPolicy,now:number) {
  // Preserve the last known equity at midnight; new marks must then count toward today's loss.
  if(a.day!==watchDay(now)){a.day=watchDay(now);a.dayStartEquity=paperEquity(a,p).toString();a.entriesToday=0;}
  for(const [key,at] of Object.entries(a.cooldowns))if(now-at>24*HOUR)delete a.cooldowns[key];
}
export function enterPaper(a:PaperAccount,p:PaperPolicy,s:PaperSignal,q:PaperQuote,now:number):{fill?:PaperFill;reason?:string} {
  if(a.policyHash!==paperPolicyHash(p))return {reason:'Policy changed; existing account must be reviewed'};
  refreshPaperDay(a,p,now);
  if(a.paused)return {reason:'New entries paused'};
  if(!Number.isFinite(s.at)||s.at<a.createdAt||s.at>now||now-s.at>5*MINUTE)return {reason:'Signal is historical, future, or expired'};
  if(!quoteValid(q,s.chain,s.token,s.pool,now))return {reason:'Fresh exact-pool price unavailable'};
  if(a.positions.some(pos=>now-pos.markAt>MINUTE))return {reason:'Open-position prices are stale'};
  const key=identity(s.chain,s.token);
  if(a.positions.some(pos=>identity(pos.signal.chain,pos.signal.token)===key)||a.cooldowns[key]!==undefined)return {reason:'Token already held or on 24h cooldown'};
  if(a.positions.length>=p.maxPositions)return {reason:'Open-position limit reached'};
  if(a.entriesToday>=p.maxEntriesPerDay)return {reason:'Daily entry limit reached'};
  if(d(a.dayStartEquity).minus(paperEquity(a,p)).gte(p.dailyLossUsd))return {reason:'Daily loss threshold reached; new entries halted'};
  if(d(a.cash).lt(p.orderUsd))return {reason:'Insufficient virtual cash'};
  const fillPrice=d(q.price).mul(d(1).plus(p.assumedSlippagePercent/100));
  const net=d(p.orderUsd).minus(p.assumedNetworkFeeUsd).div(d(1).plus(p.assumedFeePercent/100));
  const quantity=net.div(fillPrice),id=createHash('sha256').update(`paper:${s.id}`).digest('hex');
  const pos:PaperPosition={id,signal:s,quantity:quantity.toString(),costRemaining:String(p.orderUsd),entryPrice:fillPrice.toString(),high:fillPrice.toString(),tookProfit:false,openedAt:now,mark:String(q.price),markAt:q.at};
  // Include assumed round-trip costs in the daily-loss check before committing an entry.
  const projected=paperEquity(a,p).minus(p.orderUsd).plus(proceeds(p,quantity,d(q.price)));
  if(d(a.dayStartEquity).minus(projected).gte(p.dailyLossUsd))return {reason:'Assumed entry/exit costs would breach daily loss threshold'};
  a.cash=d(a.cash).minus(p.orderUsd).toString();a.positions.push(pos);a.cooldowns[key]=now;a.entriesToday++;
  return {fill:{id:`${id}:buy`,positionId:id,signalId:s.id,strategy:s.strategy,chain:s.chain,token:s.token,at:now,side:'buy',reason:'Qualified scanner signal — SIMULATION',quantity:quantity.toString(),price:fillPrice.toString(),cashChange:d(p.orderUsd).neg().toString(),realizedPnl:'0'}};
}
export function markPaper(a:PaperAccount,p:PaperPolicy,quotes:PaperQuote[],now:number):PaperFill[] {
  if(a.policyHash!==paperPolicyHash(p))throw new Error('Paper policy changed; existing account must be reviewed');
  refreshPaperDay(a,p,now);const fills:PaperFill[]=[];
  for(const pos of [...a.positions]) {
    const q=quotes.find(q=>quoteValid(q,pos.signal.chain,pos.signal.token,pos.signal.pool,now));
    if(!q || q.at<=pos.markAt)continue;
    pos.mark=String(q.price);pos.markAt=q.at;pos.high=Decimal.max(pos.high,q.price).toString();
    let reason='',fraction=d(1);
    const exitValue=proceeds(p,d(pos.quantity),d(q.price));
    if(exitValue.lte(d(pos.costRemaining).mul(d(1).minus(p.stopLossPercent/100))))reason='Stop loss';
    else if(pos.tookProfit && d(q.price).lte(d(pos.high).mul(d(1).minus(p.runnerTrailPercent/100))))reason='Runner trailing stop';
    else if(!pos.tookProfit && exitValue.gte(d(pos.costRemaining).mul(d(1).plus(p.takeProfitPercent/100)))){reason='Partial take profit';fraction=d(p.takeProfitSellPercent).div(100);pos.tookProfit=true;}
    if(!reason)continue;
    const quantity=d(pos.quantity).mul(fraction),allocated=d(pos.costRemaining).mul(fraction),cash=proceeds(p,quantity,d(q.price)),realized=cash.minus(allocated);
    a.cash=d(a.cash).plus(cash).toString();a.realizedPnl=d(a.realizedPnl).plus(realized).toString();
    pos.quantity=d(pos.quantity).minus(quantity).toString();pos.costRemaining=d(pos.costRemaining).minus(allocated).toString();
    fills.push({id:`${pos.id}:${reason}`,positionId:pos.id,signalId:pos.signal.id,strategy:pos.signal.strategy,chain:pos.signal.chain,token:pos.signal.token,at:now,side:'sell',reason:`${reason} — SIMULATION`,quantity:quantity.toString(),price:d(q.price).mul(d(1).minus(p.assumedSlippagePercent/100)).toString(),cashChange:cash.toString(),realizedPnl:realized.toString()});
    if(d(pos.quantity).eq(0))a.positions=a.positions.filter(other=>other.id!==pos.id);
  }
  return fills;
}
