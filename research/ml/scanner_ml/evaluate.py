from __future__ import annotations

import math
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, brier_score_loss, log_loss, roc_auc_score

from . import SEED

MIN_BOOTSTRAP_BLOCKS = 3
MIN_BOOTSTRAP_ROWS = 5

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

def _bootstrap_support(frame: pd.DataFrame) -> tuple[bool, int, int]:
    blocks = int(frame["day"].dropna().nunique()) if "day" in frame else 0
    rows = int(len(frame))
    return blocks >= MIN_BOOTSTRAP_BLOCKS and rows >= MIN_BOOTSTRAP_ROWS, blocks, rows

def interval_text(low: float, high: float, blocks: int, digits: int = 3, scale: float = 1.0) -> str:
    if not np.isfinite(low) or not np.isfinite(high) or np.isclose(low, high):
        return f"not estimable ({blocks} blocks)"
    return f"[{low * scale:.{digits}f}, {high * scale:.{digits}f}]"

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

def paired_metric_differences(frame: pd.DataFrame, left: str, right: str, n_boot: int = 1_000) -> dict:
    """Return left-minus-right metric differences using paired day resamples."""
    data = frame.loc[frame["y"].isin([0, 1]) & frame[left].notna() & frame[right].notna(), ["y", left, right, "day"]]
    left_metrics = classification_metrics(data["y"], data[left])
    right_metrics = classification_metrics(data["y"], data[right])
    supported, blocks, rows = _bootstrap_support(data)
    draws = {key: [] for key in left_metrics}
    if supported:
        rng = np.random.default_rng(SEED + 31)
        for _ in range(n_boot):
            sample = _sample_days(data, rng)
            lhs = classification_metrics(sample["y"], sample[left])
            rhs = classification_metrics(sample["y"], sample[right])
            for key in draws:
                difference = lhs[key] - rhs[key]
                if np.isfinite(difference):
                    draws[key].append(float(difference))
    return {
        key: {
            "left": left_metrics[key], "right": right_metrics[key],
            "difference": left_metrics[key] - right_metrics[key],
            "ci_low": float(np.quantile(draws[key], .025)) if draws[key] else math.nan,
            "ci_high": float(np.quantile(draws[key], .975)) if draws[key] else math.nan,
            "blocks": blocks, "rows": rows,
        }
        for key in left_metrics
    }

def signal_control_rate_difference(frame: pd.DataFrame, n_boot: int = 2_000) -> dict:
    data = frame.loc[frame["y"].isin([0, 1]), ["y", "source", "day"]].copy()
    data["is_signal"] = data["source"].ne("control")
    signal = data.loc[data.is_signal, "y"]
    control = data.loc[~data.is_signal, "y"]
    estimate = float(signal.mean() - control.mean()) if len(signal) and len(control) else math.nan
    supported, blocks, rows = _bootstrap_support(data)
    draws: list[float] = []
    if supported:
        rng = np.random.default_rng(SEED + 71)
        for _ in range(n_boot):
            sample = _sample_days(data, rng)
            lhs = sample.loc[sample.is_signal, "y"]
            rhs = sample.loc[~sample.is_signal, "y"]
            if len(lhs) and len(rhs):
                draws.append(float(lhs.mean() - rhs.mean()))
    return {
        "signal_rate": float(signal.mean()) if len(signal) else math.nan,
        "control_rate": float(control.mean()) if len(control) else math.nan,
        "difference": estimate,
        "ci_low": float(np.quantile(draws, .025)) if draws else math.nan,
        "ci_high": float(np.quantile(draws, .975)) if draws else math.nan,
        "blocks": blocks, "rows": rows,
    }

def signal_control_return_difference(frame: pd.DataFrame, column: str, n_boot: int = 2_000) -> dict | None:
    data = frame.loc[frame[column].notna(), [column, "source", "day"]].copy()
    data["is_signal"] = data["source"].ne("control")
    signal = data.loc[data.is_signal, column]
    control = data.loc[~data.is_signal, column]
    if signal.empty or control.empty:
        return None
    supported, blocks, rows = _bootstrap_support(data)
    draws: list[float] = []
    if supported:
        rng = np.random.default_rng(SEED + 79)
        for _ in range(n_boot):
            sample = _sample_days(data, rng)
            lhs = sample.loc[sample.is_signal, column]
            rhs = sample.loc[~sample.is_signal, column]
            if len(lhs) and len(rhs):
                draws.append(float(lhs.mean() - rhs.mean()))
    return {
        "signal_mean": float(signal.mean()), "control_mean": float(control.mean()),
        "difference": float(signal.mean() - control.mean()),
        "ci_low": float(np.quantile(draws, .025)) if draws else math.nan,
        "ci_high": float(np.quantile(draws, .975)) if draws else math.nan,
        "blocks": blocks, "rows": rows,
    }

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
        trade_rows = values.loc[values["return"].notna()].copy()
        supported, blocks, _ = _bootstrap_support(trade_rows)
        expectancy, win_rate = [], []
        if supported:
            for _ in range(n_boot):
                sample = _sample_days(trade_rows, rng)
                sample_metrics = _strategy_metrics(sample)
                if np.isfinite(sample_metrics["expectancy_pct"]): expectancy.append(sample_metrics["expectancy_pct"])
                if np.isfinite(sample_metrics["win_rate"]): win_rate.append(sample_metrics["win_rate"])
        expectancy_low = float(np.quantile(expectancy, .025)) if expectancy else math.nan
        expectancy_high = float(np.quantile(expectancy, .975)) if expectancy else math.nan
        win_low = float(np.quantile(win_rate, .025)) if win_rate else math.nan
        win_high = float(np.quantile(win_rate, .975)) if win_rate else math.nan
        rows.append({"strategy": name, **metrics,
          "day_blocks": blocks,
          "expectancy_ci_95": interval_text(expectancy_low, expectancy_high, blocks),
          "win_rate_ci_95": interval_text(win_low, win_high, blocks)})
    table = pd.DataFrame(rows).set_index("strategy")
    rule_names = [name for name in table.index if name.startswith("rule_")]
    best_rule = table.loc[rule_names, "expectancy_pct"].idxmax() if rule_names else None
    differences = []
    if best_rule:
        left, right = returns["model_filtered"], returns[best_rule]
        paired = left.merge(right, on=["id", "day", "detected_at"], suffixes=("_model", "_rule"))
        useful_days = paired.groupby("day").filter(lambda group: group["return_model"].notna().any() and group["return_rule"].notna().any())
        supported, paired_blocks, paired_rows = _bootstrap_support(useful_days)
        if supported:
            for _ in range(n_boot):
                sample = _sample_days(useful_days, rng)
                model_mean = sample["return_model"].dropna().mean()
                rule_mean = sample["return_rule"].dropna().mean()
                if np.isfinite(model_mean) and np.isfinite(rule_mean): differences.append(float(model_mean - rule_mean))
    else:
        paired_blocks = 0
        paired_rows = 0
    difference_low = float(np.quantile(differences, .025)) if differences else math.nan
    difference_high = float(np.quantile(differences, .975)) if differences else math.nan
    paired_result = {"best_rule": best_rule, "difference": float(table.loc["model_filtered", "expectancy_pct"] - table.loc[best_rule, "expectancy_pct"]) if best_rule else math.nan,
      "ci_low": difference_low, "ci_high": difference_high, "blocks": paired_blocks, "rows": paired_rows,
      "ci_95": interval_text(difference_low, difference_high, paired_blocks)}
    return table, paired_result, returns
