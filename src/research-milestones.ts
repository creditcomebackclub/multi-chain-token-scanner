import { DAY, HOUR, type Config } from './config.js';
import type { ShadowProgress } from './shadow-research.js';
import type { DatabaseStorage, ResearchCollectorCoverage, ResearchCollectorName, Store } from './store.js';
import { escapeHtml } from './telegram.js';

export const PHASE4_READY_DAYS=21,PHASE4_PREFERRED_DAYS=28,PHASE4_MIN_OBSERVATION_DAYS=15,COLLECTOR_STALL_HOURS=12;

export type MilestoneStatus={key:string;label:string;status:'pending'|'sent'|'not applicable'|'delivery unknown';at:number|null};
type Inputs={
  coverage?:()=>Promise<ResearchCollectorCoverage[]>;
  shadows?:()=>Promise<ShadowProgress[]>;
  storage?:()=>Promise<DatabaseStorage>;
};
type Delivery={chatKey:string;send:(text:string)=>Promise<number>};

const collectorLabel=(collector:ResearchCollectorName)=>collector==='regime'?'regime candles':'young-pool cohort';
const pct=(value:number|null)=>value===null?'n/a':`${value>=0?'+':''}${value.toFixed(2)}%`;
const interval=(value:ShadowProgress['signalInterval'],blocks:number)=>value
  ?`95% CI [${value.low.toFixed(2)}, ${value.high.toFixed(2)}], ${value.blocks} day blocks`
  :`CI not estimable (${blocks} day blocks)`;
export const shadowSummaryLine=(value:ShadowProgress)=>`${value.resolvedSignals}/${value.requiredSignals} resolved signals across ${value.signalDays}/${value.requiredDays} days · modeled expectancy ${pct(value.signalExpectancyPct)} · ${interval(value.signalInterval,value.signalDays)}`;

export function crossedStorageThresholds(usageMb:number,limitMb:number){
  if(!Number.isFinite(usageMb)||usageMb<0||!Number.isFinite(limitMb)||limitMb<=0)throw new Error('Invalid storage measurement');
  const percent=usageMb/limitMb*100;
  return{percent,crossed80:percent>=80,crossed90:percent>=90};
}

export class ResearchMilestones{
  constructor(private c:Config,private store:Store,private delivery:Delivery,private inputs:Inputs={}){}

  private enabledCollectors():ResearchCollectorName[]{
    return [this.c.regimeCandlesEnabled?'regime':null,this.c.youngPoolResearchEnabled?'young_pool':null].filter((v):v is ResearchCollectorName=>v!==null);
  }
  private coverage(){return this.inputs.coverage?.()??this.store.researchCollectorCoverage(this.enabledCollectors());}
  private shadows(){return this.inputs.shadows?.()??this.store.shadowVariantProgress();}
  private storage(){return this.inputs.storage?.()??this.store.databaseStorage();}
  private async notify(key:string,kind:string,data:unknown,message:string){
    if(!await this.store.claimResearchMilestone(key,kind,data))return false;
    try{const messageId=await this.delivery.send(message);await this.store.finishResearchMilestone(key,'sent',messageId);}
    catch{await this.store.finishResearchMilestone(key,'unknown').catch(()=>undefined);}
    return true;
  }
  async run(now=Date.now()){
    if(!this.c.researchMilestonesEnabled)return 0;
    const state=await this.store.state();
    if(state.chat_key!==this.delivery.chatKey||!await this.store.claimResearchMilestoneRun(now))return 0;
    let attempts=0;
    const enabled=this.enabledCollectors(),coverage=await this.coverage(),byCollector=new Map(coverage.map(item=>[item.collector,item]));
    if(enabled.length&&enabled.every(collector=>byCollector.has(collector))){
      const activation=Math.max(...enabled.map(collector=>byCollector.get(collector)!.activatedAt));
      const enoughDays=enabled.every(collector=>byCollector.get(collector)!.days>=PHASE4_MIN_OBSERVATION_DAYS);
      const counts=enabled.map(collector=>`${collectorLabel(collector)}: ${byCollector.get(collector)!.days} UTC days`).join(' · ');
      if(now-activation>=PHASE4_READY_DAYS*DAY&&enoughDays)attempts+=Number(await this.notify('phase4:coverage-ready:21d','phase4_coverage',
        {activation,coverage},`🧪 <b>PHASE 4 COVERAGE READY</b>\n\nAt least 21 days have elapsed and every enabled collector has observations on at least 15 UTC days.\n${escapeHtml(counts)}\n\nPhase 4 can now be run. This message changes no scanner or alert behavior.`));
      if(now-activation>=PHASE4_PREFERRED_DAYS*DAY&&enoughDays)attempts+=Number(await this.notify('phase4:preferred-checkpoint:28d','phase4_preferred',
        {activation,coverage},`🧪 <b>PHASE 4 PREFERRED CHECKPOINT</b>\n\nThe 28-day prospective checkpoint is ready.\n${escapeHtml(counts)}\n\nPhase 4 can be rerun with the preferred four-week window. Nothing has changed automatically.`));
    }

    for(const shadow of await this.shadows()){
      const summary=escapeHtml(shadowSummaryLine(shadow));
      for(const threshold of [25,50,100]){
        const required=Math.ceil(shadow.requiredSignals*threshold/100);
        if(shadow.resolvedSignals>=required)attempts+=Number(await this.notify(`shadow:${shadow.id}:signals:${threshold}`,'shadow_signals',
          {variantId:shadow.id,threshold,progress:shadow},`📊 <b>SHADOW CHALLENGER — ${threshold}% SAMPLE</b>\n\n<b>${escapeHtml(shadow.label)}</b>\n${summary}\n\nResearch progress only. Nothing has changed automatically.`));
      }
      if(shadow.signalDays>=shadow.requiredDays)attempts+=Number(await this.notify(`shadow:${shadow.id}:days:${shadow.requiredDays}`,'shadow_days',
        {variantId:shadow.id,progress:shadow},`📊 <b>SHADOW CHALLENGER — DAY REQUIREMENT REACHED</b>\n\n<b>${escapeHtml(shadow.label)}</b>\n${summary}\n\nResearch progress only. Nothing has changed automatically.`));
      if(shadow.eligible)attempts+=Number(await this.notify(`shadow:${shadow.id}:owner-review`,'shadow_owner_review',
        {variantId:shadow.id,progress:shadow},`✅ <b>${escapeHtml(shadow.label)}</b> is eligible for OWNER REVIEW. Nothing has changed automatically.\n\n${summary}`));
    }

    try{
      const storage=await this.storage(),thresholds=crossedStorageThresholds(storage.usageMb,this.c.dbVolumeLimitMb);
      const tables=storage.tables.slice(0,5).map(item=>`• ${escapeHtml(item.name)}: ${item.sizeMb.toFixed(1)} MB`).join('\n')||'No research table sizes available.';
      for(const threshold of [80,90] as const)if(thresholds[`crossed${threshold}`])attempts+=Number(await this.notify(`storage:${threshold}`,'storage_warning',
        {threshold,storage,limitMb:this.c.dbVolumeLimitMb},`⚠️ <b>DATABASE STORAGE ${threshold}% WARNING</b>\n\nCurrent database usage: ${storage.usageMb.toFixed(1)} MB / ${this.c.dbVolumeLimitMb.toFixed(1)} MB (${thresholds.percent.toFixed(1)}%).\n\n<b>Largest research tables</b>\n${tables}`));
    }catch{/* Storage introspection failure must not block other research milestones. */}

    const existing=await this.store.researchMilestoneEvents();
    for(const collector of enabled){
      const current=byCollector.get(collector);if(!current)continue;
      const latestWarning=existing.filter(event=>event.kind==='collector_stalled'&&event.data?.collector===collector).at(-1);
      const recovery=latestWarning&&existing.find(event=>event.kind==='collector_recovered'&&event.data?.warningKey===latestWarning.key);
      if(latestWarning&&!recovery&&current.lastObservationAt!==null&&current.lastObservationAt>latestWarning.reservedAt){
        attempts+=Number(await this.notify(`collector-recovered:${latestWarning.key}`,'collector_recovered',{collector,warningKey:latestWarning.key,lastObservationAt:current.lastObservationAt},
          `✅ <b>RESEARCH COLLECTOR RECOVERED</b>\n\n${escapeHtml(collectorLabel(collector))} recorded new observations after its 12-hour stall. Research collection has resumed.`));
      }
      const anchor=current.lastObservationAt??current.activatedAt;
      if(now-anchor>=COLLECTOR_STALL_HOURS*HOUR){
        const key=`collector-stalled:${collector}:${new Date(anchor).toISOString()}`;
        attempts+=Number(await this.notify(key,'collector_stalled',{collector,lastObservationAt:current.lastObservationAt,activatedAt:current.activatedAt},
          `⚠️ <b>RESEARCH COLLECTOR STALLED</b>\n\n${escapeHtml(collectorLabel(collector))} has recorded zero new observations for at least 12 hours. Live BUY and SCOUT alert behavior is unaffected.`));
      }
    }
    return attempts;
  }

  async statuses():Promise<MilestoneStatus[]>{
    const events=await this.store.researchMilestoneEvents(),eventByKey=new Map(events.map(event=>[event.key,event]));
    const status=(key:string,label:string,applicable=true):MilestoneStatus=>{
      if(!applicable)return{key,label,status:'not applicable',at:null};
      const event=eventByKey.get(key);if(!event)return{key,label,status:'pending',at:null};
      return{key,label,status:event.status==='sent'?'sent':'delivery unknown',at:event.sentAt??event.reservedAt};
    };
    const monitoring=this.c.researchMilestonesEnabled,enabled=this.enabledCollectors(),rows:MilestoneStatus[]=[
      status('phase4:coverage-ready:21d','Phase 4 coverage ready (21 days)',monitoring&&enabled.length>0),
      status('phase4:preferred-checkpoint:28d','Phase 4 preferred checkpoint (28 days)',monitoring&&enabled.length>0),
    ];
    const shadows=await this.shadows();
    for(const shadow of shadows){
      for(const threshold of [25,50,100])rows.push(status(`shadow:${shadow.id}:signals:${threshold}`,`${shadow.label}: ${threshold}% resolved-signal sample`,monitoring));
      rows.push(status(`shadow:${shadow.id}:days:${shadow.requiredDays}`,`${shadow.label}: ${shadow.requiredDays} distinct signal days`,monitoring));
      rows.push(status(`shadow:${shadow.id}:owner-review`,`${shadow.label}: eligible for owner review`,monitoring));
    }
    rows.push(status('storage:80','Database storage at 80%',monitoring),status('storage:90','Database storage at 90%',monitoring));
    for(const collector of ['regime','young_pool'] as const){
      const applicable=monitoring&&enabled.includes(collector),warnings=events.filter(event=>event.kind==='collector_stalled'&&event.data?.collector===collector),warning=warnings.at(-1);
      const recovery=warning?events.find(event=>event.kind==='collector_recovered'&&event.data?.warningKey===warning.key):undefined;
      rows.push(warning?status(warning.key,`${collectorLabel(collector)} stalled`,applicable):{key:`collector-stalled:${collector}`,label:`${collectorLabel(collector)} stalled`,status:applicable?'pending':'not applicable',at:null});
      rows.push(recovery?status(recovery.key,`${collectorLabel(collector)} recovered`,applicable):{key:`collector-recovered:${collector}`,label:`${collectorLabel(collector)} recovered`,status:warning&&applicable?'pending':'not applicable',at:null});
    }
    return rows;
  }
}
