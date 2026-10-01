# Offline ML research report

> **PRODUCTION SNAPSHOT**

## 1. Research question

Do point-in-time setup features predict TP1-first outcomes better than the hand-written rules, net of modeled costs? Model inferiority or statistical indistinguishability is a valid result.

## 2. Data

Rows: **9331**; resolved: **8045**; span: **2026-09-26 22:50:00+00:00 to 2026-10-01 15:40:00+00:00**. Ambiguous and unresolved rows are excluded from supervised fitting. Controls are eligible non-signal candles from the selected-pair universe, not random entries from the entire market. Signal/alert TP1-first rate: **47.7%**; control rate: **59.9%**.

### Sources

| index | rows |
| --- | --- |
| control | 9265 |
| signal | 62 |
| alert | 4 |

### Chains

| index | rows |
| --- | --- |
| solana | 3022 |
| ethereum | 2474 |
| bnb | 2001 |
| robinhood | 1834 |

### Feature audit

| index | mean | std | median | missing_pct |
| --- | --- | --- | --- | --- |
| volumeRatio | 1.355 | 8.005 | 0.809 | 0.000 |
| riskPct | 15.130 | 38.582 | 9.496 | 2.076 |
| atrPct | 5.954 | 6.703 | 4.742 | 0.000 |
| bodyPct | 0.512 | 0.307 | 0.510 | 0.000 |
| closePosition | 0.484 | 0.342 | 0.470 | 0.000 |
| upperWickPct | 0.244 | 0.246 | 0.179 | 0.000 |
| lowerWickPct | 0.240 | 0.235 | 0.184 | 0.000 |
| ema9SlopePct | 0.148 | 2.318 | -0.039 | 0.000 |
| ema21SlopePct | 0.131 | 1.432 | -0.020 | 0.000 |
| priceToEma9Pct | 0.395 | 8.588 | -0.154 | 0.000 |
| ema9ToEma21Pct | 0.437 | 5.124 | -0.085 | 0.000 |
| priceToSma50Pct | 3.301 | 23.804 | -0.312 | 0.000 |
| priorPeakDrawdownPct | -34.508 | 23.594 | -32.136 | 0.000 |
| supportTestCount | 5.660 | 6.116 | 3.000 | 0.000 |
| supportTouchAgeBars | 29.141 | 23.087 | 24.000 | 2.076 |

Repeated `(chain, token, support_anchor)` groups: **521** of **608**. Maximum rows in one group: **103**. All 15 features passed the code-level point-in-time review: they are calculated from closed candles at or before `detected_at` in `src/chart-pattern.ts`.

## 3. Validation design

The study uses expanding-window splits in detection-time order. A 24-hour pre-test gap is applied, the 24 hours after each prior test block remain embargoed when that history later becomes eligible for training, training observations whose label windows reach the current test period are purged, and support groups never cross a train/test boundary within a fold. Usable folds: **4**. At least three folds were available.

The deliberately naive shuffled comparison produced logistic Brier **0.182**, versus purged walk-forward Brier **0.260**. A lower shuffled score is evidence of optimistic leakage, not superior deployment performance.

## 4. Model results with 95% block-bootstrap intervals

### Pooled out-of-fold

| model | log_loss | brier | roc_auc | pr_auc | log_loss_ci_low | brier_ci_low | roc_auc_ci_low | pr_auc_ci_low | log_loss_ci_high | brier_ci_high | roc_auc_ci_high | pr_auc_ci_high |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.699 | 0.253 | 0.533 | 0.664 | 0.667 | 0.237 | 0.428 | 0.560 | 0.730 | 0.268 | 0.537 | 0.685 |
| logistic | 0.852 | 0.260 | 0.676 | 0.804 | 0.544 | 0.185 | 0.564 | 0.711 | 1.160 | 0.323 | 0.841 | 0.916 |
| hgb | 0.728 | 0.248 | 0.714 | 0.817 | 0.510 | 0.170 | 0.616 | 0.709 | 0.938 | 0.318 | 0.835 | 0.917 |
| logistic_platt | 0.817 | 0.259 | 0.660 | 0.799 | 0.574 | 0.196 | 0.571 | 0.712 | 1.057 | 0.320 | 0.744 | 0.883 |
| hgb_isotonic | 0.706 | 0.232 | 0.708 | 0.821 | 0.505 | 0.168 | 0.601 | 0.702 | 0.932 | 0.294 | 0.814 | 0.904 |

### Per fold

| fold | model | log_loss | brier | roc_auc | pr_auc |
| --- | --- | --- | --- | --- | --- |
| 0.000 | logistic | 1.195 | 0.330 | 0.589 | 0.760 |
| 0.000 | hgb | 0.977 | 0.331 | 0.618 | 0.748 |
| 1.000 | logistic | 1.025 | 0.312 | 0.537 | 0.620 |
| 1.000 | hgb | 0.826 | 0.287 | 0.636 | 0.680 |
| 2.000 | logistic | 0.598 | 0.203 | 0.738 | 0.868 |
| 2.000 | hgb | 0.539 | 0.182 | 0.796 | 0.893 |
| 3.000 | logistic | 0.563 | 0.194 | 0.819 | 0.896 |
| 3.000 | hgb | 0.545 | 0.185 | 0.783 | 0.872 |

### Logistic coefficients

| index | coefficient | ci_low | ci_high |
| --- | --- | --- | --- |
| volumeRatio | -0.068 | -0.547 | 0.087 |
| riskPct | 3.445 | 1.366 | 4.678 |
| atrPct | 0.104 | -0.101 | 0.446 |
| bodyPct | 0.082 | -0.280 | 0.566 |
| closePosition | 0.101 | -0.003 | 0.143 |
| upperWickPct | 0.335 | 0.101 | 0.742 |
| lowerWickPct | 0.065 | -0.195 | 0.467 |
| ema9SlopePct | -2.025 | -4.160 | 0.145 |
| ema21SlopePct | 0.077 | -1.511 | 0.922 |
| priceToEma9Pct | 2.091 | 0.112 | 3.825 |
| ema9ToEma21Pct | 0.148 | -0.239 | 0.665 |
| priceToSma50Pct | -0.463 | -0.918 | -0.072 |
| priorPeakDrawdownPct | 0.234 | 0.060 | 0.444 |
| supportTestCount | 0.216 | -0.368 | 0.494 |
| supportTouchAgeBars | 0.140 | -0.063 | 0.334 |

### Gradient-boosting validation-fold permutation importance

| index | validation_permutation_importance |
| --- | --- |
| riskPct | 0.057 |
| priorPeakDrawdownPct | 0.006 |
| supportTouchAgeBars | 0.004 |
| ema21SlopePct | 0.002 |
| volumeRatio | 0.001 |
| upperWickPct | 0.000 |
| bodyPct | 0.000 |
| ema9SlopePct | 0.000 |
| closePosition | 0.000 |
| lowerWickPct | 0.000 |
| priceToEma9Pct | 0.000 |
| priceToSma50Pct | -0.000 |
| ema9ToEma21Pct | -0.000 |
| atrPct | -0.005 |
| supportTestCount | -0.011 |

![Coefficient intervals](coefficients.png)

Gradient boosting is withheld when an outer training fold has fewer than 80 rows. Coefficient intervals resample trading days rather than individual rows.

## 5. Calibration

| model | brier | reliability | resolution | uncertainty | ece |
| --- | --- | --- | --- | --- | --- |
| logistic | 0.260 | 0.061 | 0.031 | 0.229 | 0.186 |
| logistic_platt | 0.259 | 0.056 | 0.026 | 0.229 | 0.159 |
| hgb | 0.248 | 0.050 | 0.030 | 0.229 | 0.194 |
| hgb_isotonic | 0.232 | 0.033 | 0.030 | 0.229 | 0.143 |

![Out-of-fold calibration](calibration.png)

Platt and isotonic calibration are fit inside each outer training fold. Isotonic calibration is withheld below 150 training rows. The probability bin nearest 70% averaged 65.6% predicted and 77.0% observed across 505 out-of-fold rows.

## 6. Strategy versus rules, net of costs

### 200 bps

| strategy | trades | win_rate | expectancy_pct | profit_factor | max_drawdown_usd | ending_balance_usd | expectancy_ci_low | expectancy_ci_high | win_rate_ci_low | win_rate_ci_high |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| take_everything | 29.000 | 0.586 | -1.454 | 0.559 | 35.088 | 978.912 | -2.462 | -0.649 | 0.400 | 0.667 |
| rule_immediate | 29.000 | 0.586 | -1.454 | 0.559 | 35.088 | 978.912 | -2.462 | -0.649 | 0.400 | 0.667 |
| rule_greenHold | 13.000 | 0.692 | -1.092 | 0.633 | 19.099 | 992.901 | -4.946 | 3.500 | 0.333 | 1.000 |
| rule_greenHoldVolume | 8.000 | 0.750 | -0.691 | 0.702 | 9.264 | 997.236 | -10.036 | 3.000 | 0.000 | 1.000 |
| model_filtered | 8.000 | 0.625 | -1.330 | 0.540 | 8.155 | 994.680 | -1.330 | -1.330 | 0.625 | 0.625 |
| rule_qualityUnique | 4.000 | 0.750 | 0.752 | 1.354 | 4.246 | 1001.504 | -8.492 | 3.833 | 0.000 | 1.000 |
| nested_leading_screen | 10.000 | 0.700 | -1.033 | 0.642 | 14.414 | 994.836 | -4.946 | 3.000 | 0.333 | 1.000 |

### Cost sensitivity

| strategy | 200_bps_expectancy | 300_bps_expectancy |
| --- | --- | --- |
| take_everything | -1.454 | -2.454 |
| rule_immediate | -1.454 | -2.454 |
| rule_greenHold | -1.092 | -2.092 |
| rule_greenHoldVolume | -0.691 | -1.691 |
| model_filtered | -1.330 | -2.330 |
| rule_qualityUnique | 0.752 | -0.248 |
| nested_leading_screen | -1.033 | -2.033 |

![Cumulative shadow P&L](cumulative_pnl.png)

Paired model-minus-best-rule expectancy: **-2.082%**, 95% CI **[-3.403, 7.162]**; best rule: **rule_qualityUnique**. If this interval includes zero, the model is not distinguishable from that rule. Thresholds and the leading confirmation screen are selected using training data only and applied to the next test fold. The current in-sample screen picker chose **screen_greenHold** with **-1.693%** expectancy; nested evaluation produced **-1.033%**, an optimism gap of **-0.660 percentage points**.

## 7. Power analysis

Average net win: **2.881%**; average net loss magnitude: **7.722%**. Breakeven win rate = `average loss / (average win + average loss)` = **72.8%**.

| index | true_win_rate | analytic_n | monte_carlo_n |
| --- | --- | --- | --- |
| 0.000 | 0.760 | 1185.000 | 1540.000 |
| 1.000 | 0.790 | 304.000 | 410.000 |
| 2.000 | 0.820 | 133.000 | 172.000 |
| 3.000 | 0.850 | 72.000 | 90.000 |
| 4.000 | 0.880 | 44.000 | 59.000 |
| 5.000 | 0.910 | 29.000 | 34.000 |
| 6.000 | 0.940 | 20.000 | 23.000 |

### Expectancy > 0

| index | true_edge_pct | required_n |
| --- | --- | --- |
| 0.000 | 0.250 | NA |
| 1.000 | 0.500 | 2000.000 |
| 2.000 | 1.000 | 486.000 |
| 3.000 | 2.000 | 136.000 |

![Power analysis](power.png)

Current `promotionReady` threshold: 50 resolved setups. Evidence-based provisional recommendation: **not estimable from the current sample** resolved setups, followed by a fresh locked forward cohort. This is a recommendation only; live code is unchanged.

## 8. Limitations

- The snapshot spans only **5 UTC trading days**. Thousands of correlated control rows do not substitute for independent market regimes.
- Strategy estimates use only **29 out-of-fold signal trades**; the best rule has **4 trades**, so its interval is especially unstable.
- Small samples produce wide intervals and unstable calibration.
- Discovery and watchlist selection create survivorship and selection bias; controls share that selected-pair universe.
- Crypto regimes change, so historical calibration can decay.
- Five-minute OHLC bars cannot order intrabar stop and target touches; the TypeScript simulator resolves ambiguity pessimistically.
- Fixed 200 and 300 bps scenarios cannot reproduce every FOMO quote, spread, network fee, or liquidity shock.
- Repeated tokens, supports, and days remain dependent even after grouped splits and block bootstrap.
- This is observational research and does not establish executable profitability.

## 9. Recommendations — not implemented in live behavior

1. Keep collecting a locked forward cohort until the power target is reached.
2. Prefer the simplest strategy whose out-of-sample expectancy interval excludes zero.
3. Treat a model as a challenger to the rules, never as proof of an edge.
4. Re-estimate costs from actual read-only execution quotes before any live decision.

## Reproduce

```sh
npm run research:export
python research/ml/run_all.py
```

For pipeline-only validation: `python research/ml/run_all.py --synthetic`.
