from __future__ import annotations

from pathlib import Path
import json
import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from .data import FEATURES, audit, load_dataset, resolved
from .evaluate import calibration_metrics, classification_metrics, metric_intervals, reliability_table, strategy_comparison
from .models import choose_screen, coefficient_intervals, out_of_fold_predictions
from .power import power_analysis
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
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |", *["| " + " | ".join(row) + " |" for row in rows]])

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
    naive_folds = naive_shuffled_splits(frame, n_splits=min(5, max(2, len(labeled) // 30))) if len(labeled) >= 30 else []
    naive, _ = out_of_fold_predictions(frame, naive_folds) if naive_folds else (frame.copy(), {})
    boot_metrics = max(100, int(1_000 * bootstrap_scale)); boot_strategy = max(200, int(2_000 * bootstrap_scale))
    metric_rows = []
    for column in ["pred_baseline", "pred_logistic", "pred_hgb", "pred_logistic_platt", "pred_hgb_isotonic"]:
        if column in oof and oof[column].notna().any():
            values = metric_intervals(oof, column, boot_metrics)
            metric_rows.append({"model": column.removeprefix("pred_"), **{metric: result["estimate"] for metric, result in values.items()}, **{f"{metric}_ci_low": result["ci_low"] for metric, result in values.items()}, **{f"{metric}_ci_high": result["ci_high"] for metric, result in values.items()}})
    metric_table = pd.DataFrame(metric_rows).set_index("model") if metric_rows else pd.DataFrame()
    fold_rows=[]
    for fold_number,fold_data in oof.loc[oof["fold"].notna()].groupby("fold"):
        for column in ["pred_logistic","pred_hgb"]:
            usable=fold_data.loc[fold_data[column].notna()]
            if len(usable):fold_rows.append({"fold":int(fold_number),"model":column.removeprefix("pred_"),**classification_metrics(usable["y"],usable[column])})
    fold_table=pd.DataFrame(fold_rows).set_index(["fold","model"]) if fold_rows else pd.DataFrame()
    naive_metric = metric_intervals(naive, "pred_logistic", max(100, boot_metrics // 2)) if "pred_logistic" in naive and naive["pred_logistic"].notna().any() else {}
    calibration_rows=[]
    for column in ["pred_logistic", "pred_logistic_platt", "pred_hgb", "pred_hgb_isotonic"]:
        rows=oof.loc[oof.get(column, pd.Series(index=oof.index,dtype=float)).notna()&oof["y"].isin([0,1])]
        if len(rows): calibration_rows.append({"model":column.removeprefix("pred_"),**calibration_metrics(rows["y"],rows[column])})
    calibration_table=pd.DataFrame(calibration_rows).set_index("model") if calibration_rows else pd.DataFrame()
    coefficients=coefficient_intervals(labeled, max(100, int(1_000*bootstrap_scale)))
    strategy_200, paired, curves = strategy_comparison(oof, 200, boot_strategy) if folds else (pd.DataFrame(),{}, {})
    strategy_300, _, _ = strategy_comparison(oof, 300, max(200, boot_strategy//2)) if folds else (pd.DataFrame(),{}, {})
    signal_rate=labeled.loc[labeled.source!='control','y'].mean(); control_rate=labeled.loc[labeled.source=='control','y'].mean()
    feature_summary=labeled[FEATURES].describe().T[["mean","std","50%"]].rename(columns={"50%":"median"});feature_summary["missing_pct"]=labeled[FEATURES].isna().mean()*100
    importance_table=pd.DataFrame.from_dict(model_details.get("permutation_importance",{}),orient="index",columns=["validation_permutation_importance"])
    calibration_takeaway="Insufficient out-of-fold predictions for a 70% reliability statement."
    if "pred_logistic" in oof:
        calibration_rows_for_text=oof.loc[oof.pred_logistic.notna()&oof.y.isin([0,1])]
        if len(calibration_rows_for_text):
            reliability=reliability_table(calibration_rows_for_text.y,calibration_rows_for_text.pred_logistic)
            if len(reliability):
                row=reliability.iloc[(reliability.mean_probability-.7).abs().argmin()]
                calibration_takeaway=f"The probability bin nearest 70% averaged {_fmt(row.mean_probability*100,1)}% predicted and {_fmt(row.observed_rate*100,1)}% observed across {int(row['count'])} out-of-fold rows."
    signal_rows=labeled.loc[(labeled.source!='control')&labeled.greenHold_sim_net_return_pct.notna()].copy()
    in_sample_screen=choose_screen(signal_rows) if len(signal_rows) else None
    in_sample_expectancy=float(signal_rows.loc[signal_rows[in_sample_screen].fillna(False).astype(bool),"greenHold_sim_net_return_pct"].mean()) if in_sample_screen else math.nan
    nested_expectancy=float(strategy_200.loc["nested_leading_screen","expectancy_pct"]) if "nested_leading_screen" in strategy_200.index else math.nan
    screen_optimism=in_sample_expectancy-nested_expectancy if np.isfinite(in_sample_expectancy) and np.isfinite(nested_expectancy) else math.nan
    returns=pd.to_numeric(frame.loc[frame.immediate_sim_net_return_pct.notna(),'immediate_sim_net_return_pct'],errors='coerce').dropna()
    breakeven,win_power,expectancy_power=power_analysis(returns,simulations=max(200,int(2_000*bootstrap_scale)))
    _save_calibration(oof,report_dir/'calibration.png');_save_curves(curves,report_dir/'cumulative_pnl.png');_save_power(win_power,len(labeled),report_dir/'power.png');_save_coefficients(coefficients,report_dir/'coefficients.png')
    walk_brier=metric_table.loc['logistic','brier'] if 'logistic' in metric_table.index else math.nan
    naive_brier=naive_metric.get('brier',{}).get('estimate',math.nan) if naive_metric else math.nan
    observed_rate=float(labeled.y.mean()) if len(labeled) else math.nan
    recommended=None
    if len(win_power) and np.isfinite(observed_rate):
        eligible=win_power.loc[win_power.true_win_rate<=observed_rate]
        if len(eligible):recommended=int(max(50,eligible.iloc[-1].monte_carlo_n or eligible.iloc[-1].analytic_n))
    label='SYNTHETIC PIPELINE TEST — NOT EMPIRICAL RESULTS' if synthetic else 'PRODUCTION SNAPSHOT'
    source_table=pd.DataFrame.from_dict(info['by_source'],orient='index',columns=['rows']);chain_table=pd.DataFrame.from_dict(info['by_chain'],orient='index',columns=['rows'])
    strategy_cost=pd.DataFrame({'200_bps_expectancy':strategy_200.get('expectancy_pct',pd.Series(dtype=float)),'300_bps_expectancy':strategy_300.get('expectancy_pct',pd.Series(dtype=float))})
    lines=[f"# Offline ML research report\n\n> **{label}**", "\n## 1. Research question\n\nDo point-in-time setup features predict TP1-first outcomes better than the hand-written rules, net of modeled costs? Model inferiority or statistical indistinguishability is a valid result.",
      f"\n## 2. Data\n\nRows: **{info['rows']}**; resolved: **{info['resolved']}**; span: **{info['time_start']} to {info['time_end']}**. Ambiguous and unresolved rows are excluded from supervised fitting. Controls are eligible non-signal candles from the selected-pair universe, not random entries from the entire market. Signal/alert TP1-first rate: **{_fmt(signal_rate*100,1)}%**; control rate: **{_fmt(control_rate*100,1)}%**.\n\n### Sources\n\n{_markdown(source_table,0)}\n\n### Chains\n\n{_markdown(chain_table,0)}\n\n### Feature audit\n\n{_markdown(feature_summary)}\n\nRepeated `(chain, token, support_anchor)` groups: **{info['repeated_groups']}** of **{info['groups']}**. Maximum rows in one group: **{info['max_rows_per_group']}**. All 15 features passed the code-level point-in-time review: they are calculated from closed candles at or before `detected_at` in `src/chart-pattern.ts`.",
      f"\n## 3. Validation design\n\nThe study uses expanding-window splits in detection-time order. A 24-hour pre-test gap is applied, the 24 hours after each prior test block remain embargoed when that history later becomes eligible for training, training observations whose label windows reach the current test period are purged, and support groups never cross a train/test boundary within a fold. Usable folds: **{len(folds)}**. {'At least three folds were available.' if enough else '**Insufficient data for three defensible folds; model comparisons are exploratory or unavailable.**'}\n\nThe deliberately naive shuffled comparison produced logistic Brier **{_fmt(naive_brier)}**, versus purged walk-forward Brier **{_fmt(walk_brier)}**. A lower shuffled score is evidence of optimistic leakage, not superior deployment performance.",
      f"\n## 4. Model results with 95% block-bootstrap intervals\n\n### Pooled out-of-fold\n\n{_markdown(metric_table)}\n\n### Per fold\n\n{_markdown(fold_table)}\n\n### Logistic coefficients\n\n{_markdown(coefficients)}\n\n### Gradient-boosting validation-fold permutation importance\n\n{_markdown(importance_table)}\n\n![Coefficient intervals](coefficients.png)\n\nGradient boosting is withheld when an outer training fold has fewer than 80 rows. Coefficient intervals resample trading days rather than individual rows.",
      f"\n## 5. Calibration\n\n{_markdown(calibration_table)}\n\n![Out-of-fold calibration](calibration.png)\n\nPlatt and isotonic calibration are fit inside each outer training fold. Isotonic calibration is withheld below 150 training rows. {calibration_takeaway}",
      f"\n## 6. Strategy versus rules, net of costs\n\n### 200 bps\n\n{_markdown(strategy_200)}\n\n### Cost sensitivity\n\n{_markdown(strategy_cost)}\n\n![Cumulative shadow P&L](cumulative_pnl.png)\n\nPaired model-minus-best-rule expectancy: **{_fmt(paired.get('difference'))}%**, 95% CI **[{_fmt(paired.get('ci_low'))}, {_fmt(paired.get('ci_high'))}]**; best rule: **{paired.get('best_rule','NA')}**. If this interval includes zero, the model is not distinguishable from that rule. Thresholds and the leading confirmation screen are selected using training data only and applied to the next test fold. The current in-sample screen picker chose **{in_sample_screen or 'NA'}** with **{_fmt(in_sample_expectancy)}%** expectancy; nested evaluation produced **{_fmt(nested_expectancy)}%**, an optimism gap of **{_fmt(screen_optimism)} percentage points**.",
      f"\n## 7. Power analysis\n\nAverage net win: **{_fmt(breakeven.get('average_net_win_pct'))}%**; average net loss magnitude: **{_fmt(breakeven.get('average_net_loss_pct'))}%**. Breakeven win rate = `average loss / (average win + average loss)` = **{_fmt(100*breakeven.get('breakeven_win_rate',math.nan),1)}%**.\n\n{_markdown(win_power)}\n\n### Expectancy > 0\n\n{_markdown(expectancy_power)}\n\n![Power analysis](power.png)\n\nCurrent `promotionReady` threshold: 50 resolved setups. Evidence-based provisional recommendation: **{recommended if recommended else 'not estimable from the current sample'}** resolved setups, followed by a fresh locked forward cohort. This is a recommendation only; live code is unchanged.",
      "\n## 8. Limitations\n\n- Small samples produce wide intervals and unstable calibration.\n- Discovery and watchlist selection create survivorship and selection bias; controls share that selected-pair universe.\n- Crypto regimes change, so historical calibration can decay.\n- Five-minute OHLC bars cannot order intrabar stop and target touches; the TypeScript simulator resolves ambiguity pessimistically.\n- Fixed 200 and 300 bps scenarios cannot reproduce every FOMO quote, spread, network fee, or liquidity shock.\n- Repeated tokens, supports, and days remain dependent even after grouped splits and block bootstrap.\n- This is observational research and does not establish executable profitability.",
      "\n## 9. Recommendations — not implemented in live behavior\n\n1. Keep collecting a locked forward cohort until the power target is reached.\n2. Prefer the simplest strategy whose out-of-sample expectancy interval excludes zero.\n3. Treat a model as a challenger to the rules, never as proof of an edge.\n4. Re-estimate costs from actual read-only execution quotes before any live decision.\n\n## Reproduce\n\n```sh\nnpm run research:export\npython research/ml/run_all.py\n```\n\nFor pipeline-only validation: `python research/ml/run_all.py --synthetic`."
    ]
    path=report_dir/'REPORT.md';path.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    (report_dir/'results.json').write_text(json.dumps({'synthetic':synthetic,'rows':info['rows'],'resolved':info['resolved'],'folds':len(folds),'model_details':model_details,'paired':paired,'recommended_resolved':recommended},indent=2,default=str)+'\n',encoding='utf-8')
    return path
