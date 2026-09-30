import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHAINS, DAY, MINUTE, RULE_ID, fomoAllowed, rules, type Config } from './config.js';
import type { Store } from './store.js';
export const scopeId = (c: Config) => createHash('sha256').update(JSON.stringify({ chains: [...c.chains].sort(), base: c.baseFomoConfirmed })).digest('hex').slice(0, 16);
export const evidenceSchema = z.object({
  ruleId: z.string(), scope: z.string(), reviewedBy: z.string().min(1),
  reviews: z.array(z.object({ referenceId: z.string().uuid(), checkedAt: z.number().positive(),
    fullAddressAndChainVerified: z.literal(true), orderUsd: z.number().positive(),
    priceImpactPercent: z.number().min(0), source: z.string().min(10) }).strict()).min(1),
}).strict();
export async function approveRollout(store: Store, c: Config, input: unknown, now = Date.now()) {
  const evidence = evidenceSchema.parse(input), scope = scopeId(c);
  if (evidence.ruleId !== RULE_ID || evidence.scope !== scope) throw new Error('Review belongs to different rules or chain configuration');
  const start = (await store.db.query('SELECT started_at FROM rule_versions WHERE id=$1', [RULE_ID])).rows[0];
  if (!start || now - new Date(start.started_at).getTime() < 7 * DAY) throw new Error('Seven full observation days have not elapsed');
  // Require an uninterrupted recent seven-day record, with up to two missing minutes per day for scheduling jitter.
  const minuteRows = (await store.db.query('SELECT at FROM observation_minutes WHERE rule_id=$1 AND scope=$2 AND at>=$3 ORDER BY at', [RULE_ID, scope, new Date(now - 7 * DAY).toISOString()])).rows;
  if (minuteRows.length < 7 * 24 * 60 - 14) throw new Error('Insufficient healthy observation coverage for seven days');
  for (let i = 1; i < minuteRows.length; i++) if (new Date(minuteRows[i].at).getTime() - new Date(minuteRows[i - 1].at).getTime() > 3 * MINUTE) throw new Error('Observation coverage contains an unreviewed gap');
  for (const chain of c.chains.filter(chain => fomoAllowed(chain, c))) if (!await store.covered(chain, now)) throw new Error(`Unhealthy current coverage: ${chain}`);
  const providerHealth = await store.healthAll();
  for (const name of ['dexscreener', 'goplus']) {
    const h = providerHealth.find(h => h.provider === name);
    if (!h || h.state !== 'healthy' || now - h.checkedAt > 5 * MINUTE) throw new Error(`Current provider check required: ${name}`);
  }
  const refs = (await store.db.query(`SELECT r.*,s.data FROM tracked_references r JOIN snapshots s ON s.id=r.snapshot_id
    WHERE r.kind='shadow' AND s.rule_id=$1 AND r.at >= $2 AND r.at <= $3`, [RULE_ID, new Date(now - 7 * DAY).toISOString(), new Date(now - 2 * MINUTE).toISOString()])).rows;
  if (!refs.length) throw new Error('No mature retrospectively qualifying candidates');
  const reviews = new Map(evidence.reviews.map(r => [r.referenceId, r]));
  if (reviews.size !== evidence.reviews.length) throw new Error('Duplicate review entries');
  let passed = 0;
  for (const ref of refs) {
    const review = reviews.get(ref.id), at = new Date(ref.at).getTime();
    if (!review || review.checkedAt < at + MINUTE || review.checkedAt > at + 2 * MINUTE || review.orderUsd !== rules.evaluationOrderUsd) continue;
    const samples = await store.samples(ref.id);
    const sample = samples.find(s => s.at >= at + MINUTE && s.at <= at + 2 * MINUTE);
    if (sample && sample.liquidity >= CHAINS[ref.chain as keyof typeof CHAINS].minLiquidity && sample.liquidity >= ref.data.market.liquidity * 0.9 && review.priceImpactPercent <= rules.maxPriceImpactPercent) passed++;
  }
  if (passed / refs.length < 0.9) throw new Error(`One-minute acceptance failed: ${passed}/${refs.length}; missing evidence counts as failure`);
  const duplicate = (await store.db.query(`SELECT 1 FROM alerts a JOIN alerts b ON a.chain=b.chain AND a.token=b.token AND a.id<>b.id
    WHERE a.status='sent' AND b.status='sent' AND abs(extract(epoch from a.sent_at-b.sent_at))<86400 LIMIT 1`)).rows.length;
  if (duplicate) throw new Error('Duplicate alerts detected');
  await store.db.query(`INSERT INTO rollout_approvals(rule_id,scope,evidence) VALUES($1,$2,$3)
    ON CONFLICT(rule_id,scope) DO UPDATE SET evidence=excluded.evidence,approved_at=clock_timestamp()`, [RULE_ID, scope, JSON.stringify({ ...evidence, passed, total: refs.length, reviewedAt: now })]);
  return { passed, total: refs.length, ruleId: RULE_ID, scope };
}
