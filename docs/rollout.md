# Observe, review, then enable private alerts

This gate applies only to `SCAN_MODE=full`. Free `shortlist` mode does not have complete confirmed-trade coverage, does not compute the full score, and never accumulates observation credit or enables candidate pushes.

## 1. Configure and verify the data path

Start with `PUSH_ENABLED=false`. If your account does not cover all five chains, set `CHAINS` to the explicit subset you intend to observe before beginning the seven-day period. Unsupported chains may remain configured for research, but every configured FOMO-enabled chain must be healthy for observation credit.

Confirm `/status` shows your intended chains and that `/recent` accumulates market and security results. Send `/start` from the configured private chat. Follow FOMO links manually and verify each full token address and chain. Configure Base only after confirming its FOMO route.

Run `npm run capture -- <chain> <token>` for representative shortlisted candidates. Captures contain public provider response bodies and no request headers/keys. They are ignored by Git. The command captures up to 1,000 rows and marks possible truncation; it is a fixture collector, not a complete historical export.

## 2. Seven full observation days

The service records one observation minute only while all configured FOMO chains have healthy, fresh confirmed coverage and pushes are explicitly disabled. The approval command requires at least 10,066 healthy minutes in the recent seven days and no internal gap longer than three minutes; the 14-minute allowance accounts for scheduler/restart jitter. Outages can extend the observation period.

Review `snapshots` and `tracked_references`. A shadow reference is created on two-snapshot confirmation, with a 24-hour token cooldown. It schedules the same measurements as a delivered alert without consuming the Telegram cap.

For every mature shadow reference, inspect a read-only FOMO preview or other reputable read-only executable quote **60–120 seconds after qualification**, using `evaluationOrderUsd` from `config/rules.json`. Record its price impact and verify the full address and chain. The scanner takes the accompanying DEX liquidity sample itself. A price-change percentage is not acceptable quote evidence. No transaction needs to be signed or sent.

To list reference IDs and times in Postgres:

```sql
SELECT r.id, r.chain, r.token, r.at, s.rule_id,
       s.data->'market'->>'pool' AS pool
FROM tracked_references r
JOIN snapshots s ON s.id=r.snapshot_id
WHERE r.kind='shadow' AND r.at > now()-interval '7 days'
ORDER BY r.at DESC;
```

## 3. Import the completed review

Create a review JSON using the `ruleId` and `scope` printed in startup logs. Each `checkedAt` is the actual quote timestamp in Unix milliseconds, not the later review/import time. `source` identifies the recorded preview/quote evidence sufficiently for audit.

```json
{
  "ruleId": "copy-the-current-rule-id",
  "scope": "copy-the-current-scope-id",
  "reviewedBy": "your name",
  "reviews": [
    {
      "referenceId": "copy-a-real-shadow-reference-uuid",
      "checkedAt": 0,
      "fullAddressAndChainVerified": true,
      "orderUsd": 100,
      "priceImpactPercent": 0,
      "source": "path or reference to actual timestamped quote evidence"
    }
  ]
}
```

This example is intentionally invalid until filled with real evidence. Do not copy placeholder timestamps or impact figures into a real review.

```sh
npm run approve-rollout -- path/to/review.json
```

The command rejects stale rule/scope IDs, inadequate observation, unhealthy current coverage, duplicate alerts, and acceptance below 90%. A missing quote review or missing one-minute liquidity sample counts as a failed candidate. Approval records evidence in Postgres; it does not itself turn pushes on.

## 4. Private dry run and weekly review

Set `PUSH_ENABLED=true` only after approval. Confirm `/status` reflects the approved rule/scope. Run the first day without trades, validate copied contracts and token routes in FOMO, and test `/pause` and `/resume`.

Review `/stats` by rule version each week. Change thresholds through the versioned JSON and repeat observation/review for the new rule ID. Score interpolation is a hypothesis to evaluate, not a calibrated probability of success.

## Forward shadow promotion checklist

`/shadow` reports the locked Phase 3 cohorts. Shadow enrollment and simulation never reserve or send an alert. The first registered challenger is `trailing-tp8-fixed3-24h-v1`, locked at `2026-10-03T14:33:12Z`: enter at the next five-minute candle open, use a fixed 3% stop, sell half at +8%, trail the remainder by one entry-time ATR, and close at 24 hours.

A variant may be considered for promotion only when every item below is true:

- [ ] The locked forward signal cohort reaches its pre-registered sample requirement (180 resolved signals and 20 distinct UTC entry days for the first challenger).
- [ ] Its day-block bootstrap 95% expectancy interval is wholly above zero under a complete `observed` cost view, or under complete `model:cost-model-v1` endpoints while that preregistered model remains valid.
- [ ] Its paired same-period edge over eligible control candles from the watched universe has a day-block bootstrap 95% interval wholly above zero.
- [ ] The flat-bps assumption is never used to pass the cost gate. Every cost is labelled `observed`, `model:cost-model-v1`, or `modeled:flat-bps`.
- [ ] The owner reviews the evidence and explicitly decides whether to change the live strategy.

Intervals remain “not estimable” with fewer than three day blocks. Passing the automatic evidence checks does not promote a variant or alter BUY alerts.

## Research milestone notifications

`RESEARCH_MILESTONES_ENABLED` defaults to `true`. The scanner evaluates research readiness at most once per hour and sends informational messages through the same validated private Telegram channel as health notices. Milestones have their own durable idempotency keys and never read or write BUY, SCOUT, cooldown, or delivery-cap state. `/milestones` shows every checkpoint and its current status.

Set `RESEARCH_COLLECTOR_ACTIVATED_AT` to the original ISO-8601 activation time before the first milestone-enabled deployment. The production Phase 2 cohort began at `2026-10-03T15:22:45Z`. The value is persisted separately for each enabled collector and an existing database record is never overwritten. Phase 4 sends one ready notice after 21 elapsed days plus 15 distinct UTC observation days per enabled collector, then a separate preferred-checkpoint notice at 28 days.

Each registered shadow variant sends one notice at 25%, 50%, and 100% of its required resolved signals, one at its required distinct-day count, and one if all automatic evidence gates pass. The eligibility notice explicitly requires owner review and performs no promotion. An enabled collector with no new observation for 12 hours sends one warning for that stall and one recovery when a later observation arrives.

Execution-cost evidence sends separate one-time notices for the first completed observed round trip, the 20-fill calibration checkpoint, and permanent `cost-model-v1` invalidation. These notices use the same milestone ledger and never consume BUY or SCOUT capacity.

## Manual execution-cost evidence

After a manual FOMO entry, send `/entered CONTRACT DOLLARS PRICE`. After the final manual exit, send `/exited CONTRACT DOLLARS_RECEIVED PRICE [FEES_USD]`. The scanner stores the delivered alert reference, exact chain/pool, and command-time DEX price/liquidity on both sides. It calculates observed entry/exit slippage against those snapshots and explicit fees; alert-to-entry market movement is kept as a diagnostic and is not counted as execution cost. `/costs` reports the distributions and the locked calibration test from [cost-model-v1](../research/ml/preregistration/cost-model-v1.md).

The v1 model uses half of reported pool liquidity per side, a locked 1.5 impact multiplier, configured FOMO fees, configured chain transaction estimates, and a 100 bps floor. `SHADOW_POSITION_USD` defaults to $50 and the report also shows $250 sensitivity. After at least 20 comparable fills, v1 is permanently invalidated if more than 25% of observed costs exceed it by over 1 bp. Re-enabling a model after invalidation requires a new preregistered version.

Set `DB_VOLUME_LIMIT_MB` to the configured Postgres volume size; it defaults to 500. One-time warnings at 80% and 90% report current database usage and the largest research tables. Database size comes from PostgreSQL's database-size functions and is an operational estimate of volume pressure.
