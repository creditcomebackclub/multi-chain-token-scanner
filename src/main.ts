import { schedule } from './schedule.js';
import { createServer } from 'node:http';
import { config, HOUR, MINUTE, RULE_ID, type Chain } from './config.js';
import { Store, postgres } from './store.js';
import { BitqueryHttp, BitqueryStream, type StreamHooks } from './providers/bitquery.js';
import { Http } from './providers/http.js';
import { Helius } from './providers/helius.js';
import { DexScreener, GoPlus } from './providers/enrichment.js';
import { Telegram } from './telegram.js';
import { Worker } from './worker.js';
import { scopeId } from './rollout.js';
import { FreeDiscovery } from './providers/discovery.js';
import { ShortlistWorker } from './shortlist.js';
import { ChartSetupWorker } from './chart-setups.js';
import { WalletWatch } from './wallet-watch.js';
import { ChartMonitor } from './chart-monitor.js';
import { ResearchCollector } from './research-collection.js';
import { ResearchMilestones } from './research-milestones.js';
import { ExecutionCosts } from './execution-costs.js';

async function main() {
  const c = config();
  if (!c.databaseUrl) throw new Error('Set DATABASE_URL in .env or deployment secrets. Use npm run demo without credentials.');
  if (c.scanMode === 'full' && c.ingestionEnabled && !c.bitqueryToken) throw new Error('Set BITQUERY_TOKEN for full scanning, or SCAN_MODE=shortlist for free discovery.');
  if ((c.pushEnabled || c.walletWatchEnabled || c.chartSetupsEnabled) && (!c.telegramToken || !c.telegramChatId)) throw new Error('PUSH_ENABLED or WALLET_WATCH_ENABLED requires Telegram bot token and private chat ID');
  if (c.telegramToken && !/^[1-9]\d*$/.test(c.telegramChatId)) throw new Error('TELEGRAM_CHAT_ID must identify one private user chat');
  const store = new Store(postgres(c.databaseUrl),c);
  await store.migrate();
  await store.ensureResearchCollectorActivations([
    ...(c.regimeCandlesEnabled?['regime' as const]:[]),
    ...(c.youngPoolResearchEnabled?['young_pool' as const]:[]),
  ],c.researchCollectorActivatedAt);
  const latestBuy=await store.latestChartAlert();
  if(latestBuy){
    const plan=latestBuy.data?.plan,outcome=latestBuy.outcome,pair=latestBuy.data?.pair;
    console.log(JSON.stringify({event:'latest-buy-analysis',symbol:pair?.symbol,chain:latestBuy.chain,token:latestBuy.token,sentAt:latestBuy.sentAt,
      entry:plan?.referenceEntry,entryMin:plan?.entryMin,entryMax:plan?.entryMax,stop:plan?.stop,tp1:plan?.takeProfit,tp2:plan?.runnerTarget,
      firstHit:outcome?.firstHit??null,stopAt:outcome?.stopAt??null,tp1At:outcome?.tp1At??null,tp2At:outcome?.tp2At??null,
      minPrice:outcome?.minPrice??null,maxPrice:outcome?.maxPrice??null,lastPrice:latestBuy.lastPrice,lastSampleAt:latestBuy.lastSampleAt,lastLiquidity:latestBuy.lastLiquidity}));
  }
  try { console.log(JSON.stringify({event:'strategy-learning',...(await store.chartLearningStats(c.researchRoundTripCostBps))})); }
  catch { console.error('Strategy learning report unavailable; retrying with the next chart cycle.'); }
  const bitquery = new BitqueryHttp(c.bitqueryToken, new Http(Math.ceil(MINUTE / c.bitqueryRequestsPerMinute), fetch, { rateLimitRetries: 2 }));
  const telegram = c.telegramToken ? new Telegram(c, store) : undefined;
  const milestoneTelegram=telegram;
  const researchMilestones=milestoneTelegram?new ResearchMilestones(c,store,{chatKey:milestoneTelegram.chatKey,send:text=>milestoneTelegram.send(text)}):undefined;
  if(researchMilestones)milestoneTelegram!.attachResearchMilestones(researchMilestones);
  const dex = new DexScreener(), security = new GoPlus(c.goplusToken);
  const executionCosts=telegram&&c.executionCostLoggingEnabled?new ExecutionCosts(c,store,dex):undefined;
  if(executionCosts)telegram!.attachExecutionCosts(executionCosts);
  const auditRecentSecurity=async()=>{
    const pending=await store.chartSecurityAuditCandidates();
    const counts:Record<string,number>={};
    for(const row of pending){
      const result=await security.check(row.chain,row.token,row.pool);
      const evidence={status:result.status,reasons:result.reasons,buyTax:result.buyTax,sellTax:result.sellTax,checkedAt:result.checkedAt,audit:'goplus-policy-v2-current-state'};
      await store.saveChartSignalSecurityAudit(row.id,evidence);counts[result.status]=(counts[result.status]??0)+1;
    }
    const current=(await store.chartSignalStats()).security;
    await store.health('goplus',current.evidence?(current.statuses.UNKNOWN?'degraded':'healthy'):'disabled',current.evidence
      ?`Current policy evidence for ${current.evidence} recent setups: ${current.statuses.PASS} pass, ${current.statuses.REJECT} reject, ${current.statuses.UNKNOWN} incomplete. Public API paced below 30 calls/minute.`
      :'Waiting for a setup that reaches the security gate.');
    console.log(JSON.stringify({event:'goplus-security-audit',checked:pending.length,counts,current}));
  };
  const worker = new Worker(c, store, dex, security, bitquery, telegram);
  const publicHttp = new Http(12_000, fetch, { minRateLimitCooldownMs: 60_000 });
  const chartHttp = c.coingeckoProKey ? new Http(250, fetch, { rateLimitRetries: 1, minRateLimitCooldownMs: 10_000 }) : publicHttp;
  const researchCollector=new ResearchCollector(c,store,chartHttp,dex,security);
  const shortlist = new ShortlistWorker(c, store, new FreeDiscovery(publicHttp), dex, security, telegram,researchCollector);
  const chartSetups = new ChartSetupWorker(c, store, chartHttp, dex, security, telegram);
  await store.health('chart-setups', c.chartSetupsEnabled ? 'degraded' : 'disabled', c.chartSetupsEnabled ? 'Waiting for daily watchlist and candle baseline' : 'Chart setup alerts disabled');
  const chartMonitor = new ChartMonitor(store,dex,telegram);
  await store.health('chart-monitor', c.chartSetupsEnabled ? 'degraded' : 'disabled', c.chartSetupsEnabled ? 'Waiting for delivered alert samples' : 'Chart monitoring disabled');
  const walletWatch = telegram && c.walletWatchEnabled ? new WalletWatch(c, store, telegram, dex) : undefined;
  const fullScanning = c.ingestionEnabled && c.scanMode === 'full';
  const mode = !c.ingestionEnabled ? 'standby' : c.scanMode === 'shortlist' ? 'shortlist' : c.pushEnabled ? 'gated-alerts' : 'observe';
  const hooks: Partial<Record<Chain, StreamHooks>> = Object.fromEntries(c.chains.map(chain => [chain, {
    ingest: e => store.ingest(e),
    health: async (ok, detail, last) => { await store.health(`bitquery:${chain}`, ok ? 'healthy' : 'degraded', detail, last); },
    cursor: async () => (await store.healthAll()).find(h => h.provider === `bitquery:${chain}`)?.lastEventAt ?? null,
    gap: (from, to) => store.gap(chain, from, to),
  } satisfies StreamHooks]));
  const streams = fullScanning ? [new BitqueryStream(c.chains, c.bitqueryToken, bitquery, hooks)] : [];
  if (!fullScanning) for (const chain of c.chains) await store.health(`bitquery:${chain}`, 'disabled', c.ingestionEnabled ? 'Free shortlist uses public pool feeds; no Bitquery requests' : 'Scanning on standby');
  if (c.scanMode === 'shortlist') for (const chain of c.chains) await store.health(`discovery:${chain}`, c.ingestionEnabled ? 'degraded' : 'disabled', c.ingestionEnabled ? 'Waiting for first public pool refresh' : 'Scanning on standby');
  await store.health('telegram', telegram ? 'degraded' : 'disabled', telegram ? 'Waiting for Telegram connection' : 'Bot not configured');
  await store.health('dexscreener', c.scanMode === 'shortlist' && c.ingestionEnabled ? 'degraded' : 'disabled', c.scanMode === 'shortlist' && c.ingestionEnabled ? 'Waiting for first candidate-driven exact-pool check' : 'Waiting for first mature candidate');
  await store.health('goplus', 'disabled', 'Waiting for market-qualified candidate');
  await store.health('research-regime',c.regimeCandlesEnabled?'degraded':'disabled',c.regimeCandlesEnabled?'Waiting for first paced SOL/ETH/BNB candle refresh':'Regime candle collection disabled');
  await store.health('research-young-pools',c.youngPoolResearchEnabled?'degraded':'disabled',c.youngPoolResearchEnabled?'Waiting for first 10m–4h discovery cohort':'Young-pool research disabled');
  await store.health('research-costs',executionCosts?'healthy':'disabled',executionCosts?'Manual observed-fill capture ready; exact-pool DEX comparisons are read-only and no order interface exists':'Manual execution-cost logging disabled');
  if (!walletWatch) for (const chain of c.chains) await store.health(`watch:${chain}`, 'disabled', 'Direct wallet alerts disabled');
  let helius: Helius | undefined;
  if (fullScanning && c.heliusEnabled && c.heliusKey && c.heliusPrograms.length && c.chains.includes('solana')) {
    helius = new Helius(c.heliusKey, c.heliusPrograms, e => store.discover(e), async (ok, detail) => { await store.health('helius', ok ? 'healthy' : 'degraded', detail); }, async () => { const now = Date.now(); await bitquery.backfill('solana', now - MINUTE, now, e => store.ingest(e)); });
  } else await store.health('helius', 'disabled', c.heliusEnabled ? 'Key or verified program allowlist missing; Bitquery fallback active' : 'Optional fast path disabled');
  let stopping = false, running = false, chartRunning = false, monitorRunning = false, researchRunning=false, milestoneRunning=false, observing = false, healthyDatabase = true, lastResearchLog=0;
  const logResearchStatus=async()=>{
    const [alerts,signals,research,learning,health]=await Promise.all([store.chartStats(),store.chartSignalStats(),store.chartResearchStats(),store.chartLearningStats(c.researchRoundTripCostBps),store.healthAll()]);
    console.log(JSON.stringify({event:'research-status',alerts,signals,research,learning,health:health.filter(item=>['chart-setups','chart-monitor','shortlist','dexscreener','goplus','telegram'].includes(item.provider))}));
    lastResearchLog=Date.now();
  };
  const server = createServer(async (request, response) => {
    if (request.url !== '/health' && request.url !== '/live') { response.writeHead(404).end(); return; }
    if (request.url === '/live') { response.writeHead(200).end('alive'); return; }
    try { await store.db.query('SELECT 1'); response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'running', mode, ruleId: RULE_ID })); }
    catch { response.writeHead(503).end('database unavailable; alert delivery paused'); }
  });
  server.listen(c.port, '0.0.0.0');
  streams.forEach(s => s.start()); helius?.start(); if (telegram) void telegram.poll(); await walletWatch?.start(); void auditRecentSecurity().catch(()=>console.error('GoPlus security audit failed; retry on next deployment.'));
  const tick = async () => {
    if (!c.ingestionEnabled || running || stopping) return; running = true;
    try { await (c.scanMode === 'shortlist' ? shortlist.tick() : worker.tick()); healthyDatabase = true; }
    catch { healthyDatabase = false; await store.health(c.scanMode === 'shortlist' ? 'shortlist' : 'evaluation', 'degraded', 'Evaluation cycle failed; retrying next cycle').catch(() => undefined); console.error('Evaluation cycle failed; retrying next cycle.'); }
    finally { running = false; }
  };
  const chartTick = async () => {
    if (!c.ingestionEnabled || chartRunning || stopping) return;
    chartRunning=true;
    try { await chartSetups.tick(); if(Date.now()-lastResearchLog>=15*MINUTE)await logResearchStatus(); }
    catch { await store.health('chart-setups','degraded','Chart cycle failed; retrying next cycle').catch(()=>undefined); }
    finally { chartRunning=false; }
  };
  const observe = async () => {
    if (!fullScanning || observing || stopping) return; observing = true;
    try { await worker.observeMinute(); } catch { healthyDatabase = false; } finally { observing = false; }
  };
  const monitorTick=async()=>{
    if(!c.chartSetupsEnabled||monitorRunning||stopping)return;monitorRunning=true;
    try{await chartMonitor.tick();}catch{await store.health('chart-monitor','degraded','Monitoring cycle failed; retrying next minute').catch(()=>undefined);}
    finally{monitorRunning=false;}
  };
  const researchTick=async()=>{
    if(researchRunning||stopping||!c.ingestionEnabled||!(c.regimeCandlesEnabled||c.youngPoolResearchEnabled||c.walletWatchEnabled))return;
    researchRunning=true;
    try{await researchCollector.tick();}catch{await store.health('research-collection','degraded','Read-only research cycle failed; alert delivery was unaffected').catch(()=>undefined);}
    finally{researchRunning=false;}
  };
  const milestoneTick=async()=>{
    if(!researchMilestones||milestoneRunning||stopping||!c.researchMilestonesEnabled)return;
    milestoneRunning=true;
    try{await researchMilestones.run();}catch{console.error('Research milestone evaluation failed; retrying after the hourly gate.');}
    finally{milestoneRunning=false;}
  };
  const stopEvaluation = schedule(() => void tick(), c.scanMode === 'shortlist' ? 15 * MINUTE : MINUTE, c.scanMode === 'shortlist' ? 2.5 * MINUTE : 0);
  const observationTimer = setInterval(() => void observe(), MINUTE);
  const chartTimer = setInterval(() => void chartTick(),5*MINUTE);
  const monitorTimer=setInterval(()=>void monitorTick(),MINUTE);
  const researchTimer=setInterval(()=>void researchTick(),5*MINUTE);
  const milestoneTimer=setInterval(()=>void milestoneTick(),HOUR);
  void chartTick();void monitorTick();void researchTick();void milestoneTick();
  console.log(JSON.stringify({ event: 'started', mode, ruleId: RULE_ID, scope: scopeId(c), port: c.port }));
  const shutdown = async () => {
    if (stopping) return; stopping = true; stopEvaluation(); clearInterval(chartTimer); clearInterval(monitorTimer); clearInterval(researchTimer);clearInterval(milestoneTimer);clearInterval(observationTimer);
    streams.forEach(s => s.stop()); helius?.stop(); walletWatch?.stop(); chartSetups.stop(); chartMonitor.stop();researchCollector.stop();telegram?.stop(); server.close();
    const deadline = Date.now() + 20_000;
    while ((running || chartRunning || monitorRunning || researchRunning || milestoneRunning || observing) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    await store.db.close(); console.log(JSON.stringify({ event: 'stopped', healthyDatabase })); process.exit(0);
  };
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
}
main().catch(error => { console.error(error instanceof Error && /^(Set |PUSH_|WALLET_|TELEGRAM_)/.test(error.message) ? error.message : 'Startup failed. Check configuration and Postgres connectivity.'); process.exitCode = 1; });
