import { BAR, type Candle, type ResearchFeatures, type Setup } from './chart-pattern.js';
import { HOUR, MINUTE } from './config.js';

export const RESEARCH_HORIZONS = [15*MINUTE,30*MINUTE,HOUR,3*HOUR,6*HOUR,12*HOUR,24*HOUR] as const;
export type ResearchOutcome = {
  entryModel:'first_dex_quote'|'next_5m_open_proxy'; entry:number|null; entryAt:number|null; observedMinutes:number; complete:boolean;
  costBps:number; horizons:Record<string,{at:number;price:number;grossReturnPct:number;netReturnPct:number}|null>;
  minPrice:number|null;maxPrice:number|null;maePct:number|null;mfePct:number|null;maeAt:number|null;mfeAt:number|null;
  firstHit:'tp1'|'stop'|'ambiguous'|null;tp1At:number|null;tp2At:number|null;stopAt:number|null;
};

const pct=(price:number,entry:number)=>(price/entry-1)*100;
export function evaluateResearch(at:number,candles:Candle[],features:ResearchFeatures,setup:Setup|undefined,costBps:number,now:number,quote?:{price:number;fetchedAt:number}|null):ResearchOutcome{
  const future=candles.filter(c=>c.at>=at&&c.at<at+24*HOUR).sort((a,b)=>a.at-b.at),first=future[0];
  if(!first)return{entryModel:'next_5m_open_proxy',entry:null,entryAt:null,observedMinutes:0,complete:false,costBps,horizons:{},minPrice:null,maxPrice:null,maePct:null,mfePct:null,maeAt:null,mfeAt:null,firstHit:null,tp1At:null,tp2At:null,stopAt:null};
  const hasQuote=!!quote&&Number.isFinite(quote.price)&&quote.price>0&&quote.fetchedAt>=at,entry=hasQuote?quote!.price:first.open,entryAt=hasQuote?quote!.fetchedAt:first.at,through=future.filter(c=>c.at+BAR<=Math.min(now,at+24*HOUR));
  let minPrice=entry,maxPrice=entry,maeAt=first.at,mfeAt=first.at,firstHit:ResearchOutcome['firstHit']=null,tp1At:null|number=null,tp2At:null|number=null,stopAt:null|number=null;
  const stop=setup?setup.lower*.995:features.supportLower?features.supportLower*.995:null,tp1=entry*1.05,tp2=entry*1.10;
  for(const candle of through){
    if(candle.low<minPrice){minPrice=candle.low;maeAt=candle.at+BAR;}if(candle.high>maxPrice){maxPrice=candle.high;mfeAt=candle.at+BAR;}
    const hitStop=stop!==null&&candle.low<=stop,hitTp1=candle.high>=tp1;
    if(!firstHit&&(hitStop||hitTp1)){firstHit=hitStop&&hitTp1?'ambiguous':hitTp1?'tp1':'stop';if(hitStop)stopAt=candle.at+BAR;if(hitTp1)tp1At=candle.at+BAR;}
    if(tp1At===null&&hitTp1)tp1At=candle.at+BAR;if(tp2At===null&&candle.high>=tp2)tp2At=candle.at+BAR;
  }
  const horizons:ResearchOutcome['horizons']={};
  for(const horizon of RESEARCH_HORIZONS){const key=`${horizon/MINUTE}m`,c=through.find(row=>row.at+BAR>=at+horizon);horizons[key]=c?{at:c.at+BAR,price:c.close,grossReturnPct:pct(c.close,entry),netReturnPct:pct(c.close,entry)-costBps/100}:null;}
  const last=through.at(-1),observedMinutes=last?Math.max(0,(last.at+BAR-at)/MINUTE):0;
  return{entryModel:hasQuote?'first_dex_quote':'next_5m_open_proxy',entry,entryAt,observedMinutes,complete:observedMinutes>=24*60,costBps,horizons,minPrice,maxPrice,maePct:pct(minPrice,entry),mfePct:pct(maxPrice,entry),maeAt,mfeAt,firstHit,tp1At,tp2At,stopAt};
}
