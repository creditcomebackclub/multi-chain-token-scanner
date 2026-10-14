# Read-only research collection

All Phase 2 collectors default off. They write research tables and provider health only. None of their code calls `reserveChart`, `reserveShortlist`, `begin*Send`, or Telegram.

## Flags

| Setting | Default | Collection |
| --- | --- | --- |
| `REGIME_CANDLES_ENABLED` | `false` | Closed 5-minute SOL, ETH, and BNB candles from fixed high-liquidity native/stable pools. |
| `YOUNG_POOL_RESEARCH_ENABLED` | `false` | One new 10m–4h control per chain and discovery cycle, exact-pool market evidence, GoPlus result, and subsequent spot/liquidity samples. |
| `CANDLE_RETENTION_DAYS` | `35` | Retention for `chart_candles` and `research_regime_candles`; valid range 1–365. |
| `EXECUTION_COST_LOGGING_ENABLED` | `false` | Enables owner-reported `/entered` and `/exited` fill evidence with contemporaneous exact-pool DEX comparisons. It never connects a wallet or substitutes DEX spot for a FOMO fill. |
| `WALLET_WATCH_ENABLED` | `false` | Existing owner-controlled wallet monitoring. When enabled, buys also create research observations and asynchronous outcome samples. |

## Stored evidence

`research_regime_candles` holds OHLCV only. `young_pool_research_*` stores discovery context, exact-pool entry evidence, GoPlus status, sampled returns, MFE/MAE, fixed horizons, and a −100% outcome when liquidity falls to at most 1% of entry liquidity or $100. `wallet_watch_research_*` stores an opaque event ID, token and chain, source/detection timestamps, delay, non-identity trade amounts, and market outcomes. It excludes trader names, wallet addresses, and transaction hashes from the research JSON and is not included in current exports or reports.

Young-pool collection is rate bounded to one new GoPlus check per chain in each 15-minute discovery cycle. Regime collection makes three requests per five-minute cycle through the shared `Http` queue, so existing public or paid pacing and cooldowns apply. Outcome sampling uses the existing batched DEX Screener client.

`execution_cost_observations` stores manually reported entry/exit fills and their read-only exact-pool market comparisons. Reports label these calculations `observed`; the locked replacement model is labelled `model:cost-model-v1`, and the legacy fixed assumption is labelled `modeled:flat-bps`. The three sources remain separate.

## Retention estimate

The committed production snapshot contains 45,081 chart candles under the 35-day default, or about 1,288 rows per retained day. A planning allowance of 320 bytes per row for the heap, primary key, and time index is about 0.4 MiB for each extra day and 12 MiB for 30 extra days. Measure the deployed database before a large increase:

```sql
SELECT pg_size_pretty(pg_total_relation_size('chart_candles')),
       count(*) AS rows,
       min(at) AS oldest,
       max(at) AS newest
FROM chart_candles;
```

The estimate does not include backup replication or Railway plan overhead.

## Storage safety

`DB_VOLUME_LIMIT_MB` is the attached volume capacity in **decimal MB**: use `5000` for a Railway 5 GB volume. Production research writes are checked at most once per minute against all database files plus PostgreSQL WAL. This is a **lower bound**, not a filesystem measurement: temporary files, filesystem overhead, and other cluster files can consume additional space. Railway volume metrics remain the authoritative disk measurement.

At 80% of that budget, new chart research/candle writes, raw-signal research samples, regime and young-pool collection, wallet research, outcome labeling, and shadow enrollment/resolution pause. They resume below 70%, leaving room for PostgreSQL recovery. Unavailable cluster/WAL measurements also pause research. Historical observations are not deleted; missing intervals remain missing. Alert rules, delivery caps, private commands, delivered-alert sampling, actual-fill logging, and owner-position checks keep their existing paths. A sufficiently full disk can still interrupt those paths, so a pause is headroom protection rather than an uptime guarantee.

`/status` reports `research-storage`. The hourly `/milestones` monitor evaluates storage before expensive cohort/model summaries and sends private warnings at 80% and 90%, including WAL and the largest tables. Warnings are persisted per configured capacity, so a previous 500 MB warning cannot suppress a later 5 GB warning. Incomplete WAL measurement has its own notice. Update the environment budget whenever resizing the volume.

Research history is retained rather than automatically purged to meet a quota. As it grows, export and verify an archive before deciding to remove old rows, or increase capacity after checking costs. Keep 90-day candle retention for the current study; do not erase prospective observations to make room. PostgreSQL durability and WAL recovery remain enabled.

If Postgres reports `No space left on device`, expand the **existing** volume first. Do not wipe the volume, remove WAL files, reset WAL, or disable durability. Verify database recovery, collector timestamps and counts, and a successful backup. Deploy scanner changes only after their PR is merged, from `main`.

`node scripts/backup-postgres.mjs` creates an owner-local custom PostgreSQL archive through the existing private Railway SSH connection. PostgreSQL fully reads/decompresses it to `/dev/null` before transfer; this is archive validation, not a test restore. Files and checksum metadata go to ignored `outputs/private-backups/`, with owner-only permissions. These contain operational/private data and must never become public research-release assets. Native scheduled backups and independent volume-usage email alerts require Railway Pro on this account; enabling them needs a separately approved plan change. A local manual backup is not a server-side backup schedule.
