# Offline ML research report

> **PRODUCTION SNAPSHOT**

## 1. Research question

Do point-in-time setup features predict TP1-first outcomes better than the hand-written rules, net of modeled costs? Model inferiority or statistical indistinguishability is a valid result.

## 2. Data

Rows: **9331**; resolved: **8045**; span: **2026-09-26 22:50:00+00:00 to 2026-10-01 15:40:00+00:00**. Ambiguous and unresolved rows are excluded from supervised fitting. Controls are eligible non-signal candles from the selected-pair universe, not random entries from the entire market.

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

## 3. Signal versus control — headline comparison

Signal/alert TP1-first rate: **47.7%**. Control rate on eligible candles from the same selected pairs: **59.9%**. Signal-minus-control difference: **-12.2 percentage points**, 95% day-block bootstrap CI [-26.3, -1.4]. On this snapshot the signal selected **worse** entries than eligible same-pair control candles by TP1-first rate.

A simulated net-return comparison is **not available**: the committed snapshot runs the TypeScript shadow-trade simulator only for qualifying signal rows, so control rows have no entry/exit simulation. The TP1-first comparison above is the valid like-for-like control analysis.

## 4. Validation design

The study uses expanding-window splits in detection-time order. A 24-hour pre-test gap is applied, the 24 hours after each prior test block remain embargoed when that history later becomes eligible for training, training observations whose label windows reach the current test period are purged, and support groups never cross a train/test boundary within a fold. Usable folds: **4**. At least three folds were available.

The deliberately naive shuffled comparison produced logistic Brier **0.182**, versus purged walk-forward Brier **0.260**. The gap is **0.078** Brier points. A lower shuffled score is evidence of optimistic leakage, not superior deployment performance.

## 5. Original model results and baseline verdicts

### Pooled out-of-fold

| model | log_loss | log_loss_ci_95 | brier | brier_ci_95 | roc_auc | roc_auc_ci_95 | pr_auc | pr_auc_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.699 | [0.667, 0.730] | 0.253 | [0.237, 0.268] | 0.533 | [0.428, 0.537] | 0.664 | [0.560, 0.685] |
| logistic | 0.852 | [0.544, 1.160] | 0.260 | [0.185, 0.323] | 0.676 | [0.564, 0.841] | 0.804 | [0.711, 0.916] |
| hgb | 0.728 | [0.510, 0.938] | 0.248 | [0.170, 0.318] | 0.714 | [0.616, 0.835] | 0.817 | [0.709, 0.917] |
| logistic_platt | 0.817 | [0.574, 1.057] | 0.259 | [0.196, 0.320] | 0.660 | [0.571, 0.744] | 0.799 | [0.712, 0.883] |
| hgb_isotonic | 0.706 | [0.505, 0.932] | 0.232 | [0.168, 0.294] | 0.708 | [0.601, 0.814] | 0.821 | [0.702, 0.904] |

### Explicit baseline comparisons

- **Logistic regression does not beat the baseline on probability quality** (log-loss Δ 0.153, 95% CI [-0.124, 0.430]; Brier Δ 0.007, 95% CI [-0.052, 0.055]) and **beats the baseline on ranking** (AUC Δ 0.143, 95% CI [0.108, 0.378]).
- **Gradient boosting does not beat the baseline on probability quality** (log-loss Δ 0.029, 95% CI [-0.157, 0.208]; Brier Δ -0.005, 95% CI [-0.068, 0.050]) and **beats the baseline on ranking** (AUC Δ 0.181, 95% CI [0.158, 0.372]).
- **Platt-calibrated logistic regression does not beat the baseline on probability quality** (log-loss Δ 0.118, 95% CI [-0.093, 0.327]; Brier Δ 0.006, 95% CI [-0.041, 0.052]) and **beats the baseline on ranking** (AUC Δ 0.127, 95% CI [0.112, 0.281]).
- **Isotonic-calibrated gradient boosting does not beat the baseline on probability quality** (log-loss Δ 0.007, 95% CI [-0.162, 0.202]; Brier Δ -0.021, 95% CI [-0.069, 0.026]) and **beats the baseline on ranking** (AUC Δ 0.175, 95% CI [0.148, 0.350]).

Differences are model minus baseline. Lower log loss and Brier are better; higher AUC is better. A model is called better only when the paired 95% day-block interval is entirely favorable.

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

| index | coefficient | ci_95 |
| --- | --- | --- |
| volumeRatio | -0.068 | [-0.547, 0.087] |
| riskPct | 3.445 | [1.366, 4.678] |
| atrPct | 0.104 | [-0.101, 0.446] |
| bodyPct | 0.082 | [-0.280, 0.566] |
| closePosition | 0.101 | [-0.003, 0.143] |
| upperWickPct | 0.335 | [0.101, 0.742] |
| lowerWickPct | 0.065 | [-0.195, 0.467] |
| ema9SlopePct | -2.025 | [-4.160, 0.145] |
| ema21SlopePct | 0.077 | [-1.511, 0.922] |
| priceToEma9Pct | 2.091 | [0.112, 3.825] |
| ema9ToEma21Pct | 0.148 | [-0.239, 0.665] |
| priceToSma50Pct | -0.463 | [-0.918, -0.072] |
| priorPeakDrawdownPct | 0.234 | [0.060, 0.444] |
| supportTestCount | 0.216 | [-0.368, 0.494] |
| supportTouchAgeBars | 0.140 | [-0.063, 0.334] |

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

## 6. `riskPct` leakage-geometry checks

`riskPct` is the structural stop distance, while the original label asks whether a fixed +5% target is reached before that stop. A farther stop mechanically makes TP1-first easier, so predictive performance can partly reflect label geometry.

### Ablation: remove `riskPct` from both models

| model | metric | original | original_ci_95 | without_riskPct | without_riskPct_ci_95 | difference_without_minus_original | difference_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| logistic | roc_auc | 0.676 | [0.564, 0.841] | 0.657 | [0.552, 0.776] | -0.019 | [-0.065, -0.010] |
| logistic | brier | 0.260 | [0.185, 0.323] | 0.267 | [0.191, 0.336] | 0.007 | [0.002, 0.013] |
| logistic | log_loss | 0.852 | [0.544, 1.160] | 0.928 | [0.569, 1.332] | 0.076 | [0.011, 0.172] |
| hgb | roc_auc | 0.714 | [0.616, 0.835] | 0.656 | [0.565, 0.784] | -0.058 | [-0.059, -0.051] |
| hgb | brier | 0.248 | [0.170, 0.318] | 0.261 | [0.183, 0.323] | 0.013 | [0.005, 0.022] |
| hgb | log_loss | 0.728 | [0.510, 0.938] | 0.755 | [0.546, 0.927] | 0.027 | [-0.011, 0.058] |

The difference is no-risk minus original and is paired on the same out-of-fold rows and trading-day resamples. For AUC, negative means ranking deteriorated; for Brier and log loss, positive means probability quality deteriorated.

### R-multiple outcome

The alternative label uses the recorded first-barrier exit in risk units: TP1-first is `+5% / riskPct`, stop-first is `−1R`, and success means the recorded exit delivered at least `+1R`. Rows with missing or nonpositive risk are excluded. This is a risk-normalized label derivable from the committed snapshot; it is not a reconstruction of an unobserved intrabar +1R path. `riskPct` is excluded from both models. R-multiple rows: **7356**; usable folds: **4**.

| model | log_loss | log_loss_ci_95 | brier | brier_ci_95 | roc_auc | roc_auc_ci_95 | pr_auc | pr_auc_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.443 | [0.429, 0.458] | 0.123 | [0.122, 0.126] | 0.531 | [0.513, 0.576] | 0.146 | [0.144, 0.158] |
| logistic | 0.379 | [0.346, 0.401] | 0.113 | [0.110, 0.116] | 0.790 | [0.776, 0.869] | 0.351 | [0.263, 0.524] |
| hgb | 0.490 | [0.325, 0.577] | 0.118 | [0.103, 0.125] | 0.648 | [0.533, 0.871] | 0.286 | [0.154, 0.520] |
| logistic_platt | 0.383 | [0.348, 0.406] | 0.114 | [0.109, 0.118] | 0.753 | [0.736, 0.868] | 0.291 | [0.216, 0.476] |
| hgb_isotonic | 0.469 | [0.353, 0.517] | 0.120 | [0.114, 0.123] | 0.624 | [0.435, 0.781] | 0.201 | [0.124, 0.274] |

### How much original AUC survives?

| model | original_auc | without_riskPct_auc | without_riskPct_auc_retained_pct | r_multiple_auc | r_multiple_auc_retained_pct |
| --- | --- | --- | --- | --- | --- |
| logistic | 0.676 | 0.657 | 97.195 | 0.790 | 116.982 |
| hgb | 0.714 | 0.656 | 91.934 | 0.648 | 90.783 |

Removing `riskPct` retained **97.2%** of logistic AUC and **91.9%** of gradient-boosting AUC. On the R-multiple target, logistic retained **117.0%** and gradient boosting retained **90.8%** of their original AUCs. The R-multiple result changes both the target and eligible rows, so its retention is descriptive rather than a paired causal estimate.

## 7. Calibration

| model | brier | reliability | resolution | uncertainty | ece |
| --- | --- | --- | --- | --- | --- |
| logistic | 0.260 | 0.061 | 0.031 | 0.229 | 0.186 |
| logistic_platt | 0.259 | 0.056 | 0.026 | 0.229 | 0.159 |
| hgb | 0.248 | 0.050 | 0.030 | 0.229 | 0.194 |
| hgb_isotonic | 0.232 | 0.033 | 0.030 | 0.229 | 0.143 |

![Out-of-fold calibration](calibration.png)

Platt and isotonic calibration are fit inside each outer training fold. Isotonic calibration is withheld below 150 training rows. The probability bin nearest 70% averaged 65.6% predicted and 77.0% observed across 505 out-of-fold rows.

## 8. Strategy versus rules, net of costs

### 200 bps

| strategy | trades | win_rate | expectancy_pct | profit_factor | max_drawdown_usd | ending_balance_usd | day_blocks | expectancy_ci_95 | win_rate_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| take_everything | 29.000 | 0.586 | -1.454 | 0.559 | 35.088 | 978.912 | 3.000 | [-2.462, -0.649] | [0.400, 0.667] |
| rule_immediate | 29.000 | 0.586 | -1.454 | 0.559 | 35.088 | 978.912 | 3.000 | [-2.462, -0.649] | [0.400, 0.667] |
| rule_greenHold | 13.000 | 0.692 | -1.092 | 0.633 | 19.099 | 992.901 | 3.000 | [-4.946, 3.500] | [0.333, 1.000] |
| rule_greenHoldVolume | 8.000 | 0.750 | -0.691 | 0.702 | 9.264 | 997.236 | 3.000 | [-10.036, 3.000] | [0.000, 1.000] |
| model_filtered | 8.000 | 0.625 | -1.330 | 0.540 | 8.155 | 994.680 | 1.000 | not estimable (1 blocks) | not estimable (1 blocks) |
| rule_qualityUnique | 4.000 | 0.750 | 0.752 | 1.354 | 4.246 | 1001.504 | 2.000 | not estimable (2 blocks) | not estimable (2 blocks) |
| nested_leading_screen | 10.000 | 0.700 | -1.033 | 0.642 | 14.414 | 994.836 | 3.000 | [-4.946, 3.000] | [0.333, 1.000] |

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

Paired model-minus-best-rule expectancy: **-2.082%**, 95% CI **not estimable (1 blocks)**; best rule: **rule_qualityUnique**. If this interval includes zero, the model is not distinguishable from that rule. Thresholds and the leading confirmation screen are selected using training data only and applied to the next test fold. The current in-sample screen picker chose **screen_greenHold** with **-1.693%** expectancy; nested evaluation produced **-1.033%**, an optimism gap of **-0.660 percentage points**.

## 9. Payoff-structure sensitivity

The empirical simulator produced a TP2 completion share of **47.6%** among TP1-resolved wins. The analytic table below applies the simulator's exit shape: half sold at TP1, the runner either exits at breakeven or at TP2=2×TP1, a loss reaches the stated maximum structural-risk cap, and one round-trip cost is deducted. These are **hypothetical exit-rule scenarios, not backtested results**.

| index | tp1_pct | max_risk_pct | cost_bps | average_net_win_pct | net_loss_pct | breakeven_win_rate |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 5.0 | 3.0 | 100.0 | 3.9 | -4.0 | 50.8 |
| 1.0 | 5.0 | 3.0 | 200.0 | 2.9 | -5.0 | 63.4 |
| 2.0 | 5.0 | 3.0 | 300.0 | 1.9 | -6.0 | 76.1 |
| 3.0 | 5.0 | 5.0 | 100.0 | 3.9 | -6.0 | 60.7 |
| 4.0 | 5.0 | 5.0 | 200.0 | 2.9 | -7.0 | 70.8 |
| 5.0 | 5.0 | 5.0 | 300.0 | 1.9 | -8.0 | 81.0 |
| 6.0 | 5.0 | 8.0 | 100.0 | 3.9 | -9.0 | 69.9 |
| 7.0 | 5.0 | 8.0 | 200.0 | 2.9 | -10.0 | 77.6 |
| 8.0 | 5.0 | 8.0 | 300.0 | 1.9 | -11.0 | 85.4 |
| 9.0 | 8.0 | 3.0 | 100.0 | 6.8 | -4.0 | 37.0 |
| 10.0 | 8.0 | 3.0 | 200.0 | 5.8 | -5.0 | 46.3 |
| 11.0 | 8.0 | 3.0 | 300.0 | 4.8 | -6.0 | 55.5 |
| 12.0 | 8.0 | 5.0 | 100.0 | 6.8 | -6.0 | 46.8 |
| 13.0 | 8.0 | 5.0 | 200.0 | 5.8 | -7.0 | 54.6 |
| 14.0 | 8.0 | 5.0 | 300.0 | 4.8 | -8.0 | 62.5 |
| 15.0 | 8.0 | 8.0 | 100.0 | 6.8 | -9.0 | 56.9 |
| 16.0 | 8.0 | 8.0 | 200.0 | 5.8 | -10.0 | 63.3 |
| 17.0 | 8.0 | 8.0 | 300.0 | 4.8 | -11.0 | 69.6 |
| 18.0 | 10.0 | 3.0 | 100.0 | 8.8 | -4.0 | 31.3 |
| 19.0 | 10.0 | 3.0 | 200.0 | 7.8 | -5.0 | 39.2 |
| 20.0 | 10.0 | 3.0 | 300.0 | 6.8 | -6.0 | 47.0 |
| 21.0 | 10.0 | 5.0 | 100.0 | 8.8 | -6.0 | 40.6 |
| 22.0 | 10.0 | 5.0 | 200.0 | 7.8 | -7.0 | 47.4 |
| 23.0 | 10.0 | 5.0 | 300.0 | 6.8 | -8.0 | 54.2 |
| 24.0 | 10.0 | 8.0 | 100.0 | 8.8 | -9.0 | 50.7 |
| 25.0 | 10.0 | 8.0 | 200.0 | 7.8 | -10.0 | 56.3 |
| 26.0 | 10.0 | 8.0 | 300.0 | 6.8 | -11.0 | 61.9 |
| 27.0 | 15.0 | 3.0 | 100.0 | 13.6 | -4.0 | 22.7 |
| 28.0 | 15.0 | 3.0 | 200.0 | 12.6 | -5.0 | 28.3 |
| 29.0 | 15.0 | 3.0 | 300.0 | 11.6 | -6.0 | 34.0 |
| 30.0 | 15.0 | 5.0 | 100.0 | 13.6 | -6.0 | 30.5 |
| 31.0 | 15.0 | 5.0 | 200.0 | 12.6 | -7.0 | 35.6 |
| 32.0 | 15.0 | 5.0 | 300.0 | 11.6 | -8.0 | 40.7 |
| 33.0 | 15.0 | 8.0 | 100.0 | 13.6 | -9.0 | 39.7 |
| 34.0 | 15.0 | 8.0 | 200.0 | 12.6 | -10.0 | 44.2 |
| 35.0 | 15.0 | 8.0 | 300.0 | 11.6 | -11.0 | 48.6 |

### Which payoff lever moves breakeven most?

| index | lever | mean_breakeven_swing_pp |
| --- | --- | --- |
| 0.0 | TP1 target (5%→15%) | 34.6 |
| 1.0 | maximum risk (3%→8%) | 16.0 |
| 2.0 | cost (100→300 bps) | 14.9 |

The swing averages the within-scenario maximum-minus-minimum change while holding the other two dimensions fixed. On this grid, **TP1 target (5%→15%)** moves the mechanical breakeven rate most. This does not account for the lower hit rate likely caused by a farther target.

### Empirical sensitivity available from existing resolved trades

Only the current +5% TP1/+10% TP2 path can be evaluated empirically from the committed snapshot. The +8%, +10%, and +15% targets require candle-path re-simulation and therefore remain analytic scenarios above.

| index | tp1_pct | max_risk_pct | cost_bps | trades | observed_win_rate | expectancy_pct | average_net_win_pct | average_net_loss_pct | breakeven_win_rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 5.0 | 3.0 | 100.0 | 0.0 | NA | NA | NA | NA | NA |
| 1.0 | 5.0 | 3.0 | 200.0 | 0.0 | NA | NA | NA | NA | NA |
| 2.0 | 5.0 | 3.0 | 300.0 | 0.0 | NA | NA | NA | NA | NA |
| 3.0 | 5.0 | 5.0 | 100.0 | 23.0 | 39.1 | -3.8 | 3.9 | 8.8 | 69.3 |
| 4.0 | 5.0 | 5.0 | 200.0 | 23.0 | 26.1 | -4.8 | 4.7 | 8.2 | 63.7 |
| 5.0 | 5.0 | 5.0 | 300.0 | 23.0 | 21.7 | -5.8 | 4.5 | 8.7 | 65.9 |
| 6.0 | 5.0 | 8.0 | 100.0 | 63.0 | 39.7 | -3.2 | 3.3 | 7.5 | 69.2 |
| 7.0 | 5.0 | 8.0 | 200.0 | 63.0 | 33.3 | -4.2 | 2.9 | 7.7 | 72.8 |
| 8.0 | 5.0 | 8.0 | 300.0 | 63.0 | 15.9 | -5.2 | 4.5 | 7.0 | 60.9 |

Across the hypothetical grid, increasing TP1 lowers breakeven, tighter maximum stop risk lowers it, and each additional 100 bps of cost raises it. This table isolates payoff mechanics and does not show how often a farther target would actually be reached.

## 10. Power analysis

Average net win: **2.881%**; average net loss magnitude: **7.722%**. Breakeven win rate = `average loss / (average win + average loss)` = **72.8%**, versus an observed **33.3%** positive-return rate across the 63 available immediate simulations.

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

## 11. Limitations

- The snapshot spans only **5 UTC trading days**. Thousands of correlated control rows do not substitute for independent market regimes.
- Training data is mostly controls (**9,265 of 9,331 rows**) while strategy decisions are evaluated on signals. That is a material distribution shift.
- Strategy estimates use only **29 out-of-fold signal trades**; the best rule has **4 trades**, so its interval may be not estimable.
- Small samples produce wide intervals and unstable calibration.
- Discovery and watchlist selection create survivorship and selection bias; controls share that selected-pair universe.
- Crypto regimes change, so historical calibration can decay.
- Five-minute OHLC bars cannot order intrabar stop and target touches; the TypeScript simulator resolves ambiguity pessimistically.
- Fixed cost scenarios cannot reproduce every FOMO quote, spread, network fee, or liquidity shock.
- Repeated tokens, supports, and days remain dependent even after grouped splits and block bootstrap.
- This is observational research and does not establish executable profitability.

## 12. Recommendations — not implemented in live behavior

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
