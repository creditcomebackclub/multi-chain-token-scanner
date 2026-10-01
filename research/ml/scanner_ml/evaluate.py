from __future__ import annotations

import math
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

from . import SEED

def classification_metrics(y, probability) -> dict:
    y = np.asarray(y, dtype=int)
    probability = np.clip(np.asarray(probability, dtype=float), 1e-8, 1 - 1e-8)
    if len(y) == 0:
        return {name: math.nan for name in ("log_loss", "brier", "roc_auc", "pr_auc")}
    return {
        "log_loss": float(log_loss(y, probability, labels=[0, 1])),
        "brier": float(brier_score_loss(y, probability)),
        "roc_auc": float(roc_auc_score(y, probability)) if len(np.unique(y)) == 2 else math.nan,
        "pr_auc": float(average_precision_score(y, probability)) if len(np.unique(y)) == 2 else math.nan,
    }

def _sample_days(frame: pd.DataFrame, rng: np.random.Generator) -> pd.DataFrame:
    blocks = [block for _, block in frame.groupby("day", sort=True)]
    return pd.concat([blocks[index] for index in rng.integers(0, len(blocks), len(blocks))], ignore_index=True)

def metric_intervals(frame: pd.DataFrame, prediction: str, n_boot: int = 1_000) -> dict:
    data = frame.loc[frame["y"].isin([0, 1]) & frame[prediction].notna(), ["y", prediction, "day"]]
    estimate = classification_metrics(data["y"], data[prediction])
    rng = np.random.default_rng(SEED)
    draws = {key: [] for key in estimate}
    for _ in range(n_boot):
        sample = _sample_days(data, rng)
        metrics = classification_metrics(sample["y"], sample[prediction])
        for key, value in metrics.items():
            if np.isfinite(value):
                draws[key].append(value)
    return {key: {"estimate": value, "ci_low": float(np.quantile(draws[key], .025)) if draws[key] else math.nan, "ci_high": float(np.quantile(draws[key], .975)) if draws[key] else math.nan} for key, value in estimate.items()}

def reliability_table(y, probability, max_bins: int = 10) -> pd.DataFrame:
    data = pd.DataFrame({"y": y, "p": probability}).dropna()
    if data.empty:
        return pd.DataFrame(columns=["mean_probability", "observed_rate", "count"])
    bins = min(max_bins, max(2, len(data) // 25), data["p"].nunique())
    if bins < 2:
        return pd.DataFrame({"mean_probability": [data.p.mean()], "observed_rate": [data.y.mean()], "count": [len(data)]})
    data["bin"] = pd.qcut(data["p"], q=bins, duplicates="drop")
    return data.groupby("bin", observed=True).agg(mean_probability=("p", "mean"), observed_rate=("y", "mean"), count=("y", "size")).reset_index(drop=True)

def calibration_metrics(y, probability) -> dict:
    table = reliability_table(y, probability)
    y = np.asarray(y, dtype=float)
    p = np.asarray(probability, dtype=float)
    base = float(np.mean(y)) if len(y) else math.nan
    reliability = float(sum(row.count / len(y) * (row.mean_probability - row.observed_rate) ** 2 for row in table.itertuples())) if len(y) else math.nan
    resolution = float(sum(row.count / len(y) * (row.observed_rate - base) ** 2 for row in table.itertuples())) if len(y) else math.nan
    uncertainty = base * (1 - base) if len(y) else math.nan
    ece = float(sum(row.count / len(y) * abs(row.mean_probability - row.observed_rate) for row in table.itertuples())) if len(y) else math.nan
    return {"brier": float(np.mean((p - y) ** 2)) if len(y) else math.nan, "reliability": reliability, "resolution": resolution, "uncertainty": uncertainty, "ece": ece}

def _strategy_metrics(values: pd.DataFrame) -> dict:
    trades = values.loc[values["return"].notna()].sort_values(["exit_at", "detected_at"])
    returns = trades["return"].astype(float)
    wins = returns[returns > 0]
    losses = returns[returns < 0]
    pnl = returns * .5  # fixed $50 position: percent / 100 * $50
    balance = 1_000 + pnl.cumsum()
    peak = balance.cummax()
    drawdown = peak - balance
    return {
        "trades": int(len(trades)), "win_rate": float((returns > 0).mean()) if len(trades) else math.nan,
        "expectancy_pct": float(returns.mean()) if len(trades) else math.nan,
        "profit_factor": float(wins.sum() / abs(losses.sum())) if len(losses) and abs(losses.sum()) else (math.inf if len(wins) else math.nan),
        "max_drawdown_usd": float(drawdown.max()) if len(drawdown) else 0.0,
        "ending_balance_usd": float(balance.iloc[-1]) if len(balance) else 1_000.0,
    }

def strategy_returns(oof: pd.DataFrame, cost_bps: int = 200) -> dict[str, pd.DataFrame]:
    immediate = "immediate_sim_net_return_pct" if cost_bps == 200 else "immediate_sim_net_return_pct_300bps"
    confirmed = "greenHold_sim_net_return_pct" if cost_bps == 200 else "greenHold_sim_net_return_pct_300bps"
    base = oof.loc[oof["fold"].notna() & oof[immediate].notna()].copy()
    def values(mask, column):
        result = base[["id", "day", "detected_at"]].copy()
        result["exit_at"] = pd.to_numeric(base["immediate_sim_exit_at" if column == immediate else "greenHold_sim_exit_at"], errors="coerce")
        result["return"] = pd.to_numeric(base[column], errors="coerce").where(mask)
        return result
    strategies = {
        "take_everything": values(pd.Series(True, index=base.index), immediate),
        "rule_immediate": values(base["rule_immediate"].fillna(False).astype(bool), immediate),
        "rule_greenHold": values(base["rule_greenHold"].fillna(False).astype(bool), confirmed),
        "rule_greenHoldVolume": values(base["rule_greenHoldVolume"].fillna(False).astype(bool), confirmed),
        "model_filtered": values(base["pred_logistic"] >= base["model_threshold"], immediate),
    }
    quality_candidates=base["rule_qualityUnique"].fillna(False).astype(bool)
    quality_mask=pd.Series(False,index=base.index)
    first_quality=base.loc[quality_candidates].sort_values(["detected_at","id"]).drop_duplicates("group_id").index
    quality_mask.loc[first_quality]=True
    strategies["rule_qualityUnique"] = values(quality_mask, confirmed)
    selected = pd.Series(False, index=base.index)
    for screen in ["screen_hold", "screen_greenHold", "screen_holdVolume", "screen_greenHoldVolume"]:
        selected |= (base["selected_screen"] == screen) & base[screen].fillna(False).astype(bool)
    strategies["nested_leading_screen"] = values(selected, confirmed)
    return strategies

def strategy_comparison(oof: pd.DataFrame, cost_bps: int = 200, n_boot: int = 2_000) -> tuple[pd.DataFrame, dict, dict[str, pd.DataFrame]]:
    returns = strategy_returns(oof, cost_bps)
    rows = []
    rng = np.random.default_rng(SEED + cost_bps)
    for name, values in returns.items():
        metrics = _strategy_metrics(values)
        expectancy, win_rate = [], []
        for _ in range(n_boot):
            sample = _sample_days(values, rng)
            sample_metrics = _strategy_metrics(sample)
            if np.isfinite(sample_metrics["expectancy_pct"]): expectancy.append(sample_metrics["expectancy_pct"])
            if np.isfinite(sample_metrics["win_rate"]): win_rate.append(sample_metrics["win_rate"])
        rows.append({"strategy": name, **metrics,
          "expectancy_ci_low": float(np.quantile(expectancy, .025)) if expectancy else math.nan,
          "expectancy_ci_high": float(np.quantile(expectancy, .975)) if expectancy else math.nan,
          "win_rate_ci_low": float(np.quantile(win_rate, .025)) if win_rate else math.nan,
          "win_rate_ci_high": float(np.quantile(win_rate, .975)) if win_rate else math.nan})
    table = pd.DataFrame(rows).set_index("strategy")
    rule_names = [name for name in table.index if name.startswith("rule_")]
    best_rule = table.loc[rule_names, "expectancy_pct"].idxmax() if rule_names else None
    differences = []
    if best_rule:
        left, right = returns["model_filtered"], returns[best_rule]
        paired = left.merge(right, on=["id", "day", "detected_at"], suffixes=("_model", "_rule"))
        for _ in range(n_boot):
            sample = _sample_days(paired, rng)
            model_mean = sample["return_model"].dropna().mean()
            rule_mean = sample["return_rule"].dropna().mean()
            if np.isfinite(model_mean) and np.isfinite(rule_mean): differences.append(float(model_mean - rule_mean))
    paired_result = {"best_rule": best_rule, "difference": float(table.loc["model_filtered", "expectancy_pct"] - table.loc[best_rule, "expectancy_pct"]) if best_rule else math.nan,
      "ci_low": float(np.quantile(differences, .025)) if differences else math.nan, "ci_high": float(np.quantile(differences, .975)) if differences else math.nan}
    return table, paired_result, returns
