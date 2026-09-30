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
