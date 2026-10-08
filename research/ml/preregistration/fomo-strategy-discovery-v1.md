# FOMO strategy discovery v1

## Purpose and evidence boundaries

Find an executable-looking buy-only five-minute strategy by testing complete entries and exits, rather than optimizing TP1 classification accuracy. This registration must be pushed separately before this study reads real-data outcomes. The already published September 26–October 2 snapshot is reused **development data**, not pristine out-of-sample evidence. If production access works, chart observations from October 3 through October 7 UTC are a chronological confirmation set; they predate this registration and are **retrospective**, not prospective. Neither set can establish live profitability.

This study concerns existing chart observations only. It does not run the Phase 4 regime, young-pool, order-flow, wallet-following, or real-cost hypotheses before their coverage gates. No live rules, collectors, alerts, or Railway deployments change.

## Fixed candidate families

All candidates use only recorded closed-candle features. Require positive prices, ATR percentage >0 and <=8. Discovery metadata (including liquidity, age, and trade counts) is excluded because some records carry fetch timestamps later than detection. Security coverage and missing execution evidence are reported as limitations, not inferred.

The recorded candle is green when `bodyPct>0` and `closePosition` equals `lowerWickPct+bodyPct` within 1e-6; this follows directly from the OHLC geometry and uses no future bar.

1. **Support reclaim:** green; lower wick >=0.20; close position >=0.70; volume ratio >=1.2; rising EMA9; price 0–2% above EMA9; EMA9>=EMA21; >=2 support tests; recorded structural risk >0 and <=5%.
2. **Trend pullback:** green; close position >=0.65; price above SMA50; rising EMA21; EMA9>EMA21; price 0–2% above EMA9; volume ratio >=1.0; drawdown from the prior peak between −20% and −4%.
3. **Volume ignition:** green; body >=0.50; close position >=0.80; volume ratio >=2.0; rising EMA9 and non-falling EMA21; EMA9 within 1% of EMA21; price 0–3% above EMA9; prior-peak drawdown >=−20%.
4. **Return-ranked ML:** ridge regression (`alpha=10`) predicts net return for each exit, using the 14 existing chart features except `riskPct`. Training-only median imputation and standardization; no feature/hyperparameter search. Take a candidate only if predicted net return >0. Train on the first eligible observation per chain/token/UTC day with resolved labels, weighting days equally. The three pattern families and ML family form 12 candidates across the exits below.

## Fixed exits and fill assumptions

Use the existing TypeScript `simulatePath` implementation, with stops winning intrabar conflicts and gap-down fills at the worse open.

| ID | Structure | Stop | Target / management | Maximum hold |
|---|---|---|---|---|
| scalp | single target | 3% | sell all at +10% | 2h |
| runner | half / breakeven runner | 5% | half at +10%, rest at +20%, runner stop at entry | 6h |
| trail | existing ATR runner | 3% | half at +8%, rest trails by signal ATR14 | 6h |

Primary entry is the **open of the following five-minute bar after one full bar of delay** (detection+5m), without confirmation information from that intervening bar. Entry at detection's next-bar open is a sensitivity only. Require the exact entry bar, contiguous valid OHLCV through exit, and no fabricated gap filling. Truncate at the first missing/invalid bar; unfinished paths remain unresolved. No profits are assigned to missing paths. Require that a row is at least 6h older than its export cutoff, so ordinary right censoring is separated from lost coverage.

Headline cost is 200 bps round trip; 100 and 300 bps are sensitivities. These are modeled costs, not measured fills. Exit cashflow subtracts costs once. Frozen dollar-notional illustration: $50 per trade, $1,000 bankroll, max three concurrent positions, earliest first, and no compounding. At most one attempted entry per chain/token/UTC day for each candidate, chosen **before** inspecting its result. Unresolved positions retain their capital until the maximum hold; a −100% missing-path stress is reported separately.

## Selection and statistical checks

Development: chronological daily expanding folds with >=3 prior UTC days, a 6h pre-test gap, label exit strictly before test start, and support groups excluded across train/test where an anchor exists. At least 30 daily-deduplicated training observations are required for ML; at least 10 selected training trades across 3 days for a candidate. Inner daily folds generate training-only ML scores; fitting on its own labels cannot supply selection scores. Choose the highest training mean net return among the 12 candidates only when that mean is positive. Report every candidate including absent/negative candidates and report each outer-fold selection or abstention.

If available, fit and choose exactly one candidate on the full development period, freeze it, and evaluate October 3–7 without tuning, plus every prespecified candidate as labeled diagnostics. If no positive eligible development candidate exists, the selected strategy stays in cash; do not force a winner. Three unfiltered eligible-candle exit baselines and the published legacy signal result are comparators, not additional selectable candidates.

Report net expectancy, win rate, profit factor, total dollar P/L, maximum drawdown, trade/day counts, unresolved coverage, cost and delay sensitivity, same-period eligible-candle base rate, day-block expectancy/difference CIs, and mean return with the best winning trade removed. Fewer than 3 day blocks, fewer than 5 trades, or zero-width bootstrap => not estimable. Use 2,000 seeded day-block bootstrap draws. Use 200 within-day outcome permutations, refitting return models and repeating selection, and report a familywise maximum-statistic diagnostic for the 12 candidate development means. No new thresholds after outcomes are seen.

## Candidate and promotion policy

An eligible development candidate with positive mean net return at the primary delay/200bps can be named a **research candidate** even if its interval crosses zero. A frozen candidate that remains positive in the retrospective confirmation set and at 300bps, beats its same-period base-rate point estimate, and remains positive after removing its best winner is **worth prospective testing**, subject to sample/coverage limitations. Nothing in this study is called a validated BUY strategy.

Fresh prospective confirmation must use observations recorded after the preregistration push and a frozen candidate spec, with >=100 resolved trades across >=20 distinct UTC days, >=95% outcome coverage, positive lower 95% day-block bounds for expectancy and matched baseline difference, and validated executable costs/security. Failure to meet any condition means wait/reject, not automatic alert promotion. Preserve the current locked Phase 3 cohort independently.

Seed: 20261007. Cutoff for a fresh export: 2026-10-08T00:00:00Z. Freeze input hashes, export code version, candidate specification, and all result artifacts. If access fails, complete the development study on the hash-verified published snapshot and explicitly leave confirmation unavailable.
