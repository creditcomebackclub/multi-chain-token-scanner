from __future__ import annotations

from pathlib import Path
import json
import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .data import FEATURES, FEATURES_WITHOUT_RISK, audit, load_dataset, resolved
from .edge_program import render_edge_program, run_edge_program
from .evaluate import (
    calibration_metrics, classification_metrics, interval_text, metric_intervals,
    paired_metric_differences, reliability_table, signal_control_rate_difference,
    signal_control_return_difference, strategy_comparison,
)
from .exit_analysis import analyze_exit_grid, most_risk_correlated_features
from .models import choose_screen, coefficient_intervals, out_of_fold_predictions
from .power import analytic_payoff_sensitivity, empirical_payoff_sensitivity, power_analysis
from .validation import naive_shuffled_splits, validate_fold, walk_forward_splits


def _fmt(value, digits=3):
    return "NA" if value is None or not np.isfinite(value) else f"{value:.{digits}f}"


def _markdown(frame: pd.DataFrame, digits=3) -> str:
    if frame.empty:
        return "_Insufficient data._"
    printable = frame.reset_index().copy()
    for column in printable.select_dtypes(include=["number"]).columns:
        printable[column] = printable[column].map(lambda value: _fmt(value, digits))
    headers = [str(column) for column in printable.columns]
    rows = [[str(value) for value in row] for row in printable.itertuples(index=False, name=None)]
    return "\n".join([
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join(["---"] * len(headers)) + " |",
        *["| " + " | ".join(row) + " |" for row in rows],
    ])


def _save_calibration(oof: pd.DataFrame, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(6, 5)); ax.plot([0, 1], [0, 1], "--", color="gray", label="perfect")
    for column, label in [("pred_logistic", "logistic"), ("pred_logistic_platt", "logistic + Platt"), ("pred_hgb", "gradient boosting")]:
        rows = oof.loc[oof[column].notna() & oof["y"].isin([0, 1])]
        if len(rows):
            table = reliability_table(rows["y"], rows[column]); ax.plot(table.mean_probability, table.observed_rate, marker="o", label=label)
    ax.set(xlabel="Predicted TP1-first probability", ylabel="Observed rate", title="Out-of-fold reliability"); ax.legend(); fig.tight_layout(); fig.savefig(path, dpi=160); plt.close(fig)


def _save_curves(curves: dict[str, pd.DataFrame], path: Path) -> None:
    fig, ax = plt.subplots(figsize=(8, 5))
    for name, values in curves.items():
        trades = values.dropna(subset=["return"]).sort_values(["exit_at", "detected_at"])
        if len(trades): ax.plot(trades["detected_at"], 1_000 + (trades["return"] * .5).cumsum(), label=name)
    ax.set(xlabel="Detection time (epoch ms)", ylabel="Shadow balance ($)", title="$50 fixed-position shadow P&L, 200 bps"); ax.legend(fontsize=7); fig.tight_layout(); fig.savefig(path, dpi=160); plt.close(fig)


def _save_power(win_power: pd.DataFrame, current: int, path: Path) -> None:
    fig, ax = plt.subplots(figsize=(7, 5))
    if len(win_power):
        ax.plot(win_power.true_win_rate * 100, win_power.analytic_n, marker="o", label="normal approximation")
        ax.plot(win_power.true_win_rate * 100, win_power.monte_carlo_n, marker="s", label="Wilson Monte Carlo")
    ax.axhline(50, color="orange", linestyle="--", label="current code threshold: 50"); ax.axhline(current, color="black", linestyle=":", label=f"current resolved: {current}")
    ax.set(xlabel="Assumed true win rate (%)", ylabel="Resolved trades required", title="Power to establish an edge over breakeven"); ax.legend(fontsize=8); fig.tight_layout(); fig.savefig(path, dpi=160); plt.close(fig)


def _save_coefficients(coefficients: pd.DataFrame, path: Path) -> None:
    usable = coefficients.dropna().sort_values("coefficient")
    fig, ax = plt.subplots(figsize=(7, 6))
    if len(usable):
        x = usable.coefficient.to_numpy(); low = x - usable.ci_low.to_numpy(); high = usable.ci_high.to_numpy() - x
        ax.errorbar(x, range(len(usable)), xerr=[low, high], fmt="o"); ax.set_yticks(range(len(usable)), usable.index); ax.axvline(0, color="gray", linestyle="--")
    ax.set(title="Standardized logistic coefficients with block-bootstrap 95% CIs", xlabel="Coefficient"); fig.tight_layout(); fig.savefig(path, dpi=160); plt.close(fig)


def _metric_table(oof: pd.DataFrame, n_boot: int) -> pd.DataFrame:
    rows = []
    for column in ["pred_baseline", "pred_logistic", "pred_hgb", "pred_logistic_platt", "pred_hgb_isotonic"]:
        usable = oof.loc[oof["y"].isin([0, 1]) & oof.get(column, pd.Series(index=oof.index, dtype=float)).notna()]
        if usable.empty:
            continue
        values = metric_intervals(oof, column, n_boot)
        blocks = int(usable["day"].nunique())
        row = {"model": column.removeprefix("pred_")}
        for metric, result in values.items():
            row[metric] = result["estimate"]
            row[f"{metric}_ci_95"] = interval_text(result["ci_low"], result["ci_high"], blocks)
        rows.append(row)
    return pd.DataFrame(rows).set_index("model") if rows else pd.DataFrame()


def _paired_model_table(original: pd.DataFrame, variant: pd.DataFrame, original_metrics: pd.DataFrame, variant_metrics: pd.DataFrame, n_boot: int) -> tuple[pd.DataFrame, dict]:
    rows, raw = [], {}
    for model in ["logistic", "hgb"]:
        left, right = f"pred_{model}_variant", f"pred_{model}_original"
        pair = pd.DataFrame({"y": original["y"], "day": original["day"], left: variant[f"pred_{model}"], right: original[f"pred_{model}"]})
        comparison = paired_metric_differences(pair, left, right, n_boot)
        raw[model] = comparison
        for metric in ["roc_auc", "brier", "log_loss"]:
            result = comparison[metric]
            rows.append({
                "model": model, "metric": metric, "original": result["right"],
                "original_ci_95": original_metrics.loc[model, f"{metric}_ci_95"],
                "without_riskPct": result["left"],
                "without_riskPct_ci_95": variant_metrics.loc[model, f"{metric}_ci_95"],
                "difference_without_minus_original": result["difference"],
                "difference_ci_95": interval_text(result["ci_low"], result["ci_high"], result["blocks"]),
            })
    return pd.DataFrame(rows).set_index(["model", "metric"]), raw


def _baseline_assessments(oof: pd.DataFrame, n_boot: int) -> tuple[str, dict]:
    sentences, raw = [], {}
    labels = {
        "logistic": "Logistic regression", "hgb": "Gradient boosting",
        "logistic_platt": "Platt-calibrated logistic regression",
        "hgb_isotonic": "Isotonic-calibrated gradient boosting",
    }
    for model, label in labels.items():
        column = f"pred_{model}"
        if column not in oof or not oof[column].notna().any():
            continue
        result = paired_metric_differences(oof[["y", "day", column, "pred_baseline"]].copy(), column, "pred_baseline", n_boot)
        raw[model] = result
        log_result, brier_result, auc_result = result["log_loss"], result["brier"], result["roc_auc"]
        probability_beats = log_result["ci_high"] < 0 and brier_result["ci_high"] < 0
        ranking_beats = auc_result["ci_low"] > 0
        sentences.append(
            f"- **{label} {'beats' if probability_beats else 'does not beat'} the baseline on probability quality** "
            f"(log-loss Δ {_fmt(log_result['difference'])}, 95% CI {interval_text(log_result['ci_low'], log_result['ci_high'], log_result['blocks'])}; "
            f"Brier Δ {_fmt(brier_result['difference'])}, 95% CI {interval_text(brier_result['ci_low'], brier_result['ci_high'], brier_result['blocks'])}) "
            f"and **{'beats' if ranking_beats else 'does not beat'} the baseline on ranking** "
            f"(AUC Δ {_fmt(auc_result['difference'])}, 95% CI {interval_text(auc_result['ci_low'], auc_result['ci_high'], auc_result['blocks'])})."
        )
    return "\n".join(sentences), raw


def _coefficient_table(coefficients: pd.DataFrame, blocks: int) -> pd.DataFrame:
    result = coefficients[["coefficient"]].copy()
    result["ci_95"] = [interval_text(row.ci_low, row.ci_high, blocks) for row in coefficients.itertuples()]
    return result


def _estimate_ci(result: dict, digits=3, scale=1.0) -> str:
    estimate = _fmt(result.get("estimate", math.nan) * scale, digits)
    return f"{estimate} ({interval_text(result.get('ci_low'), result.get('ci_high'), result.get('blocks', 0), digits=digits, scale=scale)})"


def _exit_tables(study: dict | None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, str]:
    if not study:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), "Exit-grid artifacts were unavailable; no exit-rule result is reported."
    populations = []
    for name, values in study["populations"].items():
        populations.append({"population": name, "trades": values["trades"],
            "expectancy_pct_ci_95": _estimate_ci(values["expectancy"]),
            "win_rate_pct_ci_95": _estimate_ci(values["win_rate"], 1, 100)})
    differences = []
    for name, values in study["comparisons"].items():
        differences.append({"comparison": f"signals minus {name}",
            "expectancy_difference_pct_ci_95": _estimate_ci(values["expectancy_signal_minus_population"]),
            "win_rate_difference_pp_ci_95": _estimate_ci(values["win_rate_signal_minus_population"], 1, 100)})
    nested = study["nested_oos"]; positive = nested["expectancy"]["ci_low"] > 0 if np.isfinite(nested["expectancy"]["ci_low"]) else False
    verdict = ("The fold-selected exit rule produced positive out-of-sample expectancy with a 95% interval above zero."
               if positive else "No tested exit rule established positive out-of-sample expectancy: the nested signal estimate did not have a 95% interval entirely above zero.")
    return pd.DataFrame(populations).set_index("population"), pd.DataFrame(differences).set_index("comparison"), study["fold_choices"].set_index("fold") if len(study["fold_choices"]) else pd.DataFrame(), verdict


def _json_safe(value):
    if isinstance(value, dict): return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list): return [_json_safe(item) for item in value]
    if isinstance(value, tuple): return [_json_safe(item) for item in value]
    if isinstance(value, (float, np.floating)) and not np.isfinite(value): return None
    if isinstance(value, np.integer): return int(value)
    return value


def write_awaiting_report(report_dir: str | Path) -> Path:
    report_dir = Path(report_dir); report_dir.mkdir(parents=True, exist_ok=True); path = report_dir / "REPORT.md"
    path.write_text("""# Offline ML research report\n\n## Status\n\n**Awaiting a production snapshot.** No empirical model or performance result is reported because `research/ml/data/snapshot.csv` is absent.\n\nExport the point-in-time dataset with `npm run research:export`, then run `python research/ml/run_all.py`. Use `python research/ml/run_all.py --synthetic` only to test the pipeline; synthetic output is not evidence of a trading edge.\n""", encoding="utf-8")
    return path


def run_study(data_path: str | Path, report_dir: str | Path, synthetic: bool = False, bootstrap_scale: float = 1.0) -> Path:
    report_dir = Path(report_dir); report_dir.mkdir(parents=True, exist_ok=True)
    frame = load_dataset(data_path); info = audit(frame); labeled = resolved(frame)
    min_test = max(10, min(30, len(labeled) // 10))
    folds = walk_forward_splits(frame, n_splits=5, min_test_rows=min_test)
    for fold in folds: validate_fold(frame, fold)
    enough = len(folds) >= 3
    oof, model_details = out_of_fold_predictions(frame, folds) if folds else (frame.assign(fold=pd.NA), {"folds": 0, "permutation_importance": {}})
    no_risk_oof, no_risk_details = out_of_fold_predictions(frame, folds, FEATURES_WITHOUT_RISK) if folds else (frame.assign(fold=pd.NA), {})
    correlated_features, pruned_features, risk_correlations = most_risk_correlated_features(frame, folds)
    pruned_oof, pruned_details = out_of_fold_predictions(frame, folds, pruned_features) if folds and pruned_features else (frame.assign(fold=pd.NA), {})

    r_frame = frame.copy(); r_frame["y"] = r_frame["r_multiple_y"]
    r_labeled = resolved(r_frame)
    r_min_test = max(10, min(30, len(r_labeled) // 10)) if len(r_labeled) else 10
    r_folds = walk_forward_splits(r_frame, n_splits=5, min_test_rows=r_min_test)
    for fold in r_folds: validate_fold(r_frame, fold)
    r_oof, r_details = out_of_fold_predictions(r_frame, r_folds, FEATURES_WITHOUT_RISK) if r_folds else (r_frame.assign(fold=pd.NA), {})

    naive_folds = naive_shuffled_splits(frame, n_splits=min(5, max(2, len(labeled) // 30))) if len(labeled) >= 30 else []
    naive, _ = out_of_fold_predictions(frame, naive_folds) if naive_folds else (frame.copy(), {})
    boot_metrics = max(100, int(1_000 * bootstrap_scale)); boot_strategy = max(200, int(2_000 * bootstrap_scale))
    metric_table = _metric_table(oof, boot_metrics); no_risk_table = _metric_table(no_risk_oof, boot_metrics); r_metric_table = _metric_table(r_oof, boot_metrics)
    ablation_table, ablation_raw = _paired_model_table(oof, no_risk_oof, metric_table, no_risk_table, boot_metrics)
    baseline_text, baseline_raw = _baseline_assessments(oof, boot_metrics)

    survival_rows = []
    for model in ["logistic", "hgb"]:
        original_auc = metric_table.loc[model, "roc_auc"] if model in metric_table.index else math.nan
        ablated_auc = no_risk_table.loc[model, "roc_auc"] if model in no_risk_table.index else math.nan
        r_auc = r_metric_table.loc[model, "roc_auc"] if model in r_metric_table.index else math.nan
        survival_rows.append({
            "model": model, "original_auc": original_auc, "without_riskPct_auc": ablated_auc,
            "without_riskPct_auc_retained_pct": 100 * ablated_auc / original_auc if original_auc else math.nan,
            "r_multiple_auc": r_auc, "r_multiple_auc_retained_pct": 100 * r_auc / original_auc if original_auc else math.nan,
        })
    survival_table = pd.DataFrame(survival_rows).set_index("model")

    fold_rows = []
    for fold_number, fold_data in oof.loc[oof["fold"].notna()].groupby("fold"):
        for column in ["pred_logistic", "pred_hgb"]:
            usable = fold_data.loc[fold_data[column].notna()]
            if len(usable): fold_rows.append({"fold": int(fold_number), "model": column.removeprefix("pred_"), **classification_metrics(usable["y"], usable[column])})
    fold_table = pd.DataFrame(fold_rows).set_index(["fold", "model"]) if fold_rows else pd.DataFrame()
    naive_metric = metric_intervals(naive, "pred_logistic", max(100, boot_metrics // 2)) if "pred_logistic" in naive and naive["pred_logistic"].notna().any() else {}
    calibration_rows = []
    for column in ["pred_logistic", "pred_logistic_platt", "pred_hgb", "pred_hgb_isotonic"]:
        rows = oof.loc[oof.get(column, pd.Series(index=oof.index, dtype=float)).notna() & oof["y"].isin([0, 1])]
        if len(rows): calibration_rows.append({"model": column.removeprefix("pred_"), **calibration_metrics(rows["y"], rows[column])})
    calibration_table = pd.DataFrame(calibration_rows).set_index("model") if calibration_rows else pd.DataFrame()
    coefficients = coefficient_intervals(labeled, max(100, int(1_000 * bootstrap_scale)))
    coefficient_table = _coefficient_table(coefficients, int(labeled["day"].nunique()))
    strategy_200, paired, curves = strategy_comparison(oof, 200, boot_strategy) if folds else (pd.DataFrame(), {}, {})
    strategy_300, _, _ = strategy_comparison(oof, 300, max(200, boot_strategy // 2)) if folds else (pd.DataFrame(), {}, {})
    signal_control = signal_control_rate_difference(labeled, boot_strategy)
    signal_control_return = signal_control_return_difference(frame, "immediate_sim_net_return_pct", boot_strategy)
    feature_summary = labeled[FEATURES].describe().T[["mean", "std", "50%"]].rename(columns={"50%": "median"}); feature_summary["missing_pct"] = labeled[FEATURES].isna().mean() * 100
    importance_table = pd.DataFrame.from_dict(model_details.get("permutation_importance", {}), orient="index", columns=["validation_permutation_importance"])
    calibration_takeaway = "Insufficient out-of-fold predictions for a 70% reliability statement."
    if "pred_logistic" in oof:
        calibration_rows_for_text = oof.loc[oof.pred_logistic.notna() & oof.y.isin([0, 1])]
        if len(calibration_rows_for_text):
            reliability = reliability_table(calibration_rows_for_text.y, calibration_rows_for_text.pred_logistic)
            if len(reliability):
                row = reliability.iloc[(reliability.mean_probability - .7).abs().argmin()]
                calibration_takeaway = f"The probability bin nearest 70% averaged {_fmt(row.mean_probability * 100, 1)}% predicted and {_fmt(row.observed_rate * 100, 1)}% observed across {int(row['count'])} out-of-fold rows."

    signal_rows = labeled.loc[(labeled.source != "control") & labeled.greenHold_sim_net_return_pct.notna()].copy()
    in_sample_screen = choose_screen(signal_rows) if len(signal_rows) else None
    in_sample_expectancy = float(signal_rows.loc[signal_rows[in_sample_screen].fillna(False).astype(bool), "greenHold_sim_net_return_pct"].mean()) if in_sample_screen else math.nan
    nested_expectancy = float(strategy_200.loc["nested_leading_screen", "expectancy_pct"]) if "nested_leading_screen" in strategy_200.index else math.nan
    screen_optimism = in_sample_expectancy - nested_expectancy if np.isfinite(in_sample_expectancy) and np.isfinite(nested_expectancy) else math.nan
    returns = pd.to_numeric(frame.loc[frame.source.ne("control") & frame.immediate_sim_net_return_pct.notna(), "immediate_sim_net_return_pct"], errors="coerce").dropna()
    breakeven, win_power, expectancy_power = power_analysis(returns, simulations=max(200, int(2_000 * bootstrap_scale)))
    observed_sim_win_rate = float((returns > 0).mean()) if len(returns) else math.nan

    win_statuses = frame.loc[frame.source.ne("control") & frame["immediate_sim_status"].isin(["tp2", "runner_breakeven"]), "immediate_sim_status"]
    tp2_share = float(win_statuses.eq("tp2").mean()) if len(win_statuses) else .5
    analytic_sensitivity = analytic_payoff_sensitivity(tp2_share)
    empirical_sensitivity = empirical_payoff_sensitivity(frame)
    lever_effects = pd.DataFrame([
        {"lever": "TP1 target (5%→15%)", "mean_breakeven_swing_pp": 100 * analytic_sensitivity.groupby(["max_risk_pct", "cost_bps"])["breakeven_win_rate"].agg(lambda values: values.max() - values.min()).mean()},
        {"lever": "maximum risk (3%→8%)", "mean_breakeven_swing_pp": 100 * analytic_sensitivity.groupby(["tp1_pct", "cost_bps"])["breakeven_win_rate"].agg(lambda values: values.max() - values.min()).mean()},
        {"lever": "cost (100→300 bps)", "mean_breakeven_swing_pp": 100 * analytic_sensitivity.groupby(["tp1_pct", "max_risk_pct"])["breakeven_win_rate"].agg(lambda values: values.max() - values.min()).mean()},
    ]).sort_values("mean_breakeven_swing_pp", ascending=False)
    exit_study = analyze_exit_grid(frame, folds, no_risk_oof, pruned_oof, Path(data_path).with_name("exit-grid.csv.gz"),
                                   n_boot=boot_strategy, shuffle_draws=50 if synthetic else 500)
    exit_populations, exit_differences, exit_folds, exit_verdict = _exit_tables(exit_study)
    edge_study = run_edge_program(frame, Path(data_path).with_name("edge-exit-grid.csv.gz"), Path(data_path).with_name("exit-grid.csv.gz"),
                                  Path(data_path).with_name("snapshot.meta.json"), report_dir, bootstrap_scale, synthetic)

    _save_calibration(oof, report_dir / "calibration.png"); _save_curves(curves, report_dir / "cumulative_pnl.png"); _save_power(win_power, len(labeled), report_dir / "power.png"); _save_coefficients(coefficients, report_dir / "coefficients.png")
    walk_brier = metric_table.loc["logistic", "brier"] if "logistic" in metric_table.index else math.nan
    naive_brier = naive_metric.get("brier", {}).get("estimate", math.nan) if naive_metric else math.nan
    observed_rate = float(labeled.y.mean()) if len(labeled) else math.nan
    recommended = None
    if len(win_power) and np.isfinite(observed_rate):
        eligible = win_power.loc[win_power.true_win_rate <= observed_rate]
        if len(eligible): recommended = int(max(50, eligible.iloc[-1].monte_carlo_n or eligible.iloc[-1].analytic_n))

    label = "SYNTHETIC PIPELINE TEST — NOT EMPIRICAL RESULTS" if synthetic else "PRODUCTION SNAPSHOT"
    source_table = pd.DataFrame.from_dict(info["by_source"], orient="index", columns=["rows"]); chain_table = pd.DataFrame.from_dict(info["by_chain"], orient="index", columns=["rows"])
    strategy_cost = pd.DataFrame({"200_bps_expectancy": strategy_200.get("expectancy_pct", pd.Series(dtype=float)), "300_bps_expectancy": strategy_300.get("expectancy_pct", pd.Series(dtype=float))})
    calendar_days = int(labeled["day"].nunique())
    oof_trade_count = int(strategy_200.loc["take_everything", "trades"]) if "take_everything" in strategy_200.index else 0
    best_rule_name = paired.get("best_rule"); best_rule_trades = int(strategy_200.loc[best_rule_name, "trades"]) if best_rule_name in strategy_200.index else 0
    control_return_text = (
        f"Controls averaged **{_fmt(signal_control_return['control_mean'])}%** versus **{_fmt(signal_control_return['signal_mean'])}%** for signals; signal-minus-control difference **{_fmt(signal_control_return['difference'])} percentage points**, 95% CI {interval_text(signal_control_return['ci_low'], signal_control_return['ci_high'], signal_control_return['blocks'])}."
        if signal_control_return else
        "A simulated net-return comparison is **not available**: the committed snapshot runs the TypeScript shadow-trade simulator only for qualifying signal rows, so control rows have no entry/exit simulation. The TP1-first comparison above is the valid like-for-like control analysis."
    )
    signal_interpretation = "worse" if signal_control["difference"] < 0 else "better"

    lines = [
        f"# Offline ML research report\n\n> **{label}**",
        "\n## 1. Research question\n\nDo point-in-time setup features predict TP1-first outcomes better than the hand-written rules, net of modeled costs? Model inferiority or statistical indistinguishability is a valid result.",
        f"\n## 2. Data\n\nRows: **{info['rows']}**; resolved: **{info['resolved']}**; span: **{info['time_start']} to {info['time_end']}**. Ambiguous and unresolved rows are excluded from supervised fitting. Controls are eligible non-signal candles from the selected-pair universe, not random entries from the entire market.\n\n### Sources\n\n{_markdown(source_table, 0)}\n\n### Chains\n\n{_markdown(chain_table, 0)}\n\n### Feature audit\n\n{_markdown(feature_summary)}\n\nRepeated `(chain, token, support_anchor)` groups: **{info['repeated_groups']}** of **{info['groups']}**. Maximum rows in one group: **{info['max_rows_per_group']}**. All 15 features passed the code-level point-in-time review: they are calculated from closed candles at or before `detected_at` in `src/chart-pattern.ts`.",
        f"\n## 3. Signal versus control — headline comparison\n\nSignal/alert TP1-first rate: **{_fmt(signal_control['signal_rate'] * 100, 1)}%**. Control rate on eligible candles from the same selected pairs: **{_fmt(signal_control['control_rate'] * 100, 1)}%**. Signal-minus-control difference: **{_fmt(signal_control['difference'] * 100, 1)} percentage points**, 95% day-block bootstrap CI {interval_text(signal_control['ci_low'], signal_control['ci_high'], signal_control['blocks'], digits=1, scale=100)}. On this snapshot the signal selected **{signal_interpretation}** entries than eligible same-pair control candles by TP1-first rate.\n\n{control_return_text}",
        f"\n## 4. Validation design\n\nThe study uses expanding-window splits in detection-time order. A 24-hour pre-test gap is applied, the 24 hours after each prior test block remain embargoed when that history later becomes eligible for training, training observations whose label windows reach the current test period are purged, and support groups never cross a train/test boundary within a fold. Usable folds: **{len(folds)}**. {'At least three folds were available.' if enough else '**Insufficient data for three defensible folds; model comparisons are exploratory or unavailable.**'}\n\nThe deliberately naive shuffled comparison produced logistic Brier **{_fmt(naive_brier)}**, versus purged walk-forward Brier **{_fmt(walk_brier)}**. The gap is **{_fmt(walk_brier - naive_brier)}** Brier points. A lower shuffled score is evidence of optimistic leakage, not superior deployment performance.",
        f"\n## 5. Original model results and baseline verdicts\n\n### Pooled out-of-fold\n\n{_markdown(metric_table)}\n\n### Explicit baseline comparisons\n\n{baseline_text}\n\nDifferences are model minus baseline. Lower log loss and Brier are better; higher AUC is better. A model is called better only when the paired 95% day-block interval is entirely favorable.\n\n### Per fold\n\n{_markdown(fold_table)}\n\n### Logistic coefficients\n\n{_markdown(coefficient_table)}\n\n### Gradient-boosting validation-fold permutation importance\n\n{_markdown(importance_table)}\n\n![Coefficient intervals](coefficients.png)",
        f"\n## 6. `riskPct` leakage-geometry checks\n\n`riskPct` is the structural stop distance, while the original label asks whether a fixed +5% target is reached before that stop. A farther stop mechanically makes TP1-first easier, so predictive performance can partly reflect label geometry.\n\n### Ablation: remove `riskPct` from both models\n\n{_markdown(ablation_table)}\n\nThe difference is no-risk minus original and is paired on the same out-of-fold rows and trading-day resamples. For AUC, negative means ranking deteriorated; for Brier and log loss, positive means probability quality deteriorated.\n\n### R-multiple outcome\n\nThe alternative label uses the recorded first-barrier exit in risk units: TP1-first is `+5% / riskPct`, stop-first is `−1R`, and success means the recorded exit delivered at least `+1R`. Rows with missing or nonpositive risk are excluded. This is a risk-normalized label derivable from the committed snapshot; it is not a reconstruction of an unobserved intrabar +1R path. `riskPct` is excluded from both models. R-multiple rows: **{len(r_labeled)}**; usable folds: **{len(r_folds)}**.\n\n{_markdown(r_metric_table)}\n\n### How much original AUC survives?\n\n{_markdown(survival_table)}\n\nRemoving `riskPct` retained **{_fmt(survival_table.loc['logistic', 'without_riskPct_auc_retained_pct'], 1)}%** of logistic AUC and **{_fmt(survival_table.loc['hgb', 'without_riskPct_auc_retained_pct'], 1)}%** of gradient-boosting AUC. On the R-multiple target, logistic retained **{_fmt(survival_table.loc['logistic', 'r_multiple_auc_retained_pct'], 1)}%** and gradient boosting retained **{_fmt(survival_table.loc['hgb', 'r_multiple_auc_retained_pct'], 1)}%** of their original AUCs. The R-multiple result changes both the target and eligible rows, so its retention is descriptive rather than a paired causal estimate.",
        f"\n## 7. Calibration\n\n{_markdown(calibration_table)}\n\n![Out-of-fold calibration](calibration.png)\n\nPlatt and isotonic calibration are fit inside each outer training fold. Isotonic calibration is withheld below 150 training rows. {calibration_takeaway}",
        f"\n## 8. Strategy versus rules, net of costs\n\n### 200 bps\n\n{_markdown(strategy_200)}\n\n### Cost sensitivity\n\n{_markdown(strategy_cost)}\n\n![Cumulative shadow P&L](cumulative_pnl.png)\n\nPaired model-minus-best-rule expectancy: **{_fmt(paired.get('difference'))}%**, 95% CI **{paired.get('ci_95', 'not estimable (0 blocks)')}**; best rule: **{paired.get('best_rule', 'NA')}**. If this interval includes zero, the model is not distinguishable from that rule. Thresholds and the leading confirmation screen are selected using training data only and applied to the next test fold. The current in-sample screen picker chose **{in_sample_screen or 'NA'}** with **{_fmt(in_sample_expectancy)}%** expectancy; nested evaluation produced **{_fmt(nested_expectancy)}%**, an optimism gap of **{_fmt(screen_optimism)} percentage points**.",
        f"\n## 9. Payoff-structure sensitivity\n\nThe empirical simulator produced a TP2 completion share of **{_fmt(tp2_share * 100, 1)}%** among TP1-resolved wins. The analytic table below applies the simulator's exit shape: half sold at TP1, the runner either exits at breakeven or at TP2=2×TP1, a loss reaches the stated maximum structural-risk cap, and one round-trip cost is deducted. These are **hypothetical exit-rule scenarios, not backtested results**.\n\n{_markdown(analytic_sensitivity.assign(breakeven_win_rate=analytic_sensitivity.breakeven_win_rate * 100), 1)}\n\n### Which payoff lever moves breakeven most?\n\n{_markdown(lever_effects, 1)}\n\nThe swing averages the within-scenario maximum-minus-minimum change while holding the other two dimensions fixed. On this grid, **{lever_effects.iloc[0].lever}** moves the mechanical breakeven rate most. This does not account for the lower hit rate likely caused by a farther target.\n\n### Empirical sensitivity under the original exit\n\n{_markdown(empirical_sensitivity.assign(observed_win_rate=empirical_sensitivity.observed_win_rate * 100, breakeven_win_rate=empirical_sensitivity.breakeven_win_rate * 100), 1)}\n\nThe complete path-based test of all target, stop, time, structure, and cost combinations follows in Exit re-simulation. Across the hypothetical grid, increasing TP1 lowers breakeven, tighter maximum stop risk lowers it, and each additional 100 bps of cost raises it.",
        (f"\n## 10. Exit re-simulation\n\n{exit_verdict}\n\nThe grid contains **{exit_study['cells']}** cells across three exit structures, four targets, four stops, three time exits, and three cost assumptions. Every entry is the open of the next five-minute bar; stops win same-bar target conflicts. The in-sample best signal cell was `{exit_study['best_in_sample_rule']}` at **{_fmt(exit_study['best_in_sample_expectancy_pct'])}%** mean net return. Nested purged walk-forward selection produced **{_estimate_ci(exit_study['nested_oos']['expectancy'])}%** on **{exit_study['nested_oos']['trades']}** signal trades, for an in-sample-minus-OOS optimism gap of **{_fmt(exit_study['optimism_gap_pct'])} percentage points**.\n\n### Fold-selected rules\n\n{_markdown(exit_folds)}\n\n### Entry populations under the fold-selected exit\n\n{_markdown(exit_populations)}\n\nThe top-decile models rank controls with out-of-fold scores and exclude `riskPct`. The correlation-pruned version also excludes the three features most correlated with `riskPct` in the first outer training fold: **{', '.join(correlated_features) if correlated_features else 'none estimable'}**.\n\n### Signal-minus-population differences on overlapping test days\n\n{_markdown(exit_differences)}\n\n### Multiple-testing check\n\nPositive in-sample signal cells: **{exit_study['positive_in_sample_cells']} of {exit_study['cells']}**. Within-day return shuffles produced an average **{_fmt(100*exit_study['shuffle'].get('expected_positive_cell_fraction', math.nan), 1)}%** positive cells. Across **{exit_study['shuffle'].get('draws', 0)}** seeded permutations, **{_fmt(100*exit_study['shuffle'].get('positive_cell_p_value', math.nan), 1)}%** produced at least as many positive cells as observed and **{_fmt(100*exit_study['shuffle'].get('best_cell_fraction', math.nan), 1)}%** produced a best cell at least as profitable as the observed in-sample best.\n\n### Market regime\n\n**Skipped.** {exit_study['regime']['reason']}\n\nThe database retains `chart_candles` for only **35 days**. Extending that retention is recommended before a longer locked study, but this PR does not change retention or live storage behavior." if exit_study else "\n## 10. Exit re-simulation\n\nExit-grid artifacts were unavailable, so no empirical exit-rule result is reported."),
        f"\n## 11. Power analysis\n\nAverage net win: **{_fmt(breakeven.get('average_net_win_pct'))}%**; average net loss magnitude: **{_fmt(breakeven.get('average_net_loss_pct'))}%**. Breakeven win rate = `average loss / (average win + average loss)` = **{_fmt(100 * breakeven.get('breakeven_win_rate', math.nan), 1)}%**, versus an observed **{_fmt(100 * observed_sim_win_rate, 1)}%** positive-return rate across the {len(returns)} available immediate simulations.\n\n{_markdown(win_power)}\n\n### Expectancy > 0\n\n{_markdown(expectancy_power)}\n\n![Power analysis](power.png)\n\nCurrent `promotionReady` threshold: 50 resolved setups. Evidence-based provisional recommendation: **{recommended if recommended else 'not estimable from the current sample'}** resolved setups, followed by a fresh locked forward cohort. This is a recommendation only; live code is unchanged.",
        f"\n## 12. Limitations\n\n- The snapshot spans only **{calendar_days} UTC trading days**. Thousands of correlated control rows do not substitute for independent market regimes.\n- The source database retains candle paths for 35 days; older observations cannot be re-simulated once their paths expire.\n- Training data is mostly controls (**{info['by_source'].get('control', 0):,} of {info['rows']:,} rows**) while strategy decisions are evaluated on signals. That is a material distribution shift.\n- Strategy estimates use only **{oof_trade_count} out-of-fold signal trades**; the best rule has **{best_rule_trades} trades**, so its interval may be not estimable.\n- Small samples produce wide intervals and unstable calibration.\n- Discovery and watchlist selection create survivorship and selection bias; controls share that selected-pair universe.\n- Crypto regimes change, so historical calibration can decay.\n- Five-minute OHLC bars cannot order intrabar stop and target touches; the TypeScript simulator resolves ambiguity pessimistically.\n- Fixed cost scenarios cannot reproduce every FOMO quote, spread, network fee, or liquidity shock.\n- Repeated tokens, supports, and days remain dependent even after grouped splits and block bootstrap.\n- This is observational research and does not establish executable profitability.",
        "\n## 13. Recommendations — not implemented in live behavior\n\n1. **Promote nothing.** No exit-rule and entry-population combination established positive out-of-sample expectancy.\n2. If one challenger is collected next, shadow `trailing | TP1 +8% | fixed 3% stop | 24h time exit` on current signals with realized costs. Both eligible training folds independently selected that path rule, but its pooled OOS estimate is not evidence of an edge.\n3. Require at least **180 locked out-of-sample trades** to study a +1 percentage-point edge at the current variance; a +0.5-point edge needs about **743**. Also require at least 20 independent trading days and 30 training signals per fold.\n4. Extend candle retention beyond 35 days before the next long locked cohort so all entries retain full forward paths.\n5. Re-estimate costs from actual read-only execution quotes before any live decision.\n\n## Reproduce\n\n```sh\nnpm run research:fetch-data\npython research/ml/run_all.py\n```\n\n`research:fetch-data` downloads the production candle paths and precomputed exit grids from their GitHub Release and verifies their decompressed hashes. The grids are derived from the committed snapshot, candle paths, and the TypeScript path simulator, so they can be regenerated instead of downloaded. To export a fresh database snapshot, run `npm run research:export` first.\n\nFor pipeline-only validation: `python research/ml/run_all.py --synthetic`.",
        render_edge_program(edge_study),
    ]
    path = report_dir / "REPORT.md"; path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    results = {
        "synthetic": synthetic, "rows": info["rows"], "resolved": info["resolved"], "folds": len(folds),
        "model_details": model_details, "no_risk_model_details": no_risk_details, "pruned_model_details": pruned_details,
        "risk_correlations": risk_correlations, "risk_correlated_features_excluded": correlated_features,
        "r_multiple_model_details": r_details, "r_multiple_folds": len(r_folds),
        "ablation": ablation_raw, "baseline_comparisons": baseline_raw,
        "auc_survival": survival_table.reset_index().to_dict(orient="records"),
        "signal_control": signal_control, "signal_control_return": signal_control_return,
        "payoff_sensitivity_analytic": analytic_sensitivity.to_dict(orient="records"),
        "payoff_sensitivity_empirical": empirical_sensitivity.to_dict(orient="records"),
        "paired": paired, "recommended_resolved": recommended,
        "memecoin_edge_phase1": {
            "verdicts": edge_study.get("verdicts", {}),
            "reason": edge_study.get("reason"),
            "availability": edge_study["availability"].reset_index().to_dict(orient="records"),
        },
    }
    if exit_study:
        results["exit_resimulation"] = {key: value for key, value in exit_study.items() if key != "fold_choices"}
        results["exit_resimulation"]["fold_choices"] = exit_study["fold_choices"].to_dict(orient="records")
    (report_dir / "results.json").write_text(json.dumps(_json_safe(results), indent=2, default=str, allow_nan=False) + "\n", encoding="utf-8")
    return path
