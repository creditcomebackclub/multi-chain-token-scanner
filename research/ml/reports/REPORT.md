# Offline ML research report

> **PRODUCTION SNAPSHOT**

## 1. Research question

Do point-in-time setup features predict TP1-first outcomes better than the hand-written rules, net of modeled costs? Model inferiority or statistical indistinguishability is a valid result.

## 2. Data

Rows: **10095**; resolved: **8801**; span: **2026-09-26 22:50:00+00:00 to 2026-10-02 01:25:00+00:00**. Ambiguous and unresolved rows are excluded from supervised fitting. Controls are eligible non-signal candles from the selected-pair universe, not random entries from the entire market.

### Sources

| index | rows |
| --- | --- |
| control | 10031 |
| signal | 60 |
| alert | 4 |

### Chains

| index | rows |
| --- | --- |
| solana | 3295 |
| ethereum | 2680 |
| bnb | 2134 |
| robinhood | 1986 |

### Feature audit

| index | mean | std | median | missing_pct |
| --- | --- | --- | --- | --- |
| volumeRatio | 1.335 | 7.680 | 0.809 | 0.000 |
| riskPct | 16.295 | 38.191 | 9.700 | 2.295 |
| atrPct | 6.142 | 6.689 | 4.852 | 0.000 |
| bodyPct | 0.514 | 0.306 | 0.512 | 0.000 |
| closePosition | 0.482 | 0.342 | 0.465 | 0.000 |
| upperWickPct | 0.244 | 0.244 | 0.181 | 0.000 |
| lowerWickPct | 0.238 | 0.233 | 0.183 | 0.000 |
| ema9SlopePct | 0.169 | 2.407 | -0.039 | 0.000 |
| ema21SlopePct | 0.165 | 1.515 | -0.018 | 0.000 |
| priceToEma9Pct | 0.464 | 8.849 | -0.154 | 0.000 |
| ema9ToEma21Pct | 0.653 | 5.590 | -0.061 | 0.000 |
| priceToSma50Pct | 4.612 | 26.984 | -0.246 | 0.000 |
| priorPeakDrawdownPct | -33.901 | 23.511 | -30.664 | 0.000 |
| supportTestCount | 5.552 | 6.073 | 3.000 | 0.000 |
| supportTouchAgeBars | 29.261 | 23.143 | 24.000 | 2.295 |

Repeated `(chain, token, support_anchor)` groups: **567** of **643**. Maximum rows in one group: **103**. All 15 features passed the code-level point-in-time review: they are calculated from closed candles at or before `detected_at` in `src/chart-pattern.ts`.

## 3. Signal versus control — headline comparison

Signal/alert TP1-first rate: **46.5%**. Control rate on eligible candles from the same selected pairs: **60.5%**. Signal-minus-control difference: **-14.0 percentage points**, 95% day-block bootstrap CI [-30.5, -3.1]. On this snapshot the signal selected **worse** entries than eligible same-pair control candles by TP1-first rate.

Controls averaged **-3.179%** versus **-3.380%** for signals; signal-minus-control difference **-0.201 percentage points**, 95% CI [-1.678, 0.943].

## 4. Validation design

The study uses expanding-window splits in detection-time order. A 24-hour pre-test gap is applied, the 24 hours after each prior test block remain embargoed when that history later becomes eligible for training, training observations whose label windows reach the current test period are purged, and support groups never cross a train/test boundary within a fold. Usable folds: **4**. At least three folds were available.

The deliberately naive shuffled comparison produced logistic Brier **0.178**, versus purged walk-forward Brier **0.252**. The gap is **0.074** Brier points. A lower shuffled score is evidence of optimistic leakage, not superior deployment performance.

## 5. Original model results and baseline verdicts

### Pooled out-of-fold

| model | log_loss | log_loss_ci_95 | brier | brier_ci_95 | roc_auc | roc_auc_ci_95 | pr_auc | pr_auc_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.699 | [0.669, 0.733] | 0.253 | [0.238, 0.270] | 0.518 | [0.436, 0.527] | 0.654 | [0.578, 0.669] |
| logistic | 0.835 | [0.563, 1.202] | 0.252 | [0.189, 0.322] | 0.682 | [0.570, 0.779] | 0.819 | [0.722, 0.884] |
| hgb | 0.704 | [0.515, 0.936] | 0.238 | [0.173, 0.313] | 0.727 | [0.632, 0.814] | 0.835 | [0.727, 0.898] |
| logistic_platt | 0.794 | [0.566, 1.079] | 0.253 | [0.195, 0.322] | 0.666 | [0.572, 0.743] | 0.810 | [0.716, 0.872] |
| hgb_isotonic | 0.767 | [0.500, 1.173] | 0.226 | [0.163, 0.306] | 0.726 | [0.605, 0.817] | 0.830 | [0.701, 0.896] |

### Explicit baseline comparisons

- **Logistic regression does not beat the baseline on probability quality** (log-loss Δ 0.137, 95% CI [-0.107, 0.469]; Brier Δ -0.000, 95% CI [-0.050, 0.053]) and **beats the baseline on ranking** (AUC Δ 0.164, 95% CI [0.101, 0.342]).
- **Gradient boosting does not beat the baseline on probability quality** (log-loss Δ 0.005, 95% CI [-0.154, 0.203]; Brier Δ -0.014, 95% CI [-0.065, 0.043]) and **beats the baseline on ranking** (AUC Δ 0.208, 95% CI [0.157, 0.376]).
- **Platt-calibrated logistic regression does not beat the baseline on probability quality** (log-loss Δ 0.095, 95% CI [-0.104, 0.346]; Brier Δ 0.000, 95% CI [-0.044, 0.053]) and **beats the baseline on ranking** (AUC Δ 0.148, 95% CI [0.102, 0.307]).
- **Isotonic-calibrated gradient boosting does not beat the baseline on probability quality** (log-loss Δ 0.069, 95% CI [-0.169, 0.439]; Brier Δ -0.027, 95% CI [-0.075, 0.037]) and **beats the baseline on ranking** (AUC Δ 0.208, 95% CI [0.140, 0.379]).

Differences are model minus baseline. Lower log loss and Brier are better; higher AUC is better. A model is called better only when the paired 95% day-block interval is entirely favorable.

### Per fold

| fold | model | log_loss | brier | roc_auc | pr_auc |
| --- | --- | --- | --- | --- | --- |
| 0.000 | logistic | 1.230 | 0.333 | 0.569 | 0.734 |
| 0.000 | hgb | 0.963 | 0.322 | 0.623 | 0.736 |
| 1.000 | logistic | 0.897 | 0.278 | 0.650 | 0.800 |
| 1.000 | hgb | 0.753 | 0.263 | 0.716 | 0.825 |
| 2.000 | logistic | 0.605 | 0.209 | 0.716 | 0.851 |
| 2.000 | hgb | 0.583 | 0.199 | 0.764 | 0.881 |
| 3.000 | logistic | 0.510 | 0.165 | 0.832 | 0.900 |
| 3.000 | hgb | 0.436 | 0.142 | 0.861 | 0.906 |

### Logistic coefficients

| index | coefficient | ci_95 |
| --- | --- | --- |
| volumeRatio | -0.122 | [-0.687, 0.063] |
| riskPct | 3.190 | [1.451, 4.652] |
| atrPct | 0.115 | [-0.096, 0.455] |
| bodyPct | 0.066 | [-0.223, 0.284] |
| closePosition | 0.091 | [0.001, 0.148] |
| upperWickPct | 0.316 | [0.128, 0.475] |
| lowerWickPct | 0.054 | [-0.150, 0.277] |
| ema9SlopePct | -0.850 | [-1.640, 0.185] |
| ema21SlopePct | 0.451 | [-1.635, 0.780] |
| priceToEma9Pct | 0.681 | [-0.182, 1.636] |
| ema9ToEma21Pct | -0.211 | [-0.464, 0.680] |
| priceToSma50Pct | 0.026 | [-0.995, 0.362] |
| priorPeakDrawdownPct | 0.200 | [0.010, 0.459] |
| supportTestCount | 0.240 | [-0.220, 0.549] |
| supportTouchAgeBars | 0.137 | [-0.065, 0.319] |

### Gradient-boosting validation-fold permutation importance

| index | validation_permutation_importance |
| --- | --- |
| riskPct | 0.071 |
| priorPeakDrawdownPct | 0.004 |
| supportTouchAgeBars | 0.003 |
| ema21SlopePct | 0.001 |
| volumeRatio | 0.001 |
| upperWickPct | 0.000 |
| ema9SlopePct | 0.000 |
| ema9ToEma21Pct | 0.000 |
| bodyPct | 0.000 |
| closePosition | 0.000 |
| lowerWickPct | 0.000 |
| priceToEma9Pct | 0.000 |
| priceToSma50Pct | -0.001 |
| supportTestCount | -0.007 |
| atrPct | -0.007 |

![Coefficient intervals](coefficients.png)

## 6. `riskPct` leakage-geometry checks

`riskPct` is the structural stop distance, while the original label asks whether a fixed +5% target is reached before that stop. A farther stop mechanically makes TP1-first easier, so predictive performance can partly reflect label geometry.

### Ablation: remove `riskPct` from both models

| model | metric | original | original_ci_95 | without_riskPct | without_riskPct_ci_95 | difference_without_minus_original | difference_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| logistic | roc_auc | 0.682 | [0.570, 0.779] | 0.659 | [0.546, 0.745] | -0.023 | [-0.034, -0.013] |
| logistic | brier | 0.252 | [0.189, 0.322] | 0.263 | [0.196, 0.345] | 0.011 | [0.004, 0.023] |
| logistic | log_loss | 0.835 | [0.563, 1.202] | 0.912 | [0.573, 1.411] | 0.076 | [0.010, 0.209] |
| hgb | roc_auc | 0.727 | [0.632, 0.814] | 0.666 | [0.609, 0.740] | -0.061 | [-0.076, -0.023] |
| hgb | brier | 0.238 | [0.173, 0.313] | 0.255 | [0.198, 0.311] | 0.016 | [-0.002, 0.025] |
| hgb | log_loss | 0.704 | [0.515, 0.936] | 0.736 | [0.579, 0.898] | 0.032 | [-0.039, 0.069] |

The difference is no-risk minus original and is paired on the same out-of-fold rows and trading-day resamples. For AUC, negative means ranking deteriorated; for Brier and log loss, positive means probability quality deteriorated.

### R-multiple outcome

The alternative label uses the recorded first-barrier exit in risk units: TP1-first is `+5% / riskPct`, stop-first is `−1R`, and success means the recorded exit delivered at least `+1R`. Rows with missing or nonpositive risk are excluded. This is a risk-normalized label derivable from the committed snapshot; it is not a reconstruction of an unobserved intrabar +1R path. `riskPct` is excluded from both models. R-multiple rows: **8030**; usable folds: **4**.

| model | log_loss | log_loss_ci_95 | brier | brier_ci_95 | roc_auc | roc_auc_ci_95 | pr_auc | pr_auc_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 0.445 | [0.411, 0.483] | 0.122 | [0.115, 0.127] | 0.468 | [0.350, 0.525] | 0.124 | [0.110, 0.140] |
| logistic | 0.371 | [0.308, 0.428] | 0.110 | [0.096, 0.119] | 0.785 | [0.735, 0.851] | 0.347 | [0.254, 0.516] |
| hgb | 0.509 | [0.379, 0.616] | 0.122 | [0.111, 0.129] | 0.628 | [0.559, 0.742] | 0.216 | [0.150, 0.264] |
| logistic_platt | 0.391 | [0.340, 0.443] | 0.115 | [0.103, 0.124] | 0.720 | [0.697, 0.798] | 0.255 | [0.203, 0.387] |
| hgb_isotonic | 0.739 | [0.380, 1.338] | 0.123 | [0.113, 0.130] | 0.570 | [0.488, 0.680] | 0.163 | [0.129, 0.202] |

### How much original AUC survives?

| model | original_auc | without_riskPct_auc | without_riskPct_auc_retained_pct | r_multiple_auc | r_multiple_auc_retained_pct |
| --- | --- | --- | --- | --- | --- |
| logistic | 0.682 | 0.659 | 96.569 | 0.785 | 115.122 |
| hgb | 0.727 | 0.666 | 91.645 | 0.628 | 86.365 |

Removing `riskPct` retained **96.6%** of logistic AUC and **91.6%** of gradient-boosting AUC. On the R-multiple target, logistic retained **115.1%** and gradient boosting retained **86.4%** of their original AUCs. The R-multiple result changes both the target and eligible rows, so its retention is descriptive rather than a paired causal estimate.

## 7. Calibration

| model | brier | reliability | resolution | uncertainty | ece |
| --- | --- | --- | --- | --- | --- |
| logistic | 0.252 | 0.055 | 0.031 | 0.228 | 0.167 |
| logistic_platt | 0.253 | 0.051 | 0.028 | 0.228 | 0.145 |
| hgb | 0.238 | 0.047 | 0.037 | 0.228 | 0.178 |
| hgb_isotonic | 0.226 | 0.032 | 0.032 | 0.228 | 0.144 |

![Out-of-fold calibration](calibration.png)

Platt and isotonic calibration are fit inside each outer training fold. Isotonic calibration is withheld below 150 training rows. The probability bin nearest 70% averaged 68.9% predicted and 84.6% observed across 572 out-of-fold rows.

## 8. Strategy versus rules, net of costs

### 200 bps

| strategy | trades | win_rate | expectancy_pct | profit_factor | max_drawdown_usd | ending_balance_usd | day_blocks | expectancy_ci_95 | win_rate_ci_95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| take_everything | 30.000 | 0.533 | -2.177 | 0.424 | 43.904 | 967.346 | 4.000 | [-4.694, -0.896] | [0.250, 0.667] |
| rule_immediate | 30.000 | 0.533 | -2.177 | 0.424 | 43.904 | 967.346 | 4.000 | [-4.694, -0.896] | [0.250, 0.667] |
| rule_greenHold | 15.000 | 0.600 | -2.079 | 0.440 | 24.844 | 984.406 | 4.000 | [-6.365, 1.782] | [0.200, 0.900] |
| rule_greenHoldVolume | 10.000 | 0.600 | -2.252 | 0.366 | 17.759 | 988.741 | 4.000 | [-9.008, 1.901] | [0.000, 0.923] |
| model_filtered | 0.000 | NA | NA | NA | 0.000 | 1000.000 | 0.000 | not estimable (0 blocks) | not estimable (0 blocks) |
| rule_qualityUnique | 5.000 | 0.600 | -0.686 | 0.770 | 7.464 | 998.286 | 3.000 | [-8.492, 3.833] | [0.000, 1.000] |
| nested_leading_screen | 13.000 | 0.538 | -2.861 | 0.332 | 25.094 | 981.406 | 4.000 | [-7.003, 1.165] | [0.200, 0.875] |

### Cost sensitivity

| strategy | 200_bps_expectancy | 300_bps_expectancy |
| --- | --- | --- |
| take_everything | -2.177 | -3.177 |
| rule_immediate | -2.177 | -3.177 |
| rule_greenHold | -2.079 | -3.079 |
| rule_greenHoldVolume | -2.252 | -3.252 |
| model_filtered | NA | NA |
| rule_qualityUnique | -0.686 | -1.686 |
| nested_leading_screen | -2.861 | -3.861 |

![Cumulative shadow P&L](cumulative_pnl.png)

Paired model-minus-best-rule expectancy: **NA%**, 95% CI **not estimable (0 blocks)**; best rule: **rule_qualityUnique**. If this interval includes zero, the model is not distinguishable from that rule. Thresholds and the leading confirmation screen are selected using training data only and applied to the next test fold. The current in-sample screen picker chose **screen_greenHold** with **-2.409%** expectancy; nested evaluation produced **-2.861%**, an optimism gap of **0.452 percentage points**.

## 9. Payoff-structure sensitivity

The empirical simulator produced a TP2 completion share of **45.0%** among TP1-resolved wins. The analytic table below applies the simulator's exit shape: half sold at TP1, the runner either exits at breakeven or at TP2=2×TP1, a loss reaches the stated maximum structural-risk cap, and one round-trip cost is deducted. These are **hypothetical exit-rule scenarios, not backtested results**.

| index | tp1_pct | max_risk_pct | cost_bps | average_net_win_pct | net_loss_pct | breakeven_win_rate |
| --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 5.0 | 3.0 | 100.0 | 3.8 | -4.0 | 51.6 |
| 1.0 | 5.0 | 3.0 | 200.0 | 2.8 | -5.0 | 64.5 |
| 2.0 | 5.0 | 3.0 | 300.0 | 1.8 | -6.0 | 77.4 |
| 3.0 | 5.0 | 5.0 | 100.0 | 3.8 | -6.0 | 61.5 |
| 4.0 | 5.0 | 5.0 | 200.0 | 2.8 | -7.0 | 71.8 |
| 5.0 | 5.0 | 5.0 | 300.0 | 1.8 | -8.0 | 82.1 |
| 6.0 | 5.0 | 8.0 | 100.0 | 3.8 | -9.0 | 70.6 |
| 7.0 | 5.0 | 8.0 | 200.0 | 2.8 | -10.0 | 78.4 |
| 8.0 | 5.0 | 8.0 | 300.0 | 1.8 | -11.0 | 86.3 |
| 9.0 | 8.0 | 3.0 | 100.0 | 6.6 | -4.0 | 37.7 |
| 10.0 | 8.0 | 3.0 | 200.0 | 5.6 | -5.0 | 47.2 |
| 11.0 | 8.0 | 3.0 | 300.0 | 4.6 | -6.0 | 56.6 |
| 12.0 | 8.0 | 5.0 | 100.0 | 6.6 | -6.0 | 47.6 |
| 13.0 | 8.0 | 5.0 | 200.0 | 5.6 | -7.0 | 55.6 |
| 14.0 | 8.0 | 5.0 | 300.0 | 4.6 | -8.0 | 63.5 |
| 15.0 | 8.0 | 8.0 | 100.0 | 6.6 | -9.0 | 57.7 |
| 16.0 | 8.0 | 8.0 | 200.0 | 5.6 | -10.0 | 64.1 |
| 17.0 | 8.0 | 8.0 | 300.0 | 4.6 | -11.0 | 70.5 |
| 18.0 | 10.0 | 3.0 | 100.0 | 8.5 | -4.0 | 32.0 |
| 19.0 | 10.0 | 3.0 | 200.0 | 7.5 | -5.0 | 40.0 |
| 20.0 | 10.0 | 3.0 | 300.0 | 6.5 | -6.0 | 48.0 |
| 21.0 | 10.0 | 5.0 | 100.0 | 8.5 | -6.0 | 41.4 |
| 22.0 | 10.0 | 5.0 | 200.0 | 7.5 | -7.0 | 48.3 |
| 23.0 | 10.0 | 5.0 | 300.0 | 6.5 | -8.0 | 55.2 |
| 24.0 | 10.0 | 8.0 | 100.0 | 8.5 | -9.0 | 51.4 |
| 25.0 | 10.0 | 8.0 | 200.0 | 7.5 | -10.0 | 57.1 |
| 26.0 | 10.0 | 8.0 | 300.0 | 6.5 | -11.0 | 62.9 |
| 27.0 | 15.0 | 3.0 | 100.0 | 13.2 | -4.0 | 23.2 |
| 28.0 | 15.0 | 3.0 | 200.0 | 12.2 | -5.0 | 29.0 |
| 29.0 | 15.0 | 3.0 | 300.0 | 11.2 | -6.0 | 34.8 |
| 30.0 | 15.0 | 5.0 | 100.0 | 13.2 | -6.0 | 31.2 |
| 31.0 | 15.0 | 5.0 | 200.0 | 12.2 | -7.0 | 36.4 |
| 32.0 | 15.0 | 5.0 | 300.0 | 11.2 | -8.0 | 41.6 |
| 33.0 | 15.0 | 8.0 | 100.0 | 13.2 | -9.0 | 40.4 |
| 34.0 | 15.0 | 8.0 | 200.0 | 12.2 | -10.0 | 44.9 |
| 35.0 | 15.0 | 8.0 | 300.0 | 11.2 | -11.0 | 49.4 |

### Which payoff lever moves breakeven most?

| index | lever | mean_breakeven_swing_pp |
| --- | --- | --- |
| 0.0 | TP1 target (5%→15%) | 34.8 |
| 1.0 | maximum risk (3%→8%) | 16.0 |
| 2.0 | cost (100→300 bps) | 15.1 |

The swing averages the within-scenario maximum-minus-minimum change while holding the other two dimensions fixed. On this grid, **TP1 target (5%→15%)** moves the mechanical breakeven rate most. This does not account for the lower hit rate likely caused by a farther target.

### Empirical sensitivity under the original exit

| index | tp1_pct | max_risk_pct | cost_bps | trades | observed_win_rate | expectancy_pct | average_net_win_pct | average_net_loss_pct | breakeven_win_rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.0 | 5.0 | 3.0 | 100.0 | 1501.0 | 26.0 | -1.1 | 3.3 | 2.6 | 44.7 |
| 1.0 | 5.0 | 3.0 | 200.0 | 1501.0 | 25.4 | -2.1 | 2.3 | 3.6 | 60.7 |
| 2.0 | 5.0 | 3.0 | 300.0 | 1501.0 | 11.9 | -3.1 | 3.5 | 4.0 | 53.5 |
| 3.0 | 5.0 | 5.0 | 100.0 | 2670.0 | 36.0 | -0.9 | 3.2 | 3.3 | 50.5 |
| 4.0 | 5.0 | 5.0 | 200.0 | 2670.0 | 34.2 | -1.9 | 2.4 | 4.2 | 63.9 |
| 5.0 | 5.0 | 5.0 | 300.0 | 2670.0 | 14.5 | -2.9 | 3.9 | 4.1 | 51.4 |
| 6.0 | 5.0 | 8.0 | 100.0 | 4011.0 | 40.8 | -1.2 | 3.4 | 4.3 | 56.3 |
| 7.0 | 5.0 | 8.0 | 200.0 | 4011.0 | 39.3 | -2.2 | 2.5 | 5.2 | 67.7 |
| 8.0 | 5.0 | 8.0 | 300.0 | 4011.0 | 17.1 | -3.2 | 4.1 | 4.7 | 53.5 |

The complete path-based test of all target, stop, time, structure, and cost combinations follows in Exit re-simulation. Across the hypothetical grid, increasing TP1 lowers breakeven, tighter maximum stop risk lowers it, and each additional 100 bps of cost raises it.

## 10. Exit re-simulation

No tested exit rule established positive out-of-sample expectancy: the nested signal estimate did not have a 95% interval entirely above zero.

The grid contains **432** cells across three exit structures, four targets, four stops, three time exits, and three cost assumptions. Every entry is the open of the next five-minute bar; stops win same-bar target conflicts. The in-sample best signal cell was `trailing|tp8|atr1_5|6h|100bps` at **-0.725%** mean net return. Nested purged walk-forward selection produced **0.012 ([-4.000, 0.996])%** on **13** signal trades, for an in-sample-minus-OOS optimism gap of **-0.737 percentage points**.

### Fold-selected rules

| fold | rule_id | train_trades | train_expectancy_pct |
| --- | --- | --- | --- |
| 2.000 | trailing|tp8|fixed3|24h|100bps | 19.000 | 1.254 |
| 3.000 | trailing|tp8|fixed3|24h|100bps | 24.000 | 0.121 |

### Entry populations under the fold-selected exit

| population | trades | expectancy_pct_ci_95 | win_rate_pct_ci_95 |
| --- | --- | --- | --- |
| signals | 13.000 | 0.012 ([-4.000, 0.996]) | 30.8 ([0.0, 40.0]) |
| controls | 2665.000 | -0.842 ([-1.086, -0.728]) | 27.8 ([25.3, 29.0]) |
| logistic_top_decile | 272.000 | -2.163 (not estimable (2 blocks)) | 15.4 (not estimable (2 blocks)) |
| hgb_top_decile | 275.000 | -1.771 (not estimable (2 blocks)) | 21.1 (not estimable (2 blocks)) |
| pruned_logistic_top_decile | 272.000 | -2.387 (not estimable (2 blocks)) | 14.7 (not estimable (2 blocks)) |
| pruned_hgb_top_decile | 285.000 | -2.017 (not estimable (2 blocks)) | 20.0 (not estimable (2 blocks)) |

The top-decile models rank controls with out-of-fold scores and exclude `riskPct`. The correlation-pruned version also excludes the three features most correlated with `riskPct` in the first outer training fold: **priceToSma50Pct, ema21SlopePct, ema9ToEma21Pct**.

### Signal-minus-population differences on overlapping test days

| comparison | expectancy_difference_pct_ci_95 | win_rate_difference_pp_ci_95 |
| --- | --- | --- |
| signals minus controls | 0.854 ([-2.914, 2.055]) | 3.5 ([-26.3, 14.7]) |
| signals minus logistic_top_decile | 2.174 (not estimable (2 blocks)) | 15.3 (not estimable (2 blocks)) |
| signals minus hgb_top_decile | 1.783 (not estimable (2 blocks)) | 9.7 (not estimable (2 blocks)) |
| signals minus pruned_logistic_top_decile | 2.399 (not estimable (2 blocks)) | 16.1 (not estimable (2 blocks)) |
| signals minus pruned_hgb_top_decile | 2.029 (not estimable (2 blocks)) | 10.8 (not estimable (2 blocks)) |

### Multiple-testing check

Positive in-sample signal cells: **0 of 432**. Within-day return shuffles produced an average **4.0%** positive cells. Across **500** seeded permutations, **100.0%** produced at least as many positive cells as observed and **88.8%** produced a best cell at least as profitable as the observed in-sample best.

### Market regime

**Skipped.** The committed path export contains watched token-pair candles only; it has no SOL, ETH, or BNB major-asset candle series. No external data was fetched.

The database retains `chart_candles` for only **35 days**. Extending that retention is recommended before a longer locked study, but this PR does not change retention or live storage behavior.

## 11. Power analysis

Average net win: **2.750%**; average net loss magnitude: **6.166%**. Breakeven win rate = `average loss / (average win + average loss)` = **69.2%**, versus an observed **31.2%** positive-return rate across the 64 available immediate simulations.

| index | true_win_rate | analytic_n | monte_carlo_n |
| --- | --- | --- | --- |
| 0.000 | 0.730 | 870.000 | 1131.000 |
| 1.000 | 0.760 | 268.000 | 348.000 |
| 2.000 | 0.790 | 126.000 | 157.000 |
| 3.000 | 0.820 | 72.000 | 90.000 |
| 4.000 | 0.850 | 45.000 | 54.000 |
| 5.000 | 0.880 | 31.000 | 38.000 |
| 6.000 | 0.910 | 21.000 | 25.000 |
| 7.000 | 0.940 | 15.000 | 20.000 |

### Expectancy > 0

| index | true_edge_pct | required_n |
| --- | --- | --- |
| 0.000 | 0.250 | NA |
| 1.000 | 0.500 | 743.000 |
| 2.000 | 1.000 | 180.000 |
| 3.000 | 2.000 | 44.000 |

![Power analysis](power.png)

Current `promotionReady` threshold: 50 resolved setups. Evidence-based provisional recommendation: **not estimable from the current sample** resolved setups, followed by a fresh locked forward cohort. This is a recommendation only; live code is unchanged.

## 12. Limitations

- The snapshot spans only **6 UTC trading days**. Thousands of correlated control rows do not substitute for independent market regimes.
- The source database retains candle paths for 35 days; older observations cannot be re-simulated once their paths expire.
- Training data is mostly controls (**10,031 of 10,095 rows**) while strategy decisions are evaluated on signals. That is a material distribution shift.
- Strategy estimates use only **30 out-of-fold signal trades**; the best rule has **5 trades**, so its interval may be not estimable.
- Small samples produce wide intervals and unstable calibration.
- Discovery and watchlist selection create survivorship and selection bias; controls share that selected-pair universe.
- Crypto regimes change, so historical calibration can decay.
- Five-minute OHLC bars cannot order intrabar stop and target touches; the TypeScript simulator resolves ambiguity pessimistically.
- Fixed cost scenarios cannot reproduce every FOMO quote, spread, network fee, or liquidity shock.
- Repeated tokens, supports, and days remain dependent even after grouped splits and block bootstrap.
- This is observational research and does not establish executable profitability.

## 13. Recommendations — not implemented in live behavior

1. **Promote nothing.** No exit-rule and entry-population combination established positive out-of-sample expectancy.
2. If one challenger is collected next, shadow `trailing | TP1 +8% | fixed 3% stop | 24h time exit` on current signals with realized costs. Both eligible training folds independently selected that path rule, but its pooled OOS estimate is not evidence of an edge.
3. Require at least **180 locked out-of-sample trades** to study a +1 percentage-point edge at the current variance; a +0.5-point edge needs about **743**. Also require at least 20 independent trading days and 30 training signals per fold.
4. Extend candle retention beyond 35 days before the next long locked cohort so all entries retain full forward paths.
5. Re-estimate costs from actual read-only execution quotes before any live decision.

## Reproduce

```sh
npm run research:fetch-data
python research/ml/run_all.py
```

`research:fetch-data` downloads the production candle paths and precomputed exit grid from the `research-snapshot-2026-10-02` GitHub Release and verifies their decompressed hashes. The exit grid is derived from the committed snapshot, the candle paths, and the TypeScript path simulator, so it can be regenerated instead of downloaded. To export a fresh database snapshot, run `npm run research:export` first.

For pipeline-only validation: `python research/ml/run_all.py --synthetic`.
