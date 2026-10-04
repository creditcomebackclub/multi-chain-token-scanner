import type { Config, Chain } from './config.js';
import type { Market } from './types.js';
import type { DexScreener } from './providers/enrichment.js';
import type { ManagedPosition } from './chart-monitor.js';
import type { Store } from './store.js';

export const COST_MODEL_VERSION='cost-model-v1';
export type CostProvenance='observed'|'model:cost-model-v1'|'modeled:flat-bps';
export type LiquidityBucket='<50k'|'50k-<100k'|'100k-<250k'|'250k-<1m'|'>=1m';
export type EntryCostEvidence={
  at:number;dollars:number;fillPrice:number;alertReferencePrice:number;
  alertSpotPrice:number;alertLiquidity:number;alertSpotAt:number|null;spotPrice:number;liquidity:number;spotAt:number;
};
export type ExitCostEvidence={at:number;dollarsReceived:number;fillPrice:number;feesUsd:number;spotPrice:number;liquidity:number;spotAt:number};
export type ExecutionCostObservation={
  positionId:string;chain:Chain;token:string;pool:string;entry:EntryCostEvidence;exit:ExitCostEvidence|null;
  liquidityBucket:LiquidityBucket;observedCostBps:number|null;modelCostBps:number|null;
  observedProvenance:'observed'|null;modelProvenance:'model:cost-model-v1'|null;
};
export type CostCalibration={count:number;coveragePct:number|null;medianUnderestimateBps:number|null;p90UnderestimateBps:number|null;underestimated:number;invalidated:boolean;status:string};
export type CostDistribution={count:number;median:number|null;p75:number|null;p90:number|null};
export type CostSummary={overall:CostDistribution;byChain:Record<string,CostDistribution>;byLiquidity:Record<string,CostDistribution>;calibration:CostCalibration;
  modelPrimaryUsd:number;modeledPrimary:CostDistribution;modeled250:CostDistribution};

export function liquidityBucket(liquidity:number):LiquidityBucket{
  if(liquidity<50_000)return'<50k';if(liquidity<100_000)return'50k-<100k';if(liquidity<250_000)return'100k-<250k';if(liquidity<1_000_000)return'250k-<1m';return'>=1m';
}
export function quantile(values:number[],p:number):number|null{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!sorted.length)return null;
  const index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);
}
export function distribution(values:number[]):CostDistribution{return{count:values.length,median:quantile(values,.5),p75:quantile(values,.75),p90:quantile(values,.9)}};
export function observedCost(entry:EntryCostEvidence,exit:ExitCostEvidence){
  const entryReferenceBps=(entry.fillPrice/entry.alertReferencePrice-1)*10_000;
  const entrySpotBps=(entry.fillPrice/entry.spotPrice-1)*10_000;
  const exitSpotBps=(exit.spotPrice/exit.fillPrice-1)*10_000;
  const feesBps=exit.feesUsd/entry.dollars*10_000;
  return{entryReferenceBps,entrySpotBps,exitSpotBps,feesBps,roundTripBps:Math.max(0,entrySpotBps+exitSpotBps+feesBps)};
}
export function modeledCostBps(input:{dollars:number;entryLiquidity:number;exitLiquidity:number;feeBpsPerSide:number;networkFeeUsd:number}){
  const {dollars:q,entryLiquidity,exitLiquidity,feeBpsPerSide,networkFeeUsd}=input;
  if(![q,entryLiquidity,exitLiquidity,feeBpsPerSide,networkFeeUsd].every(Number.isFinite)||q<=0||entryLiquidity<=0||exitLiquidity<=0)return null;
  const impact=1.5*(q/(entryLiquidity/2)+q/(exitLiquidity/2))*10_000;
  return Math.max(100,impact+2*feeBpsPerSide+(2*networkFeeUsd/q)*10_000);
}
export function calibration(rows:{observedCostBps:number;modelCostBps:number}[],stickyInvalidated=false):CostCalibration{
  const gaps=rows.map(row=>Math.max(0,row.observedCostBps-row.modelCostBps)),underestimated=gaps.filter(value=>value>1).length;
  const conservative=rows.filter(row=>row.modelCostBps>=row.observedCostBps).length;
  const invalidated=stickyInvalidated||(rows.length>=20&&underestimated/rows.length>.25);
  return{count:rows.length,coveragePct:rows.length?conservative/rows.length*100:null,
    medianUnderestimateBps:quantile(gaps,.5),p90UnderestimateBps:quantile(gaps,.9),underestimated,invalidated,
    status:invalidated?'invalidated — preregister cost-model-v2 before reuse':rows.length<20?'valid — calibration not yet evaluable':'valid'};
}

const exact=(markets:Market[]|undefined,pool:string)=>markets?.find(m=>m.pool.toLowerCase()===pool.toLowerCase());
export class ExecutionCosts{
  constructor(private c:Config,private store:Store,private dex:DexScreener){}
  private async market(chain:Chain,token:string,pool:string,now:number){
    const market=exact((await this.dex.batch(chain,[token],now)).get(token),pool);
    if(!market)throw new Error('The exact alert pool is unavailable from DEX Screener; no fill evidence was saved.');
    return market;
  }
  async entered(token:string,dollars:number,price:number,now=Date.now()):Promise<ManagedPosition>{
    const alert=await this.store.chartAlertForEntry(token);
    if(!alert)throw new Error('No delivered 5M buy alert matches that contract in the last 24 hours.');
    const market=await this.market(alert.chain,alert.token,alert.pool,now),reference=Number(alert.data?.plan?.referenceEntry);
    if(!Number.isFinite(reference)||reference<=0)throw new Error('The matching alert has no valid reference price.');
    const alertSpotPrice=Number(alert.data?.evidence?.market?.price??reference);
    const alertLiquidity=Number(alert.data?.evidence?.market?.liquidity??alert.data?.pair?.liquidity);
    const entry:EntryCostEvidence={at:now,dollars,fillPrice:price,alertReferencePrice:reference,
      alertSpotPrice:Number.isFinite(alertSpotPrice)&&alertSpotPrice>0?alertSpotPrice:reference,
      alertLiquidity:Number.isFinite(alertLiquidity)&&alertLiquidity>=0?alertLiquidity:market.liquidity,
      alertSpotAt:Number.isFinite(Number(alert.data?.evidence?.market?.fetchedAt))?Number(alert.data.evidence.market.fetchedAt):null,
      spotPrice:market.price,liquidity:market.liquidity,spotAt:market.fetchedAt};
    return this.store.registerChartPosition(token,dollars,price,entry);
  }
  async exited(token:string,dollarsReceived:number,price:number,feesUsd=0,now=Date.now()){
    if(!token||![dollarsReceived,price,feesUsd].every(Number.isFinite)||dollarsReceived<0||price<=0||feesUsd<0)throw new Error('Use /exited CONTRACT DOLLARS_RECEIVED PRICE [FEES_USD] with non-negative dollars and fees and a positive price.');
    const position=await this.store.chartPositionForExit(token);if(!position)throw new Error('No position awaiting an observed exit matches that contract.');
    const market=await this.market(position.chain,position.token,position.pool,now);
    const exit:ExitCostEvidence={at:now,dollarsReceived,fillPrice:price,feesUsd,spotPrice:market.price,liquidity:market.liquidity,spotAt:market.fetchedAt};
    const completed=await this.store.completeExecutionCost(position.id,exit,this.c);return{position,...completed};
  }
  summary(){return this.store.executionCostSummary();}
}
