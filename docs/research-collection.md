# Read-only research collection

All Phase 2 collectors default off. They write research tables and provider health only. None of their code calls `reserveChart`, `reserveShortlist`, `begin*Send`, or Telegram.

## Flags

| Setting | Default | Collection |
| --- | --- | --- |
| `REGIME_CANDLES_ENABLED` | `false` | Closed 5-minute SOL, ETH, and BNB candles from fixed high-liquidity native/stable pools. |
| `YOUNG_POOL_RESEARCH_ENABLED` | `false` | One new 10m–4h control per chain and discovery cycle, exact-pool market evidence, GoPlus result, and subsequent spot/liquidity samples. |
| `CANDLE_RETENTION_DAYS` | `35` | Retention for `chart_candles` and `research_regime_candles`; valid range 1–365. |
| `EXECUTION_COST_LOGGING_ENABLED` | `false` | Currently reports blocked because no approved read-only FOMO quote interface exists. It never substitutes DEX spot prices. |
| `WALLET_WATCH_ENABLED` | `false` | Existing owner-controlled wallet monitoring. When enabled, buys also create research observations and asynchronous outcome samples. |

## Stored evidence

`research_regime_candles` holds OHLCV only. `young_pool_research_*` stores discovery context, exact-pool entry evidence, GoPlus status, sampled returns, MFE/MAE, fixed horizons, and a −100% outcome when liquidity falls to at most 1% of entry liquidity or $100. `wallet_watch_research_*` stores an opaque event ID, token and chain, source/detection timestamps, delay, non-identity trade amounts, and market outcomes. It excludes trader names, wallet addresses, and transaction hashes from the research JSON and is not included in current exports or reports.

Young-pool collection is rate bounded to one new GoPlus check per chain in each 15-minute discovery cycle. Regime collection makes three requests per five-minute cycle through the shared `Http` queue, so existing public or paid pacing and cooldowns apply. Outcome sampling uses the existing batched DEX Screener client.

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
