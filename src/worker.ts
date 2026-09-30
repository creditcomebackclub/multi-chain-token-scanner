import { aggregate } from './aggregate.js';
import { HOUR, MINUTE, fomoAllowed, type Config } from './config.js';
import { evaluate } from './scoring.js';
import { unknownSecurity } from './security.js';
import { measure } from './outcomes.js';
import { scopeId } from './rollout.js';
import type { Store } from './store.js';
import type { Telegram } from './telegram.js';
import type { BitqueryHttp } from './providers/bitquery.js';
import type { DexScreener, GoPlus } from './providers/enrichment.js';
export class Worker {
  private lastRetention = 0;
  constructor(private c: Config, private store: Store, private dex: DexScreener, private security: GoPlus, private bitquery: BitqueryHttp, private telegram?: Telegram) {}
  async tick() {
    const now = Date.now();
    const candidates = (await this.store.candidates(now)).filter(c => this.c.chains.includes(c.chain));
    for (const chain of this.c.chains) {
      const group = candidates.filter(c => c.chain === chain);
      if (!group.length) continue;
      let markets;
      try {
        markets = await this.dex.batch(chain, group.map(c => c.token));
        await this.store.health('dexscreener', 'healthy', 'Candidate enrichment responding');
      } catch {
        await this.store.health('dexscreener', 'degraded', 'Candidate enrichment unavailable');
        markets = new Map();
      }
      for (const candidate of group) {
        const at = Date.now(), token = candidate.token;
        const previous = await this.store.previous(chain, token);
        const available = markets.get(token) || [];
        // Keep one pool across confirmations and aggregate only that pool's trades.
        const market = available.find((m: any) => m.pool === previous?.market?.pool) || available[0] || null;
        const events = await this.store.events(chain, token, at - HOUR, at, market?.pool);
        const metrics = aggregate(events, at), covered = await this.store.covered(chain, at), tradeable = fomoAllowed(chain, this.c);
        const pre = evaluate({ chain, token, now: at, market, metrics, security: unknownSecurity(at, 'Not yet checked'), tradeable, covered, previous });
        const marketAndFlowPass = !pre.reasons.some(r => !r.startsWith('Security UNKNOWN'));
        const security = marketAndFlowPass ? await this.security.check(chain, token, market?.pool) : unknownSecurity(Date.now(), 'Market, flow, or coverage rules not met');
        if (marketAndFlowPass) await this.store.health('goplus', security.raw ? 'healthy' : 'degraded', security.raw ? 'Security API responding; incomplete token results remain UNKNOWN' : 'Security API unavailable');
        // Refresh time after I/O. A stale enrichment cannot qualify during a slow provider call.
        const snapshot = evaluate({ chain, token, now: Date.now(), market, metrics, security, tradeable, covered: covered && await this.store.covered(chain), previous });
        await this.store.save(snapshot);
        if (snapshot.confirmed) {
          await this.store.shadow(snapshot);
          if (this.telegram) await this.telegram.alert(snapshot);
        }
      }
    }
    await this.trackOutcomes();
    if (this.telegram) await this.healthNotices();
    if (now - this.lastRetention > HOUR) { await this.store.retention(); this.lastRetention = now; }
  }
  async observeMinute() {
    const now = Date.now(), enabled = this.c.chains.filter(c => fomoAllowed(c, this.c));
    if (!enabled.length) return;
    for (const chain of enabled) if (!await this.store.covered(chain, now)) return;
    const state = await this.store.state();
    // Observation credit is collected only with candidate pushes explicitly disabled.
    if (!this.c.pushEnabled && !state.paused) await this.store.recordObservation(scopeId(this.c), now);
  }
  private async trackOutcomes() {
    const now = Date.now(), refs = await this.store.activeReferences(now);
    for (const chain of this.c.chains) {
      const group = refs.filter(r => r.chain === chain);
      if (!group.length) continue;
      let markets;
      try { markets = await this.dex.batch(chain, [...new Set(group.map(r => r.token))]); } catch { continue; }
      for (const ref of group) {
        const market = markets.get(ref.token)?.find(m => m.pool === ref.snapshot.market?.pool);
        if (market && market.fetchedAt >= ref.at) await this.store.sample(ref.id, market.fetchedAt, market.price, market.liquidity);
        for (const hours of [1, 6, 24]) {
          const target = ref.at + hours * HOUR;
          if (now < target || await this.store.hasOutcome(ref.id, hours)) continue;
          // Fetch the target interval, not a new spot price mislabeled as historical.
          let completeBackfill = true;
          try { await this.bitquery.backfill(chain, target, Math.min(now, target + 5 * MINUTE), trades => this.store.ingest(trades), ref.token); }
          catch { completeBackfill = false; }
          const trades = await this.store.events(chain, ref.token, ref.at - 1, Math.min(now, target + 5 * MINUTE), ref.snapshot.market!.pool);
          const samples = await this.store.samples(ref.id), gap = !completeBackfill || await this.store.gapExists(chain, ref.at, target);
          const result = measure(ref, hours, trades, samples, gap);
          if (result.complete || now >= target + 5 * MINUTE) await this.store.outcome(ref.id, hours, result);
        }
      }
    }
  }
  private async healthNotices() {
    const state = await this.store.state();
    if (!this.telegram || state.chat_key !== this.telegram.chatKey) return;
    for (const h of await this.store.healthAll()) {
      if (h.state === 'degraded' && Date.now() - h.since >= 5 * MINUTE && !h.warned) {
        await this.store.warned(h.provider, true); // one attempt per outage, even after ambiguous delivery
        await this.telegram.send(`Provider warning: ${h.provider} has been unhealthy for at least five minutes. Candidate alerts requiring it are blocked.`).catch(() => undefined);
      } else if (h.state === 'healthy' && h.warned) {
        await this.store.warned(h.provider, false);
        await this.telegram.send(`Provider recovered: ${h.provider}.`).catch(() => undefined);
      }
    }
  }
}
