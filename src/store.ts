import type { DiscoveryCandidate } from './providers/discovery.js';
import { chartTradePlan } from './chart-trade-plan.js';
import { BAR, CHART_RULE, type Candle, type ResearchFeatures, type Setup } from './chart-pattern.js';
import { evaluateResearch, type ResearchOutcome } from './chart-research.js';
import { analyzeChartLearning, type LearningRow } from './chart-learning.js';
import { forwardShadowVariants, shadowMaturityCutoff, simulateForwardShadow, summarizeForwardShadow, type ShadowOutcome } from './shadow-research.js';
import type { AlertOutcome, ManagedPosition, PositionEvent } from './chart-monitor.js';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { DAY, HOUR, MAX_ALERTS_PER_24H, MAX_SCOUT_ALERTS_PER_24H, MINUTE, RULE_ID, rules, type Chain, type Config } from './config.js';
import type { Discovery, Health, Market, Reference, Security, Snapshot, Trade, WalletTrade } from './types.js';
import type { ShortlistEntry } from './shortlist.js';
import { schema } from './schema.js';
import { calibration, distribution, liquidityBucket, modeledCostBps, observedCost, type CostSummary, type EntryCostEvidence, type ExitCostEvidence, type ExecutionCostObservation } from './execution-costs.js';
export interface Sql { query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> }
export interface Database extends Sql { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close(): Promise<void> }
export type ResearchCollectorName='regime'|'young_pool';
export type ResearchCollectorCoverage={collector:ResearchCollectorName;activatedAt:number;days:number;observations:number;lastObservationAt:number|null};
export type ResearchMilestoneEvent={key:string;kind:string;data:any;status:'reserved'|'sent'|'unknown';reservedAt:number;sentAt:number|null;messageId:number|null};
export type DatabaseStorage={usageMb:number;tables:{name:string;sizeMb:number}[]};
export function postgres(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
  pool.on('error', () => console.error('Postgres connection unavailable'));
  return {
    query: (sql, params) => pool.query(sql, params), close: () => pool.end(),
    transaction: async fn => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    },
  };
}
const date = (at: number) => new Date(at).toISOString();
const usage = (table:string) => `SELECT chain,token FROM ${table}
  WHERE reserved_at > clock_timestamp()-interval '24 hours' OR sent_at > clock_timestamp()-interval '24 hours' OR status IN ('reserved','sending')`;
export const candidateUsage = usage('alerts');
const chartUsage=usage('chart_setup_alerts'), shortlistUsage=usage('shortlist_alerts');
export class Store {
  constructor(readonly db: Database,private runtimeConfig?:Pick<Config,'shadowPositionUsd'|'fomoFeeBpsPerSide'|'networkFeeUsd'>) {}
  async migrate() {
    await this.db.query(schema);
    await this.db.query('INSERT INTO rule_versions(id,config) VALUES($1,$2) ON CONFLICT DO NOTHING', [RULE_ID, JSON.stringify(rules)]);
    await this.db.query("UPDATE chart_setup_alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at < clock_timestamp()-interval '2 minutes'");
    // A process may have died after Telegram accepted a message. Never retry ambiguous sends.
    await this.db.query("UPDATE alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at < clock_timestamp()-interval '2 minutes'");
    await this.db.query("UPDATE shortlist_alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at < clock_timestamp()-interval '2 minutes'");
    await this.db.query("UPDATE wallet_watch_alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at < clock_timestamp()-interval '2 minutes'");
  }
  async ensureResearchCollectorActivations(collectors:ResearchCollectorName[],configuredAt:number|null,now=Date.now()){
    for(const collector of collectors){
      if((await this.db.query('SELECT 1 FROM research_collector_activations WHERE collector=$1',[collector])).rows.length)continue;
      let activatedAt=configuredAt;
      if(activatedAt===null){
        const provider=collector==='regime'?'research-regime':'research-young-pools';
        const since=(await this.db.query("SELECT data->>'since' AS since FROM provider_health WHERE provider=$1",[provider])).rows[0]?.since;
        if(since!==undefined&&Number.isFinite(Number(since)))activatedAt=Number(since);
      }
      if(activatedAt===null&&collector==='young_pool'){
        const at=(await this.db.query('SELECT extract(epoch FROM min(created_at))*1000 AS at FROM young_pool_research_observations')).rows[0]?.at;
        if(at!==null&&at!==undefined&&Number.isFinite(Number(at)))activatedAt=Number(at);
      }
      await this.db.query('INSERT INTO research_collector_activations(collector,activated_at) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [collector,date(activatedAt??now)]);
    }
  }
  async researchCollectorCoverage(collectors:ResearchCollectorName[]):Promise<ResearchCollectorCoverage[]>{
    const result:ResearchCollectorCoverage[]=[];
    for(const collector of collectors){
      const activation=(await this.db.query('SELECT extract(epoch FROM activated_at)*1000 AS at FROM research_collector_activations WHERE collector=$1',[collector])).rows[0]?.at;
      if(activation===undefined)continue;
      const table=collector==='regime'?'research_regime_candles':'young_pool_research_observations';
      const row=(await this.db.query(`SELECT count(*)::int AS observations,count(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS days,
        extract(epoch FROM max(at))*1000 AS "lastObservationAt" FROM ${table} WHERE at>=$1`,[date(Number(activation))])).rows[0];
      result.push({collector,activatedAt:Number(activation),days:Number(row.days),observations:Number(row.observations),
        lastObservationAt:row.lastObservationAt===null?null:Number(row.lastObservationAt)});
    }
    return result;
  }
  async claimResearchMilestoneRun(now=Date.now()):Promise<boolean>{
    return this.db.transaction(async q=>{
      const row=(await q.query('SELECT last_checked_at FROM research_milestone_runs WHERE id=1 FOR UPDATE')).rows[0];
      if(new Date(row.last_checked_at).getTime()>now-HOUR)return false;
      await q.query('UPDATE research_milestone_runs SET last_checked_at=$1 WHERE id=1',[date(now)]);return true;
    });
  }
  async researchMilestoneEvents():Promise<ResearchMilestoneEvent[]>{
    return (await this.db.query(`SELECT key,kind,data,status,extract(epoch FROM reserved_at)*1000 AS "reservedAt",
      extract(epoch FROM sent_at)*1000 AS "sentAt",message_id AS "messageId" FROM research_milestone_events ORDER BY reserved_at,key`)).rows
      .map(row=>({...row,reservedAt:Number(row.reservedAt),sentAt:row.sentAt===null?null:Number(row.sentAt),messageId:row.messageId===null?null:Number(row.messageId)}));
  }
  async claimResearchMilestone(key:string,kind:string,data:unknown):Promise<boolean>{
    return !!(await this.db.query("INSERT INTO research_milestone_events(key,kind,data,status) VALUES($1,$2,$3,'reserved') ON CONFLICT DO NOTHING RETURNING key",
      [key,kind,JSON.stringify(data)])).rows.length;
  }
  async finishResearchMilestone(key:string,status:'sent'|'unknown',messageId?:number){
    await this.db.query("UPDATE research_milestone_events SET status=$2,message_id=$3,sent_at=CASE WHEN $2='sent' THEN clock_timestamp() ELSE NULL END WHERE key=$1 AND status='reserved'",
      [key,status,messageId??null]);
  }
  async databaseStorage():Promise<DatabaseStorage>{
    const usage=Number((await this.db.query('SELECT pg_database_size(current_database())::bigint AS bytes')).rows[0].bytes);
    const names=['chart_candles','chart_research_observations','chart_research_outcomes','research_regime_candles','young_pool_research_observations',
      'young_pool_research_samples','young_pool_research_outcomes','wallet_watch_research_observations','wallet_watch_research_samples','wallet_watch_research_outcomes',
      'shadow_variant_observations','shadow_variant_outcomes'];
    const rows=(await this.db.query(`SELECT name,pg_total_relation_size(to_regclass(name))::bigint AS bytes
      FROM unnest($1::text[]) AS tables(name) WHERE to_regclass(name) IS NOT NULL ORDER BY bytes DESC`,[names])).rows;
    return{usageMb:usage/1024/1024,tables:rows.map(row=>({name:String(row.name),sizeMb:Number(row.bytes)/1024/1024}))};
  }
  async saveSetupCandidates(entries: DiscoveryCandidate[], candleRetentionDays=35) {
    if (entries.length) await this.db.query(`INSERT INTO setup_candidates(chain,token,pool,data)
      SELECT e->>'chain',e->>'token',e->>'pool',e FROM jsonb_array_elements($1::jsonb) e
      ON CONFLICT(chain,token,pool) DO UPDATE SET data=excluded.data`, [JSON.stringify(entries)]);
    await this.db.query("DELETE FROM setup_candidates WHERE (data->>'fetchedAt')::double precision < extract(epoch FROM clock_timestamp()-interval '2 days')*1000");
    await this.db.query("DELETE FROM chart_watchlists WHERE created_at < clock_timestamp()-interval '7 days'");
    await this.db.query("DELETE FROM chart_pair_states WHERE (data->>'checkedAt')::double precision < extract(epoch FROM clock_timestamp()-interval '7 days')*1000");
    await this.db.query('DELETE FROM chart_candles WHERE at < clock_timestamp()-make_interval(days=>$1)',[candleRetentionDays]);
  }
  async setupCandidates(): Promise<DiscoveryCandidate[]> { return (await this.db.query('SELECT data FROM setup_candidates')).rows.map(r => r.data); }
  async chartWatchlist(day: string): Promise<DiscoveryCandidate[]> { return (await this.db.query('SELECT data FROM chart_watchlists WHERE day=$1', [day])).rows[0]?.data ?? []; }
  async saveChartWatchlist(day: string, pairs: DiscoveryCandidate[]) {
    await this.db.query('INSERT INTO chart_watchlists(day,data) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET data=excluded.data', [day, JSON.stringify(pairs)]);
  }
  async chartState(chain: Chain, pool: string): Promise<{ lastAt: number; checkedAt: number; detail: string } | undefined> {
    return (await this.db.query('SELECT data FROM chart_pair_states WHERE chain=$1 AND pool=$2', [chain,pool])).rows[0]?.data;
  }
  async saveChartState(chain: Chain, pool: string, data: { lastAt: number; checkedAt: number; detail: string }) {
    await this.db.query('INSERT INTO chart_pair_states(chain,pool,data) VALUES($1,$2,$3) ON CONFLICT(chain,pool) DO UPDATE SET data=excluded.data', [chain,pool,JSON.stringify(data)]);
  }
  async saveChartResearch(id:string,pair:DiscoveryCandidate,bars:Candle[],features:ResearchFeatures,setup?:Setup,signalId?:string) {
    await this.db.transaction(async q=>{
      await q.query(`INSERT INTO chart_candles(chain,token,pool,at,open,high,low,close,volume)
        SELECT $1,$2,$3,to_timestamp((x->>'at')::double precision/1000),(x->>'open')::double precision,(x->>'high')::double precision,
          (x->>'low')::double precision,(x->>'close')::double precision,(x->>'volume')::double precision
        FROM jsonb_array_elements($4::jsonb) x ON CONFLICT DO NOTHING`,[pair.chain,pair.token,pair.pool,JSON.stringify(bars)]);
      const data={pair,features,setup:setup??null,plan:setup?chartTradePlan(setup):null,signalId:signalId??null};
      await q.query(`INSERT INTO chart_research_observations(id,rule,chain,token,pool,at,kind,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET data=chart_research_observations.data||excluded.data,kind=excluded.kind,updated_at=clock_timestamp()`,
        [id,CHART_RULE,pair.chain,pair.token,pair.pool,date(features.at),setup?'signal':'control',JSON.stringify(data)]);
    });
    // Shadow enrollment is repairable and must never make the live chart path fail.
    await Promise.all(forwardShadowVariants.filter(variant=>features.at>=variant.lockedStart).map(variant=>this.db.query(`INSERT INTO shadow_variant_observations(variant_id,observation_id,population,at)
      SELECT r.variant_id,$2,$3,$4 FROM shadow_variant_registry r
      JOIN chart_research_observations o ON o.id=$2
      WHERE r.variant_id=$1 AND o.created_at>=r.activated_at ON CONFLICT DO NOTHING`,[variant.id,id,setup?'signal':'control',date(features.at)]).catch(()=>undefined)));
  }
  async saveChartCandles(pair:DiscoveryCandidate,bars:Candle[]) {
    await this.db.query(`INSERT INTO chart_candles(chain,token,pool,at,open,high,low,close,volume)
      SELECT $1,$2,$3,to_timestamp((x->>'at')::double precision/1000),(x->>'open')::double precision,(x->>'high')::double precision,
        (x->>'low')::double precision,(x->>'close')::double precision,(x->>'volume')::double precision
      FROM jsonb_array_elements($4::jsonb) x ON CONFLICT DO NOTHING`,[pair.chain,pair.token,pair.pool,JSON.stringify(bars)]);
  }
  async saveRegimeCandles(asset:'SOL'|'ETH'|'BNB',pair:{chain:Chain;token:string;pool:string},bars:Candle[]) {
    if(!bars.length)return;
    await this.db.query(`INSERT INTO research_regime_candles(asset,chain,token,pool,at,open,high,low,close,volume)
      SELECT $1,$2,$3,$4,to_timestamp((x->>'at')::double precision/1000),(x->>'open')::double precision,(x->>'high')::double precision,
        (x->>'low')::double precision,(x->>'close')::double precision,(x->>'volume')::double precision
      FROM jsonb_array_elements($5::jsonb) x ON CONFLICT DO NOTHING`,[asset,pair.chain,pair.token,pair.pool,JSON.stringify(bars)]);
  }
  async saveYoungPoolResearch(id:string,pair:DiscoveryCandidate,market:Market,security:Security) {
    const evidence={kind:'control',pair,market:{pool:market.pool,price:market.price,liquidity:market.liquidity,fdv:market.fdv,marketCap:market.marketCap,fetchedAt:market.fetchedAt},
      security:{status:security.status,reasons:security.reasons,buyTax:security.buyTax,sellTax:security.sellTax,checkedAt:security.checkedAt}};
    await this.db.transaction(async q=>{
      const inserted=await q.query(`INSERT INTO young_pool_research_observations(id,chain,token,pool,at,data)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,[id,pair.chain,pair.token,pair.pool,date(pair.fetchedAt),JSON.stringify(evidence)]);
      if(inserted.rows.length)await q.query(`INSERT INTO young_pool_research_samples(observation_id,at,price,liquidity)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,date(market.fetchedAt),market.price,market.liquidity]);
    });
  }
  async youngPoolResearchExists(chain:Chain,pool:string){
    return !!(await this.db.query('SELECT 1 FROM young_pool_research_observations WHERE chain=$1 AND pool=$2 LIMIT 1',[chain,pool])).rows.length;
  }
  async youngPoolResearchPending(now=Date.now()) {
    return (await this.db.query(`SELECT o.id,o.chain,o.token,o.pool,extract(epoch FROM o.at)*1000 AS "sourceAt",o.data
      FROM young_pool_research_observations o LEFT JOIN young_pool_research_outcomes r ON r.observation_id=o.id
      WHERE o.at>$1 AND (r.observation_id IS NULL OR (r.data->>'complete')::boolean=false) ORDER BY o.at LIMIT 100`,[date(now-7*DAY)])).rows
      .map(row=>({...row,sourceAt:Number(row.sourceAt)}));
  }
  async saveYoungPoolResearchSample(id:string,at:number,price:number,liquidity:number){
    await this.db.query(`INSERT INTO young_pool_research_samples(observation_id,at,price,liquidity)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,date(Math.floor(at/MINUTE)*MINUTE),price,liquidity]);
  }
  async saveWalletWatchResearch(trade:WalletTrade,detectedAt:number,market:Market){
    if(trade.side!=='buy')return;
    const delayMs=Math.max(0,detectedAt-trade.at),data={side:trade.side,tokenAmount:trade.tokenAmount,
      quoteSymbol:trade.quoteSymbol,quoteAmount:trade.quoteAmount,quoteUsd:trade.quoteUsd,
      market:{pool:market.pool,price:market.price,liquidity:market.liquidity,fdv:market.fdv,marketCap:market.marketCap,fetchedAt:market.fetchedAt}};
    await this.db.transaction(async q=>{
      const inserted=await q.query(`INSERT INTO wallet_watch_research_observations(id,chain,token,source_at,detected_at,delay_ms,data)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,[trade.id,trade.chain,trade.token,date(trade.at),date(detectedAt),delayMs,JSON.stringify(data)]);
      if(inserted.rows.length)await q.query(`INSERT INTO wallet_watch_research_samples(observation_id,at,price,liquidity)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[trade.id,date(market.fetchedAt),market.price,market.liquidity]);
    });
  }
  async walletWatchResearchPending(now=Date.now()){
    return (await this.db.query(`SELECT o.id,o.chain,o.token,o.data->'market'->>'pool' AS pool,
      extract(epoch FROM o.source_at)*1000 AS "sourceAt",o.data
      FROM wallet_watch_research_observations o LEFT JOIN wallet_watch_research_outcomes r ON r.observation_id=o.id
      WHERE o.source_at>$1 AND (r.observation_id IS NULL OR (r.data->>'complete')::boolean=false) ORDER BY o.source_at LIMIT 100`,[date(now-7*DAY)])).rows
      .map(row=>({...row,sourceAt:Number(row.sourceAt)}));
  }
  async saveWalletWatchResearchSample(id:string,at:number,price:number,liquidity:number){
    await this.db.query(`INSERT INTO wallet_watch_research_samples(observation_id,at,price,liquidity)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[id,date(Math.floor(at/MINUTE)*MINUTE),price,liquidity]);
  }
  async updateMarketResearchOutcomes(now=Date.now()){
    const update=async(kind:'young_pool'|'wallet_watch')=>{
      const observations=`${kind}_research_observations`,samples=`${kind}_research_samples`,outcomes=`${kind}_research_outcomes`;
      const rows=(await this.db.query(`SELECT o.id,extract(epoch FROM ${kind==='wallet_watch'?'o.source_at':'o.at'})*1000 AS at,o.data,
        coalesce(jsonb_agg(jsonb_build_object('at',extract(epoch FROM s.at)*1000,'price',s.price,'liquidity',s.liquidity) ORDER BY s.at)
          FILTER(WHERE s.observation_id IS NOT NULL),'[]'::jsonb) AS samples
        FROM ${observations} o LEFT JOIN ${outcomes} r ON r.observation_id=o.id LEFT JOIN ${samples} s ON s.observation_id=o.id
        WHERE ${kind==='wallet_watch'?'o.source_at':'o.at'}>$1 AND (r.observation_id IS NULL OR (r.data->>'complete')::boolean=false)
        GROUP BY o.id,o.data,${kind==='wallet_watch'?'o.source_at':'o.at'} LIMIT 200`,[date(now-7*DAY)])).rows;
      if(!rows.length)return 0;
      const values=rows.map(row=>({id:row.id,data:marketResearchOutcome(Number(row.at),Number(row.data?.market?.price),Number(row.data?.market?.liquidity),row.samples,now)}));
      await this.db.query(`INSERT INTO ${outcomes}(observation_id,data,updated_at)
        SELECT x->>'id',x->'data',clock_timestamp() FROM jsonb_array_elements($1::jsonb) x
        ON CONFLICT(observation_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,[JSON.stringify(values)]);
      return values.length;
    };
    return{youngPool:await update('young_pool'),walletWatch:await update('wallet_watch')};
  }
  async chartResearchBackfillCandidate(now:number):Promise<DiscoveryCandidate|undefined>{
    const row=(await this.db.query(`SELECT pair FROM (SELECT DISTINCT ON(o.chain,o.pool) o.data->'pair' AS pair,o.at
      FROM chart_research_observations o LEFT JOIN chart_research_outcomes r ON r.observation_id=o.id
      WHERE o.at>$1 AND o.at<$2 AND (r.observation_id IS NULL OR (r.data->>'complete')::boolean=false)
      ORDER BY o.chain,o.pool,o.at) pending ORDER BY at LIMIT 1`,[date(now-7*DAY),date(now-24*HOUR)])).rows[0];
    return row?.pair;
  }
  async saveChartResearchEvidence(id:string,evidence:unknown) {
    const value=JSON.stringify(evidence);
    await this.db.transaction(async q=>{
      await q.query("UPDATE chart_research_observations SET data=data||jsonb_build_object('evidence',$2::jsonb),updated_at=clock_timestamp() WHERE id=$1",[id,value]);
      await q.query("UPDATE chart_signals SET data=data||jsonb_build_object('evidence',$2::jsonb),updated_at=clock_timestamp() WHERE id=(SELECT data->>'signalId' FROM chart_research_observations WHERE id=$1)",[id,value]);
    });
  }
  async updateChartResearchOutcomes(now:number,costBps:number) {
    const observations=(await this.db.query(`SELECT o.id,o.chain,o.pool,extract(epoch FROM o.at)*1000 AS at,o.data
      FROM chart_research_observations o LEFT JOIN chart_research_outcomes r ON r.observation_id=o.id
      WHERE o.at>$1 AND o.at<$2 AND (r.observation_id IS NULL OR ((r.data->>'complete')::boolean=false AND r.updated_at<clock_timestamp()-interval '10 minutes'))
      ORDER BY r.updated_at ASC NULLS FIRST,o.at ASC LIMIT 500`,[date(now-25*HOUR),date(now-15*MINUTE)])).rows;
    if(!observations.length)return 0;
    const candles=(await this.db.query(`SELECT chain,pool,extract(epoch FROM at)*1000 AS at,open,high,low,close,volume FROM chart_candles WHERE at>$1 ORDER BY at`,[date(now-25*HOUR)])).rows
      .map(row=>({...row,at:Number(row.at),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)})) as (Candle&{chain:Chain;pool:string})[];
    const updates=observations.map(row=>{const data=row.data,outcome=evaluateResearch(Number(row.at),candles.filter(c=>c.chain===row.chain&&c.pool===row.pool),data.features,data.setup??undefined,costBps,now,data.evidence?.market??null);return{id:row.id,data:outcome};});
    await this.db.query(`INSERT INTO chart_research_outcomes(observation_id,data,updated_at)
      SELECT x->>'id',x->'data',clock_timestamp() FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT(observation_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,[JSON.stringify(updates)]);
    return updates.length;
  }
  async chartResearchStats() {
    const rows=(await this.db.query(`SELECT o.kind,r.data FROM chart_research_observations o LEFT JOIN chart_research_outcomes r ON r.observation_id=o.id
      WHERE o.at>clock_timestamp()-interval '7 days'`)).rows as {kind:'signal'|'control';data?:ResearchOutcome}[];
    const outcomes=rows.map(r=>r.data).filter((v):v is ResearchOutcome=>!!v),complete=outcomes.filter(o=>o.complete),median=(values:number[])=>{const a=values.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null;};
    const horizons=Object.fromEntries(['15m','30m','60m','180m','360m','720m','1440m'].map(key=>[key,{gross:median(complete.map(o=>o.horizons[key]?.grossReturnPct??NaN)),net:median(complete.map(o=>o.horizons[key]?.netReturnPct??NaN))}]));
    return{observations:rows.length,signals:rows.filter(r=>r.kind==='signal').length,controls:rows.filter(r=>r.kind==='control').length,measured:outcomes.length,complete:complete.length,
      tp1First:outcomes.filter(o=>o.firstHit==='tp1').length,stopFirst:outcomes.filter(o=>o.firstHit==='stop').length,ambiguous:outcomes.filter(o=>o.firstHit==='ambiguous').length,
      medianMfe:median(complete.map(o=>o.mfePct??NaN)),medianMae:median(complete.map(o=>o.maePct??NaN)),horizons};
  }
  async updateShadowVariantOutcomes(now:number,costBps:number) {
    for(const variant of forwardShadowVariants)await this.db.query(`INSERT INTO shadow_variant_observations(variant_id,observation_id,population,at)
      SELECT r.variant_id,o.id,o.kind,o.at FROM shadow_variant_registry r JOIN chart_research_observations o
        ON o.at>=r.locked_start AND o.created_at>=r.activated_at
      WHERE r.variant_id=$1 ON CONFLICT DO NOTHING`,[variant.id]);
    const observations=(await this.db.query(`SELECT v.variant_id AS "variantId",v.observation_id AS id,v.population,
      o.chain,o.token,o.pool,extract(epoch FROM o.at)*1000 AS at,o.data->'features' AS features
      FROM shadow_variant_observations v JOIN chart_research_observations o ON o.id=v.observation_id
      LEFT JOIN shadow_variant_outcomes r ON r.variant_id=v.variant_id AND r.observation_id=v.observation_id
      WHERE r.observation_id IS NULL AND v.at<=$1 ORDER BY v.at LIMIT 1000`,[date(shadowMaturityCutoff(now))])).rows;
    if(!observations.length)return 0;
    const earliest=Math.min(...observations.map(row=>Number(row.at))),latest=Math.max(...observations.map(row=>Number(row.at)))+DAY+BAR;
    const candles=(await this.db.query(`SELECT chain,pool,extract(epoch FROM at)*1000 AS at,open,high,low,close,volume
      FROM chart_candles WHERE at>=$1 AND at<=$2 ORDER BY at`,[date(earliest),date(latest)])).rows
      .map(row=>({...row,at:Number(row.at),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)})) as (Candle&{chain:Chain;pool:string})[];
    const updates:{variantId:string;id:string;data:ShadowOutcome}[]=[];
    for(const row of observations){
      const data=simulateForwardShadow(row.variantId,{at:Number(row.at),chain:String(row.chain),token:String(row.token),population:row.population,features:row.features},
        candles.filter(c=>c.chain===row.chain&&c.pool===row.pool),costBps);
      if(data?.resolved)updates.push({variantId:row.variantId,id:row.id,data});
    }
    if(updates.length)await this.db.query(`INSERT INTO shadow_variant_outcomes(variant_id,observation_id,data,updated_at)
      SELECT x->>'variantId',x->>'id',x->'data',clock_timestamp() FROM jsonb_array_elements($1::jsonb) x
      ON CONFLICT(variant_id,observation_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,[JSON.stringify(updates)]);
    return updates.length;
  }
  async shadowVariantProgress() {
    const rows=(await this.db.query(`SELECT r.variant_id AS "variantId",r.data AS outcome,o.observation_id AS "observationId",c.data AS observation
      FROM shadow_variant_outcomes r
      JOIN shadow_variant_observations o ON o.variant_id=r.variant_id AND o.observation_id=r.observation_id
      JOIN chart_research_observations c ON c.id=o.observation_id
      WHERE o.at>=$1 ORDER BY o.at`,[date(Math.min(...forwardShadowVariants.map(v=>v.lockedStart)))])).rows as {variantId:string;outcome:ShadowOutcome}[];
    const signalIds=rows.map((row:any)=>row.observation?.signalId).filter((value:any):value is string=>typeof value==='string'&&!!value);
    const samples=signalIds.length?(await this.db.query(`SELECT signal_id AS "signalId",extract(epoch FROM at)*1000 AS at,liquidity FROM chart_signal_samples WHERE signal_id=ANY($1::text[])`,[signalIds])).rows:[];
    const costs=await this.executionCostObservations(),bucketP75=new Map<string,number>();
    for(const bucket of [...new Set(costs.map(row=>row.liquidityBucket))]){const value=distribution(costs.filter(row=>row.liquidityBucket===bucket&&row.observedCostBps!==null).map(row=>row.observedCostBps!)).p75;if(value!==null)bucketP75.set(bucket,value);}
    const invalidated=!!(await this.db.query("SELECT invalidated_at FROM execution_cost_model_state WHERE version='cost-model-v1'")).rows[0]?.invalidated_at;
    const comparable=costs.filter(row=>row.observedCostBps!==null&&row.modelCostBps!==null).map(row=>({observedCostBps:row.observedCostBps!,modelCostBps:row.modelCostBps!}));
    const modelStatus=calibration(comparable,invalidated).status;
    const settings=this.runtimeConfig??{shadowPositionUsd:50,fomoFeeBpsPerSide:100,networkFeeUsd:{solana:.1,ethereum:5,bnb:.2,robinhood:.2,base:.2}};
    return summarizeForwardShadow((rows as any[]).map(row=>{
      if(row.outcome.population!=='signal')return row;
      const entryLiquidity=Number(row.observation?.evidence?.market?.liquidity),entryBucket=Number.isFinite(entryLiquidity)?liquidityBucket(entryLiquidity):null;
      const signalSamples=samples.filter(sample=>sample.signalId===row.observation?.signalId&&Math.abs(Number(sample.at)-Number(row.outcome.exitAt))<=10*MINUTE).sort((a,b)=>Math.abs(Number(a.at)-Number(row.outcome.exitAt))-Math.abs(Number(b.at)-Number(row.outcome.exitAt)));
      const exitLiquidity=Number(signalSamples[0]?.liquidity),modelCost=modeledCostBps({dollars:settings.shadowPositionUsd,entryLiquidity,exitLiquidity,
        feeBpsPerSide:settings.fomoFeeBpsPerSide,networkFeeUsd:settings.networkFeeUsd[row.outcome.chain as Chain]});
      return{...row,modelCostBps:modelCost,observedCostBps:entryBucket?bucketP75.get(entryBucket)??null:null,modelValid:!invalidated,modelStatus};
    }));
  }
  async reserveChart(id: string, pair: DiscoveryCandidate, setup: Setup, chatKey: string, riskWarnings: string[] = [], evidence?:unknown): Promise<boolean> {
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT *,clock_timestamp() AS now FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      const now = new Date(st.now).getTime();
      if (st.paused || st.chat_key !== chatKey || now - setup.at > 10 * MINUTE || setup.at > now) return false;
      const recent = (await q.query(chartUsage)).rows;
      if (recent.length >= MAX_ALERTS_PER_24H || recent.some(r => r.chain === pair.chain && r.token === pair.token)) return false;
      return !!(await q.query("INSERT INTO chart_setup_alerts(id,chain,token,pool,data,status) VALUES($1,$2,$3,$4,$5,'reserved') ON CONFLICT DO NOTHING RETURNING id", [id,pair.chain,pair.token,pair.pool,JSON.stringify({pair,setup,plan:chartTradePlan(setup),riskWarnings,evidence:evidence??null})])).rows.length;
    });
  }
  async beginChartSend(id: string) {
    return this.db.transaction(async q => {
      if ((await q.query('SELECT paused FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0].paused) return false;
      return !!(await q.query("UPDATE chart_setup_alerts SET status='sending' WHERE id=$1 AND status='reserved' AND reserved_at>clock_timestamp()-interval '60 seconds' RETURNING id",[id])).rows.length;
    });
  }
  async finishChartSend(id: string, status: 'sent'|'unknown'|'failed', messageId?: number) {
    await this.db.query("UPDATE chart_setup_alerts SET status=$2,message_id=$3,sent_at=CASE WHEN $2 IN ('sent','unknown') THEN clock_timestamp() ELSE NULL END WHERE id=$1",[id,status,messageId ?? null]);
  }
  async chartStats() {
    const outcomeRows=(await this.db.query(`SELECT o.data FROM chart_alert_outcomes o JOIN chart_setup_alerts a ON a.id=o.alert_id
      WHERE a.status='sent' AND a.sent_at>clock_timestamp()-interval '7 days'`)).rows.map(row=>row.data as AlertOutcome);
    return {
      used24h: (await this.db.query(chartUsage)).rows.length,
      sent7d: Number((await this.db.query("SELECT count(*)::int AS n FROM chart_setup_alerts WHERE status='sent' AND sent_at>clock_timestamp()-interval '7 days'")).rows[0].n),
      measured: outcomeRows.length, tp1First: outcomeRows.filter(o=>o.firstHit==='tp1').length,
      stopFirst: outcomeRows.filter(o=>o.firstHit==='stop').length, tp2: outcomeRows.filter(o=>o.tp2At!==null).length,
      open: outcomeRows.filter(o=>o.firstHit===null).length,
    };
  }
  async latestChartAlert() {
    const row=(await this.db.query(`SELECT a.id,a.chain,a.token,a.pool,a.data,
      extract(epoch FROM a.sent_at)*1000 AS "sentAt",o.data AS outcome,
      s.price AS "lastPrice",s.liquidity AS "lastLiquidity",extract(epoch FROM s.at)*1000 AS "lastSampleAt"
      FROM chart_setup_alerts a
      LEFT JOIN chart_alert_outcomes o ON o.alert_id=a.id
      LEFT JOIN LATERAL (SELECT price,liquidity,at FROM chart_alert_samples WHERE alert_id=a.id ORDER BY at DESC LIMIT 1) s ON true
      WHERE a.status='sent' ORDER BY a.sent_at DESC LIMIT 1`)).rows[0];
    return row ? {...row,sentAt:Number(row.sentAt),lastPrice:row.lastPrice===null?null:Number(row.lastPrice),lastLiquidity:row.lastLiquidity===null?null:Number(row.lastLiquidity),lastSampleAt:row.lastSampleAt===null?null:Number(row.lastSampleAt)} : undefined;
  }
  async chartAlertForEntry(token:string){
    const rows=(await this.db.query(`SELECT id,chain,token,pool,data,extract(epoch FROM sent_at)*1000 AS "sentAt" FROM chart_setup_alerts
      WHERE status='sent' AND sent_at>clock_timestamp()-interval '24 hours' ORDER BY sent_at DESC`)).rows;
    const row=rows.find(item=>item.token===token||String(item.token).toLowerCase()===token.toLowerCase());
    return row?{...row,sentAt:Number(row.sentAt)} as {id:string;chain:Chain;token:string;pool:string;data:any;sentAt:number}:undefined;
  }
  async chartAlertsForTracking(now=Date.now()): Promise<{id:string;chain:Chain;token:string;pool:string;sentAt:number;data:any;outcome?:AlertOutcome}[]> {
    return (await this.db.query(`SELECT a.id,a.chain,a.token,a.pool,a.data,extract(epoch FROM a.sent_at)*1000 AS "sentAt",o.data AS outcome FROM chart_setup_alerts a
      LEFT JOIN chart_alert_outcomes o ON o.alert_id=a.id WHERE a.status='sent' AND a.sent_at>$1`,[date(now-25*HOUR)])).rows.map(row=>({...row,sentAt:Number(row.sentAt)}));
  }
  async recordChartAlertSample(id:string,at:number,price:number,liquidity:number,outcome:AlertOutcome) {
    if (![at,price,liquidity].every(Number.isFinite) || price<=0 || liquidity<0) throw new Error('Invalid chart alert sample');
    const minute=Math.floor(at/MINUTE)*MINUTE;
    await this.db.transaction(async q=>{
      await q.query('INSERT INTO chart_alert_samples(alert_id,at,price,liquidity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,date(minute),price,liquidity]);
      await q.query('INSERT INTO chart_alert_outcomes(alert_id,data) VALUES($1,$2) ON CONFLICT(alert_id) DO UPDATE SET data=excluded.data',[id,JSON.stringify(outcome)]);
    });
  }
  async saveChartSignal(id:string,pair:DiscoveryCandidate,setup:Setup,decision='detected') {
    await this.db.query(`INSERT INTO chart_signals(id,rule,strategy,chain,token,pool,data,decision,detected_at)
      VALUES($1,$2,'support-rejection',$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET decision=excluded.decision,updated_at=clock_timestamp()`,
      [id,CHART_RULE,pair.chain,pair.token,pair.pool,JSON.stringify({pair,setup,plan:chartTradePlan(setup)}),decision,date(setup.at)]);
  }
  async chartSignalDecision(id:string,decision:string) {
    await this.db.query('UPDATE chart_signals SET decision=$2,updated_at=clock_timestamp() WHERE id=$1',[id,decision]);
  }
  async chartSignalsForTracking(now=Date.now()):Promise<{id:string;chain:Chain;token:string;pool:string;at:number;data:any;outcome?:AlertOutcome}[]> {
    return (await this.db.query(`SELECT s.id,s.chain,s.token,s.pool,extract(epoch FROM s.detected_at)*1000 AS at,s.data,o.data AS outcome
      FROM chart_signals s LEFT JOIN chart_signal_outcomes o ON o.signal_id=s.id WHERE s.detected_at>$1`,[date(now-25*HOUR)])).rows.map(row=>({...row,at:Number(row.at)}));
  }
  async recordChartSignalSample(id:string,at:number,price:number,liquidity:number,outcome:AlertOutcome) {
    if (![at,price,liquidity].every(Number.isFinite) || price<=0 || liquidity<0) throw new Error('Invalid chart signal sample');
    const minute=Math.floor(at/MINUTE)*MINUTE;
    await this.db.transaction(async q=>{
      await q.query('INSERT INTO chart_signal_samples(signal_id,at,price,liquidity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,date(minute),price,liquidity]);
      await q.query('INSERT INTO chart_signal_outcomes(signal_id,data) VALUES($1,$2) ON CONFLICT(signal_id) DO UPDATE SET data=excluded.data',[id,JSON.stringify(outcome)]);
    });
  }
  async chartSignalStats() {
    const rows=(await this.db.query(`SELECT s.decision,s.data AS signal_data,o.data FROM chart_signals s LEFT JOIN chart_signal_outcomes o ON o.signal_id=s.id
      WHERE s.detected_at>clock_timestamp()-interval '7 days'`)).rows;
    const outcomes=rows.map(row=>row.data as AlertOutcome|undefined).filter((value):value is AlertOutcome=>!!value);
    const evidence=rows.map(row=>row.signal_data?.evidence?.security).filter(Boolean),reasons:Record<string,number>={};
    for(const item of evidence)for(const reason of item.reasons??[])reasons[reason]=(reasons[reason]??0)+1;
    return { detected:rows.length,measured:outcomes.length,tp1First:outcomes.filter(o=>o.firstHit==='tp1').length,
      stopFirst:outcomes.filter(o=>o.firstHit==='stop').length,open:outcomes.filter(o=>o.firstHit===null).length,
      decisions:Object.fromEntries([...new Set(rows.map(row=>row.decision))].sort().map(decision=>[decision,rows.filter(row=>row.decision===decision).length])),
      security:{evidence:evidence.length,missing:rows.length-evidence.length,statuses:Object.fromEntries(['PASS','REJECT','UNKNOWN'].map(status=>[status,evidence.filter(item=>item.status===status).length])),reasons:Object.fromEntries(Object.entries(reasons).sort((a,b)=>b[1]-a[1]))} };
  }
  async chartLearningStats(costBps=200) {
    const rows=(await this.db.query(`SELECT s.chain,s.decision,extract(epoch FROM s.detected_at)*1000 AS at,s.data AS signal_data,o.data AS outcome,
      sc.open AS signal_open,sc.high AS signal_high,sc.low AS signal_low,sc.close AS signal_close,sc.volume AS signal_volume,
      nc.open AS next_open,nc.high AS next_high,nc.low AS next_low,nc.close AS next_close,nc.volume AS next_volume
      FROM chart_signals s LEFT JOIN chart_signal_outcomes o ON o.signal_id=s.id
      LEFT JOIN chart_candles sc ON sc.chain=s.chain AND sc.pool=s.pool AND sc.at=s.detected_at-interval '5 minutes'
      LEFT JOIN chart_candles nc ON nc.chain=s.chain AND nc.pool=s.pool AND nc.at=s.detected_at
      WHERE s.detected_at>clock_timestamp()-interval '7 days' ORDER BY s.detected_at DESC`)).rows;
    const candleRows=(await this.db.query(`SELECT chain,pool,extract(epoch FROM at)*1000 AS at,open,high,low,close,volume
      FROM chart_candles WHERE at>clock_timestamp()-interval '8 days' ORDER BY at`)).rows;
    const histories=new Map<string,Candle[]>();
    for(const row of candleRows){const key=`${row.chain}:${row.pool}`,values=histories.get(key)??[];values.push({at:Number(row.at),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)});histories.set(key,values);}
    const candle=(row:any,prefix:'signal'|'next',at:number):Candle|undefined=>row[`${prefix}_open`]===null||row[`${prefix}_open`]===undefined?undefined:{at,
      open:Number(row[`${prefix}_open`]),high:Number(row[`${prefix}_high`]),low:Number(row[`${prefix}_low`]),close:Number(row[`${prefix}_close`]),volume:Number(row[`${prefix}_volume`])};
    const learningRows:LearningRow[]=rows.filter(row=>row.signal_data?.setup).map(row=>{const at=Number(row.at),setup=row.signal_data.setup as Setup;return{
      at,chain:String(row.chain),token:String(row.signal_data?.pair?.token??''),symbol:String(row.signal_data?.pair?.symbol??'?'),decision:String(row.decision),setup,outcome:row.outcome as AlertOutcome|undefined,
      signalCandle:candle(row,'signal',at-BAR),confirmationCandle:candle(row,'next',at),
      futureCandles:(histories.get(`${row.chain}:${row.signal_data?.pair?.pool??''}`)??[]).filter(item=>item.at>=at&&item.at<at+25*HOUR),
    }});
    return analyzeChartLearning(learningRows,costBps);
  }
  async chartSecurityAuditCandidates(limit=25):Promise<{id:string;chain:Chain;token:string;pool:string}[]> {
    return (await this.db.query(`SELECT id,chain,token,pool FROM chart_signals
      WHERE detected_at>clock_timestamp()-interval '7 days'
        AND coalesce(data#>>'{evidence,security,audit}','')<>'goplus-policy-v2-current-state'
      ORDER BY detected_at DESC LIMIT $1`,[limit])).rows;
  }
  async saveChartSignalSecurityAudit(id:string,security:unknown) {
    await this.db.query(`UPDATE chart_signals SET data=data||jsonb_build_object('evidence',coalesce(data->'evidence','{}'::jsonb)||jsonb_build_object('security',$2::jsonb)),updated_at=clock_timestamp() WHERE id=$1`,[id,JSON.stringify(security)]);
  }
  async registerChartPosition(token:string,amountUsd:number,entry:number,costEntry?:EntryCostEvidence): Promise<ManagedPosition> {
    if (!token || !Number.isFinite(amountUsd) || amountUsd<=0 || !Number.isFinite(entry) || entry<=0) throw new Error('Use /entered CONTRACT DOLLARS PRICE with positive numbers.');
    return this.db.transaction(async q=>{
      const rows=(await q.query(`SELECT id,chain,token,pool,data,extract(epoch FROM sent_at)*1000 AS sent_ms FROM chart_setup_alerts
        WHERE status='sent' AND sent_at>clock_timestamp()-interval '24 hours' ORDER BY sent_at DESC`)).rows;
      const alert=rows.find(row=>row.token===token || row.token.toLowerCase()===token.toLowerCase());
      if (!alert) throw new Error('No delivered 5M buy alert matches that contract in the last 24 hours.');
      if ((await q.query("SELECT 1 FROM chart_positions WHERE status='open' AND chain=$1 AND lower(token)=lower($2) LIMIT 1",[alert.chain,alert.token])).rows.length) throw new Error('That contract already has an open position monitor.');
      const plan=alert.data?.plan, pair=alert.data?.pair;
      if (![plan?.stop,plan?.entryMin,plan?.entryMax,pair?.liquidity].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))) throw new Error('The matching alert does not contain a usable trade plan.');
      if (entry<plan.entryMin || entry>plan.entryMax) throw new Error(`That price is outside the alert entry range ${plan.entryMin}–${plan.entryMax}.`);
      const position:ManagedPosition={id:randomUUID(),alertId:alert.id,chain:alert.chain,token:alert.token,pool:alert.pool,symbol:String(pair.symbol||'?').slice(0,30),amountUsd,entry,stop:plan.stop,tp1:entry*1.05,tp2:entry*1.10,initialLiquidity:pair.liquidity,openedAt:Date.now(),stage:'open',status:'open'};
      await q.query('INSERT INTO chart_positions(id,alert_id,chain,token,pool,data,status) VALUES($1,$2,$3,$4,$5,$6,\'open\')',[position.id,position.alertId,position.chain,position.token,position.pool,JSON.stringify(position)]);
      if(costEntry)await q.query(`INSERT INTO execution_cost_observations(position_id,chain,token,pool,entry_data,entry_liquidity_bucket)
        VALUES($1,$2,$3,$4,$5,$6)`,[position.id,position.chain,position.token,position.pool,JSON.stringify(costEntry),liquidityBucket(costEntry.liquidity)]);
      return position;
    });
  }
  async openChartPositions():Promise<ManagedPosition[]> { return (await this.db.query("SELECT data FROM chart_positions WHERE status='open' ORDER BY opened_at")).rows.map(row=>row.data); }
  async openChartPosition(token:string):Promise<ManagedPosition|undefined>{
    return (await this.db.query("SELECT data FROM chart_positions WHERE status='open' AND lower(token)=lower($1) ORDER BY opened_at DESC LIMIT 1",[token])).rows[0]?.data;
  }
  async chartPositionForExit(token:string):Promise<ManagedPosition|undefined>{
    return (await this.db.query(`SELECT p.data FROM chart_positions p JOIN execution_cost_observations e ON e.position_id=p.id
      WHERE lower(p.token)=lower($1) AND e.completed_at IS NULL ORDER BY p.opened_at DESC LIMIT 1`,[token])).rows[0]?.data;
  }
  async completeExecutionCost(positionId:string,exit:ExitCostEvidence,c:{fomoFeeBpsPerSide:number;networkFeeUsd:Record<Chain,number>}){
    return this.db.transaction(async q=>{
      const row=(await q.query(`SELECT e.entry_data,e.chain,p.data AS position FROM execution_cost_observations e
        JOIN chart_positions p ON p.id=e.position_id WHERE e.position_id=$1 FOR UPDATE`,[positionId])).rows[0];
      if(!row)throw new Error('This position predates execution-cost capture. Close it with /closed, or use a newly entered position.');
      if((await q.query('SELECT 1 FROM execution_cost_observations WHERE position_id=$1 AND completed_at IS NOT NULL',[positionId])).rows.length)throw new Error('That execution-cost observation is already complete.');
      const entry=row.entry_data as EntryCostEvidence,observed=observedCost(entry,exit),model=modeledCostBps({dollars:entry.dollars,entryLiquidity:entry.liquidity,
        exitLiquidity:exit.liquidity,feeBpsPerSide:c.fomoFeeBpsPerSide,networkFeeUsd:c.networkFeeUsd[row.chain as Chain]});
      await q.query(`UPDATE execution_cost_observations SET exit_data=$2,observed_cost_bps=$3,model_cost_bps=$4,completed_at=clock_timestamp() WHERE position_id=$1`,
        [positionId,JSON.stringify(exit),observed.roundTripBps,model]);
      await q.query(`UPDATE chart_positions SET status='closed',closed_at=clock_timestamp(),data=jsonb_set(data,'{status}','"closed"') WHERE id=$1`,[positionId]);
      const comparable=(await q.query(`SELECT observed_cost_bps AS observed,model_cost_bps AS model FROM execution_cost_observations
        WHERE completed_at IS NOT NULL AND observed_cost_bps IS NOT NULL AND model_cost_bps IS NOT NULL`)).rows.map(value=>({observedCostBps:Number(value.observed),modelCostBps:Number(value.model)}));
      const state=(await q.query("SELECT invalidated_at FROM execution_cost_model_state WHERE version='cost-model-v1' FOR UPDATE")).rows[0];
      const result=calibration(comparable,!!state?.invalidated_at);
      if(result.invalidated&&!state?.invalidated_at)await q.query("UPDATE execution_cost_model_state SET invalidated_at=clock_timestamp(),evidence=$1,updated_at=clock_timestamp() WHERE version='cost-model-v1'",[JSON.stringify(result)]);
      else await q.query("UPDATE execution_cost_model_state SET evidence=$1,updated_at=clock_timestamp() WHERE version='cost-model-v1'",[JSON.stringify(result)]);
      return{observed,modelCostBps:model,calibration:result};
    });
  }
  async executionCostObservations():Promise<ExecutionCostObservation[]>{
    return (await this.db.query(`SELECT position_id AS "positionId",chain,token,pool,entry_data AS entry,exit_data AS exit,
      entry_liquidity_bucket AS "liquidityBucket",observed_cost_bps AS "observedCostBps",model_cost_bps AS "modelCostBps"
      FROM execution_cost_observations ORDER BY completed_at NULLS LAST`)).rows.map(row=>({...row,
        observedCostBps:row.observedCostBps===null?null:Number(row.observedCostBps),modelCostBps:row.modelCostBps===null?null:Number(row.modelCostBps),
        observedProvenance:row.observedCostBps===null?null:'observed' as const,modelProvenance:row.modelCostBps===null?null:'model:cost-model-v1' as const}));
  }
  async executionCostSummary():Promise<CostSummary>{
    const rows=(await this.executionCostObservations()).filter(row=>row.exit&&row.observedCostBps!==null),values=rows.map(row=>row.observedCostBps!);
    const grouped=(key:(row:ExecutionCostObservation)=>string)=>Object.fromEntries([...new Set(rows.map(key))].sort().map(value=>[value,distribution(rows.filter(row=>key(row)===value).map(row=>row.observedCostBps!))]));
    const state=(await this.db.query("SELECT invalidated_at FROM execution_cost_model_state WHERE version='cost-model-v1'")).rows[0];
    const settings=this.runtimeConfig??{shadowPositionUsd:50,fomoFeeBpsPerSide:100,networkFeeUsd:{solana:.1,ethereum:5,bnb:.2,robinhood:.2,base:.2}};
    const modeled=(dollars:number)=>distribution(rows.map(row=>modeledCostBps({dollars,entryLiquidity:row.entry.liquidity,exitLiquidity:row.exit!.liquidity,
      feeBpsPerSide:settings.fomoFeeBpsPerSide,networkFeeUsd:settings.networkFeeUsd[row.chain]})).filter((value):value is number=>value!==null));
    return{overall:distribution(values),byChain:grouped(row=>row.chain),byLiquidity:grouped(row=>row.liquidityBucket),
      calibration:calibration(rows.filter(row=>row.modelCostBps!==null).map(row=>({observedCostBps:row.observedCostBps!,modelCostBps:row.modelCostBps!})),!!state?.invalidated_at),
      modelPrimaryUsd:settings.shadowPositionUsd,modeledPrimary:modeled(settings.shadowPositionUsd),modeled250:modeled(250)};
  }
  async closeChartPosition(token:string):Promise<boolean> {
    const row=await this.db.query("UPDATE chart_positions SET status='closed',closed_at=clock_timestamp(),data=jsonb_set(data,'{status}','\"closed\"') WHERE status='open' AND lower(token)=lower($1) RETURNING id",[token]);
    return !!row.rows.length;
  }
  async reserveChartPositionEvent(position:ManagedPosition,event:PositionEvent,data:unknown,chatKey:string):Promise<boolean> {
    return this.db.transaction(async q=>{
      const state=(await q.query('SELECT paused,chat_key FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      if(state.paused||state.chat_key!==chatKey)return false;
      const inserted=await q.query("INSERT INTO chart_position_events(position_id,kind,data,status) VALUES($1,$2,$3,'reserved') ON CONFLICT DO NOTHING RETURNING position_id",[position.id,event,JSON.stringify(data)]);
      if(!inserted.rows.length)return false;
      const closing=['stop','tp2','breakeven'].includes(event), stage=event==='tp1'?'tp1':position.stage;
      await q.query(`UPDATE chart_positions SET status=$2,closed_at=CASE WHEN $2='closed' THEN clock_timestamp() ELSE NULL END,
        data=jsonb_set(jsonb_set(data,'{stage}',$3::jsonb),'{status}',$4::jsonb) WHERE id=$1`,[position.id,closing?'closed':'open',JSON.stringify(stage),JSON.stringify(closing?'closed':'open')]);
      return true;
    });
  }
  async finishChartPositionEvent(positionId:string,event:PositionEvent,status:'sent'|'unknown'|'failed',messageId?:number) {
    await this.db.query("UPDATE chart_position_events SET status=$3,message_id=$4,sent_at=CASE WHEN $3 IN ('sent','unknown') THEN clock_timestamp() ELSE NULL END WHERE position_id=$1 AND kind=$2",[positionId,event,status,messageId??null]);
  }
  async ingest(events: Trade[]) {
    if (!events.length) return;
    await this.db.transaction(async q => {
      await q.query(`WITH inserted AS (
        INSERT INTO events(id,chain,token,pool,at,data)
        SELECT e->>'id',e->>'chain',e->>'token',e->>'pool',to_timestamp((e->>'at')::double precision/1000),e
        FROM jsonb_array_elements($1::jsonb) e ON CONFLICT DO NOTHING RETURNING chain,token,at
      ) INSERT INTO candidates(chain,token,first_seen,last_seen)
      SELECT chain,token,min(at),max(at) FROM inserted GROUP BY chain,token
      ON CONFLICT(chain,token) DO UPDATE SET first_seen=least(candidates.first_seen,excluded.first_seen),last_seen=greatest(candidates.last_seen,excluded.last_seen)`, [JSON.stringify(events)]);
    });
  }
  async discover(events: Discovery[]) {
    if (!events.length) return;
    await this.db.query(`WITH inserted AS (
      INSERT INTO discoveries(chain,token,tx,at) SELECT e->>'chain',e->>'token',e->>'tx',to_timestamp((e->>'at')::double precision/1000)
      FROM jsonb_array_elements($1::jsonb) e ON CONFLICT DO NOTHING RETURNING chain,token,at
    ) INSERT INTO candidates(chain,token,first_seen,last_seen) SELECT chain,token,min(at),max(at) FROM inserted GROUP BY chain,token
    ON CONFLICT(chain,token) DO UPDATE SET last_seen=greatest(candidates.last_seen,excluded.last_seen)`, [JSON.stringify(events)]);
  }
  async candidates(now: number, limit = 30): Promise<{ chain: Chain; token: string }[]> {
    return (await this.db.query(`SELECT chain,token FROM candidates c WHERE first_seen <= $1::timestamptz - interval '10 minutes'
      AND last_seen > $1::timestamptz - interval '5 minutes'
      AND (last_evaluated IS NULL OR last_evaluated <= $1::timestamptz - interval '60 seconds')
      AND EXISTS(SELECT 1 FROM events e WHERE e.chain=c.chain AND e.token=c.token AND e.at > $1::timestamptz - interval '5 minutes')
      ORDER BY last_evaluated ASC NULLS FIRST,last_seen DESC LIMIT $2`, [date(now), limit])).rows;
  }
  async events(chain: Chain, token: string, from: number, to: number, pool?: string): Promise<Trade[]> {
    return (await this.db.query('SELECT data FROM events WHERE chain=$1 AND token=$2 AND at>$3 AND at<=$4 AND ($5::text IS NULL OR pool=$5) ORDER BY at,id', [chain, token, date(from), date(to), pool ?? null])).rows.map(r => r.data);
  }
  async previous(chain: Chain, token: string): Promise<Snapshot | undefined> {
    return (await this.db.query('SELECT data FROM snapshots WHERE chain=$1 AND token=$2 ORDER BY at DESC LIMIT 1', [chain, token])).rows[0]?.data;
  }
  async save(s: Snapshot) {
    await this.db.transaction(async q => {
      await q.query('INSERT INTO snapshots(id,chain,token,at,rule_id,score,confirmed,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [s.id, s.chain, s.token, date(s.at), s.ruleId, s.score, s.confirmed, JSON.stringify(s)]);
      await q.query('UPDATE candidates SET last_evaluated=$3 WHERE chain=$1 AND token=$2', [s.chain, s.token, date(s.at)]);
    });
  }
  async state() { return (await this.db.query('SELECT * FROM scanner_state WHERE id=1')).rows[0]; }
  async saveShortlist(entries: ShortlistEntry[]) {
    if (entries.length) await this.db.query(`INSERT INTO market_shortlist(chain,token,pool,at,market_pass,priority,data)
      SELECT e->>'chain',e->>'token',e->>'pool',to_timestamp((e->>'at')::double precision/1000),
        (e->>'marketPass')::boolean,(e->>'priority')::integer,e
      FROM jsonb_array_elements($1::jsonb) e
      ON CONFLICT(chain,token,pool) DO UPDATE SET at=excluded.at,market_pass=excluded.market_pass,priority=excluded.priority,data=excluded.data`, [JSON.stringify(entries)]);
    await this.db.query("DELETE FROM market_shortlist WHERE at<clock_timestamp()-interval '2 days'");
  }
  async recentShortlist(now = Date.now()): Promise<ShortlistEntry[]> {
    return (await this.db.query(`SELECT data FROM market_shortlist WHERE at>$1
      ORDER BY chain,market_pass DESC,priority DESC,(data->>'volume5m')::double precision DESC,at DESC LIMIT 500`, [date(now - 15 * MINUTE)])).rows.map(row => row.data);
  }
  async reserveShortlist(entry: ShortlistEntry, opts: { enabled: boolean; tradeable: boolean; chatKey: string }): Promise<string | null> {
    if (!opts.enabled || !opts.tradeable || !entry.marketPass || !entry.dex || entry.security.status !== 'PASS') return null;
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT *,clock_timestamp() AS now FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      const now = new Date(st.now).getTime();
      await q.query("UPDATE shortlist_alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at<clock_timestamp()-interval '2 minutes'");
      if (st.paused || st.chat_key !== opts.chatKey || now - entry.at > 15 * MINUTE || entry.at > now + 5000) return null;
      const recent = (await q.query(shortlistUsage)).rows;
      if (recent.length >= MAX_SCOUT_ALERTS_PER_24H || recent.some(r => r.chain === entry.chain && r.token === entry.token)) return null;
      const id = randomUUID();
      await q.query("INSERT INTO shortlist_alerts(id,chain,token,pool,data,status) VALUES($1,$2,$3,$4,$5,'reserved')",
        [id, entry.chain, entry.token, entry.pool, JSON.stringify(entry)]);
      return id;
    });
  }
  async beginShortlistSend(id: string): Promise<boolean> {
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT paused FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      if (st.paused) return false;
      return !!(await q.query("UPDATE shortlist_alerts SET status='sending' WHERE id=$1 AND status='reserved' AND reserved_at > clock_timestamp()-interval '60 seconds' RETURNING id", [id])).rows.length;
    });
  }
  async finishShortlistAlert(id: string, status: 'sent' | 'unknown' | 'failed', messageId?: number) {
    await this.db.query("UPDATE shortlist_alerts SET status=$2,message_id=$3,sent_at=CASE WHEN $2 IN ('sent','unknown') THEN clock_timestamp() ELSE NULL END WHERE id=$1",
      [id, status, messageId ?? null]);
  }
  async shortlistAlertStats() {
    const row = (await this.db.query(`SELECT
      count(*) FILTER (WHERE status='sent' AND sent_at>clock_timestamp()-interval '7 days')::int AS sent_7d,
      count(*) FILTER (WHERE reserved_at>clock_timestamp()-interval '24 hours' OR sent_at>clock_timestamp()-interval '24 hours' OR status IN ('reserved','sending'))::int AS used_24h
      FROM shortlist_alerts`)).rows[0];
    return { sent7d: Number(row.sent_7d), used24h: Number(row.used_24h) };
  }
  async walletCursor(source: string, wallet: string): Promise<string | null> {
    return (await this.db.query('SELECT cursor FROM wallet_watch_cursors WHERE source=$1 AND wallet=$2', [source, wallet])).rows[0]?.cursor ?? null;
  }
  async saveWalletCursor(source: string, wallet: string, cursor: string) {
    await this.db.query(`INSERT INTO wallet_watch_cursors(source,wallet,cursor) VALUES($1,$2,$3)
      ON CONFLICT(source,wallet) DO UPDATE SET cursor=excluded.cursor,updated_at=clock_timestamp()`, [source, wallet, cursor]);
  }
  async reserveWalletTrade(trade: WalletTrade, opts: { enabled: boolean; chatKey: string }): Promise<string | null> {
    if (!opts.enabled || Date.now() - trade.at > 10 * MINUTE || trade.at > Date.now() + 5000) return null;
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT * FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      await q.query("UPDATE wallet_watch_alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at<clock_timestamp()-interval '2 minutes'");
      if (st.paused || st.chat_key !== opts.chatKey) return null;
      const row = await q.query(`INSERT INTO wallet_watch_alerts(id,trader,wallet,chain,token,tx,side,data,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved') ON CONFLICT DO NOTHING RETURNING id`,
        [trade.id, trade.trader, trade.wallet, trade.chain, trade.token, trade.tx, trade.side, JSON.stringify(trade)]);
      return row.rows[0]?.id ?? null;
    });
  }
  async beginWalletSend(id: string): Promise<boolean> {
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT paused FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      if (st.paused) return false;
      return !!(await q.query("UPDATE wallet_watch_alerts SET status='sending' WHERE id=$1 AND status='reserved' AND reserved_at>clock_timestamp()-interval '60 seconds' RETURNING id", [id])).rows.length;
    });
  }
  async finishWalletAlert(id: string, status: 'sent' | 'unknown' | 'failed', messageId?: number) {
    await this.db.query("UPDATE wallet_watch_alerts SET status=$2,message_id=$3,sent_at=CASE WHEN $2 IN ('sent','unknown') THEN clock_timestamp() ELSE NULL END WHERE id=$1",
      [id, status, messageId ?? null]);
  }
  async walletAlertStats() {
    const row = (await this.db.query(`SELECT
      count(*) FILTER (WHERE status='sent' AND sent_at>clock_timestamp()-interval '7 days')::int AS sent_7d,
      count(*) FILTER (WHERE status='sent' AND sent_at>clock_timestamp()-interval '24 hours')::int AS sent_24h
      FROM wallet_watch_alerts`)).rows[0];
    return { sent7d: Number(row.sent_7d), sent24h: Number(row.sent_24h) };
  }
  async pause(value: boolean) { await this.db.query('UPDATE scanner_state SET paused=$1 WHERE id=1', [value]); }
  async validateChat(chatKey: string) { await this.db.query('UPDATE scanner_state SET chat_key=$1 WHERE id=1', [chatKey]); }
  async offset(value: number) { await this.db.query('UPDATE scanner_state SET telegram_offset=$1 WHERE id=1', [value]); }
  async health(provider: string, state: Health['state'], detail: string, lastEvent?: number): Promise<Health> {
    const old = (await this.db.query('SELECT data FROM provider_health WHERE provider=$1', [provider])).rows[0]?.data as Health | undefined;
    const now = Date.now(), value: Health = { provider, state, detail, lastEventAt: lastEvent ?? old?.lastEventAt ?? null, checkedAt: now,
      since: old?.state === state ? old.since : now, warned: old?.warned ?? false };
    await this.db.query("INSERT INTO provider_health(provider,data) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET data=jsonb_set(excluded.data,'{warned}',provider_health.data->'warned')", [provider, JSON.stringify(value)]);
    return value;
  }
  async healthAll(): Promise<Health[]> { return (await this.db.query('SELECT data FROM provider_health ORDER BY provider')).rows.map(r => r.data); }
  async warned(provider: string, value: boolean) { await this.db.query("UPDATE provider_health SET data=jsonb_set(data,'{warned}',$2::jsonb) WHERE provider=$1", [provider, JSON.stringify(value)]); }
  async gap(chain: Chain, from: number, to: number) { await this.db.query('INSERT INTO coverage_gaps(chain,since,until) VALUES($1,$2,$3)', [chain, date(from), date(to)]); }
  async covered(chain: Chain, now = Date.now(), sql: Sql = this.db): Promise<boolean> {
    const h = (await sql.query('SELECT data FROM provider_health WHERE provider=$1', [`bitquery:${chain}`])).rows[0]?.data as Health | undefined;
    if (!h || h.state !== 'healthy' || !h.lastEventAt || now - h.lastEventAt > 2 * MINUTE || now - h.checkedAt > 2 * MINUTE) return false;
    return !(await sql.query('SELECT 1 FROM coverage_gaps WHERE chain=$1 AND until>$2 LIMIT 1', [chain, date(now - HOUR)])).rows.length;
  }
  async recordObservation(scope: string, now: number) {
    await this.db.query('INSERT INTO observation_minutes(rule_id,scope,at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [RULE_ID, scope, date(Math.floor(now / MINUTE) * MINUTE)]);
  }
  async shadow(s: Snapshot): Promise<string | null> {
    if (!s.confirmed || s.ruleId !== RULE_ID) return null;
    return this.db.transaction(async q => {
      await q.query('SELECT id FROM scanner_state WHERE id=1 FOR UPDATE');
      const old = await q.query("SELECT r.id FROM tracked_references r JOIN snapshots s ON s.id=r.snapshot_id WHERE r.chain=$1 AND r.token=$2 AND r.at>$3 AND s.rule_id=$4 LIMIT 1", [s.chain, s.token, date(s.at - DAY), RULE_ID]);
      if (old.rows.length) return null;
      const id = randomUUID();
      await q.query("INSERT INTO tracked_references(id,chain,token,snapshot_id,at,kind) VALUES($1,$2,$3,$4,$5,'shadow')", [id, s.chain, s.token, s.id, date(s.at)]);
      return id;
    });
  }
  async reserve(s: Snapshot, opts: { enabled: boolean; tradeable: boolean; scope: string; chatKey: string }): Promise<string | null> {
    if (!opts.enabled || !opts.tradeable || !s.confirmed || s.security.status !== 'PASS' || s.ruleId !== RULE_ID) return null;
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT *,clock_timestamp() AS now FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      const now = new Date(st.now).getTime();
      await q.query("UPDATE alerts SET status='unknown',sent_at=clock_timestamp() WHERE status IN ('reserved','sending') AND reserved_at<clock_timestamp()-interval '2 minutes'");
      if (st.paused || st.chat_key !== opts.chatKey || now - s.at > MINUTE || s.at > now + 5000 || !await this.covered(s.chain, now, q)) return null;
      if (!(await q.query('SELECT 1 FROM rollout_approvals WHERE rule_id=$1 AND scope=$2', [RULE_ID, opts.scope])).rows.length) return null;
      const recent = (await q.query(candidateUsage)).rows;
      if (recent.length >= MAX_ALERTS_PER_24H || recent.some(r => r.chain === s.chain && r.token === s.token)) return null;
      const id = randomUUID();
      await q.query("INSERT INTO alerts(id,chain,token,snapshot_id,status) VALUES($1,$2,$3,$4,'reserved')", [id, s.chain, s.token, s.id]);
      return id;
    });
  }
  async beginSend(id: string): Promise<boolean> {
    return this.db.transaction(async q => {
      const st = (await q.query('SELECT paused FROM scanner_state WHERE id=1 FOR UPDATE')).rows[0];
      if (st.paused) return false;
      return !!(await q.query("UPDATE alerts SET status='sending' WHERE id=$1 AND status='reserved' AND reserved_at > clock_timestamp()-interval '60 seconds' RETURNING id", [id])).rows.length;
    });
  }
  async finishAlert(id: string, status: 'sent' | 'unknown' | 'failed', messageId?: number) {
    await this.db.transaction(async q => {
      await q.query("UPDATE alerts SET status=$2,message_id=$3,sent_at=CASE WHEN $2 IN ('sent','unknown') THEN clock_timestamp() ELSE NULL END WHERE id=$1", [id, status, messageId ?? null]);
      if (status === 'sent') await q.query("INSERT INTO tracked_references(id,chain,token,snapshot_id,at,kind) SELECT id,chain,token,snapshot_id,sent_at,'alert' FROM alerts WHERE id=$1 ON CONFLICT DO NOTHING", [id]);
    });
  }
  async recent(): Promise<Snapshot[]> {
    return (await this.db.query(`SELECT data FROM (SELECT DISTINCT ON(chain,token) data,score,at FROM snapshots
      WHERE at>clock_timestamp()-interval '24 hours' ORDER BY chain,token,at DESC) latest
      WHERE NOT (data->>'confirmed')::boolean ORDER BY score DESC NULLS LAST,at DESC LIMIT 5`)).rows.map(r => r.data);
  }
  async activeReferences(now: number): Promise<Reference[]> {
    return (await this.db.query(`SELECT r.*,s.data FROM tracked_references r JOIN snapshots s ON s.id=r.snapshot_id
      WHERE r.at>$1 AND r.at<=$2`, [date(now - 25 * HOUR), date(now)])).rows.map(r => ({ id: r.id, chain: r.chain, token: r.token, at: new Date(r.at).getTime(), kind: r.kind, snapshot: r.data }));
  }
  async sample(ref: string, at: number, price: number, liquidity: number) {
    await this.db.query('INSERT INTO outcome_samples(reference_id,at,price,liquidity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ref, date(at), price, liquidity]);
  }
  async samples(ref: string) { return (await this.db.query('SELECT at,price,liquidity FROM outcome_samples WHERE reference_id=$1 ORDER BY at', [ref])).rows.map(r => ({ at: new Date(r.at).getTime(), price: Number(r.price), liquidity: Number(r.liquidity) })); }
  async hasOutcome(ref: string, hours: number) { return !!(await this.db.query('SELECT 1 FROM outcomes WHERE reference_id=$1 AND hours=$2', [ref, hours])).rows.length; }
  async outcome(ref: string, hours: number, data: unknown) { await this.db.query('INSERT INTO outcomes(reference_id,hours,data) VALUES($1,$2,$3) ON CONFLICT(reference_id,hours) DO UPDATE SET data=excluded.data', [ref, hours, JSON.stringify(data)]); }
  async gapExists(chain: Chain, from: number, to: number) {
    const h = (await this.healthAll()).find(h => h.provider === `bitquery:${chain}`);
    if (!h?.lastEventAt || (h.lastEventAt < to && (h.state !== 'healthy' || Date.now() - h.lastEventAt > 2 * MINUTE))) return true;
    return !!(await this.db.query('SELECT 1 FROM coverage_gaps WHERE chain=$1 AND since<$3 AND until>$2 LIMIT 1', [chain, date(from), date(to)])).rows.length;
  }
  async stats() {
    const alerts = (await this.db.query("SELECT count(*)::int AS count FROM alerts WHERE status='sent' AND sent_at>clock_timestamp()-interval '7 days'")).rows[0].count;
    const outcomes = (await this.db.query(`SELECT o.hours,o.data,s.rule_id,r.kind FROM outcomes o JOIN tracked_references r ON r.id=o.reference_id
      JOIN snapshots s ON s.id=r.snapshot_id WHERE r.at>clock_timestamp()-interval '7 days'`)).rows;
    return { alerts, outcomes };
  }
  async retention(candleRetentionDays=35) {
    await this.db.query("DELETE FROM events WHERE at<clock_timestamp()-interval '48 hours'");
    await this.db.query("DELETE FROM discoveries WHERE at<clock_timestamp()-interval '48 hours'");
    await this.db.query("DELETE FROM candidates WHERE last_seen<clock_timestamp()-interval '48 hours'");
    await this.db.query('DELETE FROM chart_candles WHERE at<clock_timestamp()-make_interval(days=>$1)',[candleRetentionDays]);
    await this.db.query('DELETE FROM research_regime_candles WHERE at<clock_timestamp()-make_interval(days=>$1)',[candleRetentionDays]);
  }
}

export function marketResearchOutcome(sourceAt:number,entryPrice:number,entryLiquidity:number,samples:{at:number;price:number;liquidity:number}[],now:number){
  const ordered=samples.map(sample=>({at:Number(sample.at),price:Number(sample.price),liquidity:Number(sample.liquidity)}))
    .filter(sample=>[sample.at,sample.price,sample.liquidity].every(Number.isFinite)&&sample.price>0&&sample.liquidity>=0).sort((a,b)=>a.at-b.at);
  const endAt=sourceAt+24*HOUR,endSample=ordered.find(sample=>sample.at>=endAt);
  const rug=ordered.find(sample=>sample.at<=endAt&&sample.liquidity<=Math.max(100,entryLiquidity*.01));
  const cutoff=rug?.at??endSample?.at??Math.min(now,endAt);
  const through=ordered.filter(sample=>sample.at<=cutoff),last=through.at(-1),complete=!!rug||!!endSample;
  const valueAt=(hours:number)=>ordered.find(sample=>sample.at>=sourceAt+hours*HOUR&&sample.at<=cutoff)?.price??null;
  const pct=(price:number|null)=>price===null||!Number.isFinite(entryPrice)||entryPrice<=0?null:(price/entryPrice-1)*100;
  return{entryPrice,entryLiquidity,observedMinutes:last?Math.max(0,(last.at-sourceAt)/MINUTE):0,complete,rugAt:rug?.at??null,
    returnPct:rug?-100:pct(complete?last?.price??null:null),mfePct:through.length?pct(Math.max(...through.map(sample=>sample.price))):null,
    maePct:rug?-100:through.length?pct(Math.min(...through.map(sample=>sample.price))):null,
    horizons:{'1h':pct(valueAt(1)),'4h':pct(valueAt(4)),'24h':rug?-100:pct(valueAt(24))}};
}
