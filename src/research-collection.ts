import { createHash } from 'node:crypto';
import { address, HOUR, MINUTE, type Chain, type Config } from './config.js';
import { candles } from './chart-pattern.js';
import { excludedSymbols } from './shortlist.js';
import type { Store } from './store.js';
import type { DiscoveryCandidate } from './providers/discovery.js';
import { networks } from './providers/discovery.js';
import type { DexScreener, GoPlus } from './providers/enrichment.js';
import type { Http } from './providers/http.js';

export interface RegimePair { asset:'SOL'|'ETH'|'BNB';chain:Chain;token:string;pool:string }
export const REGIME_PAIRS:RegimePair[]=[
  {asset:'SOL',chain:'solana',token:'So11111111111111111111111111111111111111112',pool:'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'},
  {asset:'ETH',chain:'ethereum',token:'0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',pool:'0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'},
  {asset:'BNB',chain:'bnb',token:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',pool:'0x172fcd41e0913e95784454622d1c3724f546f849'},
];
const symbolKey=(symbol:string)=>symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');
const youngEligible=(candidate:DiscoveryCandidate,now:number)=>{
  const age=now-candidate.createdAt;
  return age>=10*MINUTE&&age<4*HOUR&&!excludedSymbols.has(symbolKey(candidate.symbol));
};

export class ResearchCollector{
  private stopped=false;
  constructor(private c:Config,private store:Store,private http:Http,private dex:DexScreener,private security:GoPlus,private regimePairs=REGIME_PAIRS){}
  stop(){this.stopped=true;}
  async tick(){
    if(this.stopped||!this.c.ingestionEnabled)return;
    if(!(this.c.regimeCandlesEnabled||this.c.youngPoolResearchEnabled||this.c.walletWatchEnabled))return;
    if(this.c.regimeCandlesEnabled)await this.collectRegimeCandles();
    if(this.c.youngPoolResearchEnabled||this.c.walletWatchEnabled)await this.sampleMarketResearch();
  }
  async observeYoungPools(candidates:DiscoveryCandidate[],now=Date.now()){
    if(this.stopped||!this.c.youngPoolResearchEnabled||!this.c.ingestionEnabled)return 0;
    let recorded=0;
    for(const chain of this.c.chains){
      const group=candidates.filter(candidate=>candidate.chain===chain&&youngEligible(candidate,now)).sort((a,b)=>b.volume5m-a.volume5m);
      let candidate:DiscoveryCandidate|undefined;
      for(const item of group){
        if(now-item.fetchedAt>=15*MINUTE||item.fetchedAt>now||this.stopped)continue;
        if(!await this.store.youngPoolResearchExists(chain,item.pool)){candidate=item;break;}
      }
      if(!candidate)continue;
      try{
        const market=(await this.dex.batch(chain,[candidate.token],now)).get(candidate.token)?.find(item=>item.pool===candidate.pool);
        if(!market)continue;
        const security=await this.security.check(chain,candidate.token,candidate.pool);
        const id=createHash('sha256').update(`young-pool-research-v1:${chain}:${candidate.pool}`).digest('hex');
        await this.store.saveYoungPoolResearch(id,candidate,market,security);recorded++;
      }catch{/* A later paced discovery cycle retries; no alert path depends on this collector. */}
    }
    await this.store.health('research-young-pools','healthy',`Recorded ${recorded} new 10m–4h controls this cycle; at most one exact-pool GoPlus check per chain.`);
    return recorded;
  }
  private async collectRegimeCandles(){
    const signal=AbortSignal.timeout(240_000);let saved=0,failures=0;
    for(const pair of this.regimePairs){
      if(this.stopped||signal.aborted)break;
      try{
        const root=this.c.coingeckoProKey?'https://pro-api.coingecko.com/api/v3/onchain':'https://api.geckoterminal.com/api/v2';
        const headers:Record<string,string>={'Accept':'application/json;version=20230203'};
        if(this.c.coingeckoProKey)headers['x-cg-pro-api-key']=this.c.coingeckoProKey;
        const url=`${root}/networks/${networks[pair.chain]}/pools/${encodeURIComponent(pair.pool)}/ohlcv/minute?aggregate=5&limit=500&currency=usd&token=${encodeURIComponent(pair.token)}&include_empty_intervals=true`;
        const data=await this.http.json(url,{signal,headers});
        if(address(pair.chain,data?.meta?.base?.address)!==address(pair.chain,pair.token))throw new Error('Regime candle identity mismatch');
        const bars=candles(data?.data?.attributes?.ohlcv_list,Date.now());
        await this.store.saveRegimeCandles(pair.asset,pair,bars);saved+=bars.length;
      }catch{failures++;}
    }
    await this.store.health('research-regime',failures?'degraded':'healthy',`${saved} closed 5m SOL/ETH/BNB candle rows observed; ${failures} asset refresh failures. Uses the shared paced candle client.`);
  }
  private async sampleMarketResearch(){
    const groups=[
      {kind:'young',enabled:this.c.youngPoolResearchEnabled,rows:this.c.youngPoolResearchEnabled?await this.store.youngPoolResearchPending():[]},
      {kind:'wallet',enabled:this.c.walletWatchEnabled,rows:this.c.walletWatchEnabled?await this.store.walletWatchResearchPending():[]},
    ];
    for(const group of groups){
      if(!group.enabled)continue;
      for(const chain of this.c.chains){
        const rows=group.rows.filter((row:any)=>row.chain===chain&&typeof row.pool==='string');
        if(!rows.length)continue;
        try{
          const markets=await this.dex.batch(chain,[...new Set(rows.map((row:any)=>row.token))]);
          for(const row of rows as any[]){
            const market=markets.get(row.token)?.find(item=>item.pool===row.pool);if(!market)continue;
            if(group.kind==='young')await this.store.saveYoungPoolResearchSample(row.id,market.fetchedAt,market.price,market.liquidity);
            else await this.store.saveWalletWatchResearchSample(row.id,market.fetchedAt,market.price,market.liquidity);
          }
        }catch{/* Outcomes remain incomplete and retry on the next cycle. */}
      }
    }
    await this.store.updateMarketResearchOutcomes();
  }
}
