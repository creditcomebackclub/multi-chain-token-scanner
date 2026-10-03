# Phase 4 coverage gate

**Status:** stopped after Step 0 — no Phase 4 hypothesis has enough prospective coverage.

This report was generated from aggregate production-database queries at **2026-10-03 19:45 UTC** (**12:45 PM Arizona time**). The Phase 2 collector build started in production at **2026-10-03 15:22:45 UTC** after the flags were enabled. Only observations recorded after that activation are eligible for Phase 4, regardless of the timestamp carried by a provider candle.

## Production settings

| Setting | Effective value |
| --- | ---: |
| `REGIME_CANDLES_ENABLED` | `true` |
| `YOUNG_POOL_RESEARCH_ENABLED` | `true` |
| `CANDLE_RETENTION_DAYS` | `90` |
| `EXECUTION_COST_LOGGING_ENABLED` | unset / disabled |
| `WALLET_WATCH_ENABLED` | `false` |

The Railway Postgres volume used approximately **278 MiB of 500 MiB** when the settings were changed. Raising chart-candle retention from 35 to 90 days is expected to add roughly 22 MiB at the previously measured rate of 0.4 MiB per additional day, leaving operating headroom for the research tables. Storage should still be monitored as the young-pool sample table grows.

## Coverage

| Dataset | Raw production coverage | Prospectively eligible coverage | Gate result |
| --- | --- | --- | --- |
| Major-asset regime candles | 1,653 rows: 551 each for SOL, ETH, and BNB; provider timestamps span 2026-10-01 21:45 through 2026-10-03 19:35 UTC | Approximately four hours beginning with collector activation on 2026-10-03. The pre-activation candles returned by the initial 500-candle API refresh are explicitly ineligible. | **Insufficient** for regime analysis |
| Young-pool cohort | 27 observations, 142 samples, and 27 provisional outcome rows; observations span 2026-10-03 15:25 through 19:41 UTC; 17 Base and 10 Ethereum pools | One partial UTC day | **Insufficient** for pool-age or order-flow analysis |
| Logged real execution costs | Collector disabled; provider health says `Executable cost logging disabled` | 0 quotes / 0 trades | **Blocked**; no approved read-only FOMO execution interface |
| Wallet-watch outcomes | Tables present, but 0 observations, 0 samples, and 0 outcomes | 0 days | **Blocked** while wallet watch is disabled |
| Extended chart-candle retention | 64,510 rows spanning 2026-09-26 08:25 through 2026-10-03 19:35 UTC (8 calendar dates) | The 90-day policy began on 2026-10-03 and cannot backfill the additional retention window | **Insufficient** for the requested 3–4 week prospective study |

Collector health at the coverage check was **healthy** for both regime candles and young pools. Regime health reported zero asset refresh failures. No alert rule, BUY threshold, delivery cap, or Telegram push behavior changed.

## Hypothesis decisions

| Phase 4 hypothesis | Decision at this gate |
| --- | --- |
| Regime | Stop: fewer than 3–4 prospective weeks |
| Pool age | Stop: one partial day of young-pool observations |
| Order flow | Stop: one partial day of the prospective young-pool cohort |
| Wallet following | Stop: collector disabled and no observations |
| Real costs | Stop: collector disabled because no compliant quote source is approved |

No Phase 4 preregistration or results analysis should be created from this snapshot. Re-run the coverage gate no earlier than **2026-10-24** for a three-week check; **2026-10-31** is the preferred four-week checkpoint. Wallet-following and real-cost hypotheses remain blocked at either date unless their collectors are separately enabled with valid sources.
