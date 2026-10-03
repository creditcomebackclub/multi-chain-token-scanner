from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from . import SEED
from .data import FEATURES_WITHOUT_RISK
from .evaluate import classification_metrics, paired_metric_differences
from .exit_analysis import _difference, _interval, _shuffle_test, load_exit_grid
from .models import out_of_fold_predictions
from .validation import walk_forward_splits

MIN_TRAIN_SIGNALS = 30
FLOW_FEATURES = [
    "buyer_acceleration", "count_ratio_trend", "liquidity_change_15m",
    "liquidity_change_30m", "liquidity_change_60m", "volume_to_liquidity",
]
REFERENCE_EDGE_RULE = "fat_tail|fixed20|trail40|168h|200bps"


def load_edge_grid(path: str | Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    columns = ["id", "rule_id", "structure", "stop", "trail_pct", "time_hours", "cost_bps",
               "net_return_pct", "gross_return_pct", "exit_reason", "exit_at", "resolved", "max_multiple"]
    grid = pd.read_csv(path, usecols=columns, dtype={"id": "category", "rule_id": "category", "structure": "category", "stop": "category"})
    for column in ["trail_pct", "time_hours", "cost_bps", "net_return_pct", "gross_return_pct", "exit_at", "max_multiple"]:
        grid[column] = pd.to_numeric(grid[column], errors="coerce")
    if grid["resolved"].dtype != bool:
        grid["resolved"] = grid["resolved"].astype("string").str.lower().eq("true")
    grid.loc[~grid.resolved, ["net_return_pct", "gross_return_pct"]] = np.nan
    # A 2x hit is known as soon as it occurs. A sub-2x maximum is a valid
    # negative label only after the simulated path has resolved; surviving
    # incomplete paths remain unlabeled.
    grid.loc[~grid.resolved & grid.max_multiple.lt(2), "max_multiple"] = np.nan
    configs = grid.drop_duplicates("rule_id")[["rule_id", "structure", "stop", "trail_pct", "time_hours", "cost_bps"]].copy()
    configs["rule_id"] = configs.rule_id.astype(str)
    returns = grid.pivot(index="id", columns="rule_id", values="net_return_pct").astype("float32")
    maxima = grid.pivot(index="id", columns="rule_id", values="max_multiple").astype("float32")
    returns.index = returns.index.astype(str); returns.columns = returns.columns.astype(str)
    maxima.index = maxima.index.astype(str); maxima.columns = maxima.columns.astype(str)
    return returns, maxima, configs.set_index("rule_id").sort_index()


def _tail(values: pd.Series) -> dict:
    clean = pd.to_numeric(values, errors="coerce").dropna().astype(float)
    result = {"trades": int(len(clean)), "mean": float(clean.mean()) if len(clean) else math.nan,
              "median": float(clean.median()) if len(clean) else math.nan}
    for percentile in [5, 10, 25, 50, 75, 90, 95, 99]:
        result[f"p{percentile}"] = float(clean.quantile(percentile / 100)) if len(clean) else math.nan
    for multiple, threshold in [(2, 100), (5, 400), (10, 900)]:
        result[f"share_ge_{multiple}x"] = float((clean >= threshold).mean()) if len(clean) else math.nan
    if len(clean):
        cutoff = clean.quantile(.99)
        without = clean.loc[clean < cutoff]
        result["mean_without_top_1pct"] = float(without.mean()) if len(without) else math.nan
        result["top_1pct_contribution"] = float(clean.mean() - result["mean_without_top_1pct"]) if len(without) else math.nan
    else:
        result.update(mean_without_top_1pct=math.nan, top_1pct_contribution=math.nan)
    return result


def _coverage(series: pd.Series) -> dict:
    if series.dtype == object or isinstance(series.dtype, pd.StringDtype):
        present = series.astype("string").str.len().fillna(0).gt(0)
    else:
        present = pd.to_numeric(series, errors="coerce").notna()
    return {"present": int(present.sum()), "rows": int(len(series)), "coverage_pct": float(100 * present.mean()) if len(series) else math.nan}


def data_availability(frame: pd.DataFrame, metadata: dict) -> pd.DataFrame:
    fields = {
        "pool age at detection": ("pool_age_hours", "snapshot discovery candidate"),
        "buyer counts": ("discovery_buyers_5m", "snapshot discovery candidate"),
        "seller counts": ("discovery_sellers_5m", "snapshot discovery candidate"),
        "swap counts": ("discovery_buys_5m", "snapshot discovery candidate"),
        "liquidity at detection": ("discovery_liquidity", "snapshot discovery candidate"),
        "FDV": ("signal_fdv", "signal-only exact-pool evidence"),
        "market cap": ("signal_market_cap", "signal-only exact-pool evidence"),
        "GoPlus status": ("security_status", "signal-only evidence"),
    }
    derived = engineer_flow(frame)
    fields.update({
        "buyer/seller rolling changes": ("count_ratio_trend", "derived from point-in-time discovery snapshots"),
        "liquidity rolling changes": ("liquidity_change_15m", "derived from point-in-time discovery snapshots"),
    })
    rows = []
    populations = {
        "all": derived,
        "signal_or_alert": derived.loc[derived.source.ne("control")],
        "control": derived.loc[derived.source.eq("control")],
    }
    for population, block in populations.items():
        for label, (column, source) in fields.items():
            stats = _coverage(block[column])
            rows.append({"field": label, "population": population, **stats, "source": source,
                         "usable": stats["coverage_pct"] >= 50})
    wallet_count = int(metadata.get("table_counts", {}).get("wallet_watch_alerts", 0))
    rows.append({"field": "wallet-watch events", "population": "database", "present": wallet_count, "rows": wallet_count, "coverage_pct": math.nan,
                 "source": "database count only; identities excluded from export", "usable": False})
    rows.append({"field": "major-asset candles", "population": "all", "present": 0, "rows": len(frame), "coverage_pct": 0.0,
                 "source": "absent: chart_candles contains watched token pools only", "usable": False})
    return pd.DataFrame(rows).set_index(["field", "population"])


def engineer_flow(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    for column in FLOW_FEATURES:
        result[column] = np.nan
    current_columns = ["discovery_fetched_at", "discovery_buyers_5m", "discovery_buys_5m", "discovery_sells_5m", "discovery_liquidity", "discovery_volume_5m"]
    for column in current_columns:
        result[column] = pd.to_numeric(result[column], errors="coerce")
    result["volume_to_liquidity"] = result.discovery_volume_5m / result.discovery_liquidity.replace(0, np.nan)
    for _, indexes in result.groupby(["chain", "pool"], sort=False).groups.items():
        group = result.loc[indexes].sort_values(["discovery_fetched_at", "detected_at"])
        snapshots = group.dropna(subset=["discovery_fetched_at"]).drop_duplicates("discovery_fetched_at", keep="last").sort_values("discovery_fetched_at")
        if snapshots.empty:
            continue
        times = snapshots.discovery_fetched_at.to_numpy(float)
        for idx, row in group.iterrows():
            now = row.discovery_fetched_at
            if not np.isfinite(now):
                continue
            def prior(minutes: int):
                position = np.searchsorted(times, now - minutes * 60_000, side="right") - 1
                return snapshots.iloc[position] if position >= 0 else None
            p5 = prior(5)
            if p5 is not None:
                if np.isfinite(row.discovery_buyers_5m) and np.isfinite(p5.discovery_buyers_5m):
                    result.at[idx, "buyer_acceleration"] = row.discovery_buyers_5m - p5.discovery_buyers_5m
                current_den = row.discovery_sells_5m
                prior_den = p5.discovery_sells_5m
                if np.isfinite(row.discovery_buys_5m) and np.isfinite(current_den) and current_den > 0 and np.isfinite(p5.discovery_buys_5m) and np.isfinite(prior_den) and prior_den > 0:
                    result.at[idx, "count_ratio_trend"] = row.discovery_buys_5m / current_den - p5.discovery_buys_5m / prior_den
            for minutes in [15, 30, 60]:
                old = prior(minutes)
                if old is not None and np.isfinite(row.discovery_liquidity) and np.isfinite(old.discovery_liquidity) and old.discovery_liquidity > 0:
                    result.at[idx, f"liquidity_change_{minutes}m"] = (row.discovery_liquidity / old.discovery_liquidity - 1) * 100
    return result


def base_rate_tables(frame: pd.DataFrame, matrix: pd.DataFrame, configs: pd.DataFrame, n_boot: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    controls = frame.loc[frame.source.eq("control") & frame.id.astype(str).isin(matrix.index), ["id", "chain", "day"]].copy()
    controls["id"] = controls.id.astype(str)
    overall = []
    by_chain = []
    by_day = []
    for rule_id in matrix.columns:
        rows = controls.copy(); rows["net_return_pct"] = rows.id.map(matrix[rule_id]); values = rows.net_return_pct
        interval = _fast_day_interval(rows, "net_return_pct", n_boot)
        record = {"rule_id": rule_id, **configs.loc[rule_id].to_dict(), **_tail(values),
                  "ci_low": interval["ci_low"], "ci_high": interval["ci_high"], "day_blocks": interval["blocks"]}
        overall.append(record)
        for chain, block in rows.groupby("chain"):
            by_chain.append({"rule_id": rule_id, "chain": chain, **_tail(block.net_return_pct)})
        for day, block in rows.groupby("day"):
            by_day.append({"rule_id": rule_id, "day": str(day.date()), **_tail(block.net_return_pct)})
    return pd.DataFrame(overall), pd.DataFrame(by_chain), pd.DataFrame(by_day)


def exit_population_table(frame: pd.DataFrame, matrix: pd.DataFrame, configs: pd.DataFrame, n_boot: int) -> pd.DataFrame:
    populations = {
        "signals_and_alerts": frame.loc[frame.source.ne("control")],
        "controls": frame.loc[frame.source.eq("control")],
    }
    records = []
    for rule_id in matrix.columns:
        for population, block in populations.items():
            rows = block.loc[block.id.astype(str).isin(matrix.index), ["id", "day"]].copy()
            rows["net_return_pct"] = rows.id.astype(str).map(matrix[rule_id])
            interval = _fast_day_interval(rows, "net_return_pct", n_boot)
            records.append({"rule_id": rule_id, **configs.loc[rule_id].to_dict(), "population": population,
                            **_tail(rows.net_return_pct), "ci_low": interval["ci_low"],
                            "ci_high": interval["ci_high"], "day_blocks": interval["blocks"]})
    return pd.DataFrame(records)


def _fast_day_interval(values: pd.DataFrame, column: str, n_boot: int) -> dict:
    """Day-block mean interval without repeatedly concatenating full frames."""
    data = values.dropna(subset=[column, "day"])
    grouped = data.groupby("day")[column].agg(["sum", "count"])
    blocks = int(len(grouped)); estimate = float(data[column].mean()) if len(data) else math.nan
    result = {"estimate": estimate, "ci_low": math.nan, "ci_high": math.nan,
              "blocks": blocks, "rows": int(len(data))}
    if blocks < 3 or len(data) < 5:
        return result
    sums = grouped["sum"].to_numpy(float); counts = grouped["count"].to_numpy(float)
    rng = np.random.default_rng(SEED)
    chosen = rng.integers(0, blocks, size=(n_boot, blocks))
    draws = sums[chosen].sum(axis=1) / counts[chosen].sum(axis=1)
    result.update(ci_low=float(np.quantile(draws, .025)), ci_high=float(np.quantile(draws, .975)))
    return result


def nested_edge_selection(frame: pd.DataFrame, matrix: pd.DataFrame, configs: pd.DataFrame, n_boot: int, shuffle_draws: int) -> dict:
    validation = frame.copy()
    validation["y"] = validation.source.ne("control").astype(float)
    validation["label_resolved_at"] = validation.detected_at + 168 * 60 * 60 * 1000
    folds = walk_forward_splits(validation, min_test_rows=20, embargo_hours=168)
    signal_ids = frame.loc[frame.source.ne("control") & frame.id.astype(str).isin(matrix.index), "id"].astype(str).tolist()
    in_sample = matrix.reindex(signal_ids); counts = in_sample.count(); means = in_sample.mean(); eligible = means[counts >= MIN_TRAIN_SIGNALS]
    best_rule = str(eligible.idxmax()) if len(eligible) else None
    positive = int((eligible > 0).sum())
    signal_parts, control_parts, choices = [], [], []
    for fold in folds:
        train, test = frame.loc[fold.train], frame.loc[fold.test]
        train_ids = train.loc[train.source.ne("control"), "id"].astype(str)
        train_values = matrix.reindex(train_ids); train_counts = train_values.count(); candidates = train_values.mean()[train_counts >= MIN_TRAIN_SIGNALS]
        if candidates.empty:
            continue
        chosen = str(candidates.idxmax()); choices.append({"fold": fold.number, "rule_id": chosen, "train_trades": int(train_counts[chosen]), "train_expectancy_pct": float(candidates[chosen])})
        evaluated = test.loc[test.id.astype(str).isin(matrix.index)].copy(); evaluated["net_return_pct"] = evaluated.id.astype(str).map(matrix[chosen])
        signal_parts.append(evaluated.loc[evaluated.source.ne("control")]); control_parts.append(evaluated.loc[evaluated.source.eq("control")])
    empty = pd.DataFrame(columns=[*frame.columns, "net_return_pct"])
    signals = pd.concat(signal_parts, ignore_index=True) if signal_parts else empty.copy()
    controls = pd.concat(control_parts, ignore_index=True) if control_parts else empty.copy()
    signal_interval = _interval(signals, "net_return_pct", n_boot)
    control_interval = _interval(controls, "net_return_pct", n_boot)
    difference = _difference(signals, controls, "net_return_pct", n_boot)
    supported = bool(np.isfinite(signal_interval["ci_low"]) and signal_interval["ci_low"] > 0 and np.isfinite(difference["ci_low"]) and difference["ci_low"] > 0)
    shuffle = _shuffle_test(frame, matrix, signal_ids, positive, float(eligible.max()) if len(eligible) else math.nan, shuffle_draws) if best_rule else {}
    supported = supported and shuffle.get("best_cell_fraction", 1) < .05
    return {"folds": len(folds), "choices": choices, "signals": signals, "controls": controls,
            "signal_expectancy": signal_interval, "control_expectancy": control_interval, "difference": difference,
            "in_sample_best_rule": best_rule, "in_sample_best_expectancy_pct": float(eligible.max()) if len(eligible) else math.nan,
            "eligible_cells": int(len(eligible)), "positive_cells": positive, "shuffle": shuffle,
            "verdict": "supported" if supported else ("not estimable" if not choices else "not supported")}


def pool_age_analysis(frame: pd.DataFrame, matrix: pd.DataFrame, configs: pd.DataFrame,
                      nested: dict, n_boot: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    data = frame.copy(); age = pd.to_numeric(data.pool_age_hours, errors="coerce")
    data["age_bucket"] = pd.cut(age, [-np.inf, 1, 4, 24, np.inf], labels=["<1h", "1–4h", "4–24h", ">24h"], right=False)
    table = data.groupby(["age_bucket", "source"], observed=True).agg(
        rows=("id", "size"),
        security_known=("security_status", lambda x: x.astype("string").str.len().fillna(0).gt(0).sum()),
    ).reset_index()
    security = data.loc[data.security_status.astype("string").str.len().fillna(0).gt(0)].copy()
    status_mix = security.groupby(["age_bucket", "security_status"], observed=True).size().rename("rows").reset_index()
    if len(status_mix):
        status_mix["share_of_known_pct"] = 100 * status_mix.rows / status_mix.groupby("age_bucket", observed=True).rows.transform("sum")
    descriptive = []
    eligible = data.loc[data.id.astype(str).isin(matrix.index), ["id", "source", "age_bucket", "day"]].copy()
    eligible["id"] = eligible.id.astype(str)
    for rule_id in matrix.columns:
        rows = eligible.copy(); rows["net_return_pct"] = rows.id.map(matrix[rule_id])
        for (bucket, source), block in rows.groupby(["age_bucket", "source"], observed=True):
            interval = _fast_day_interval(block, "net_return_pct", n_boot)
            descriptive.append({"rule_id": rule_id, **configs.loc[rule_id].to_dict(), "age_bucket": str(bucket),
                                "population": source, **_tail(block.net_return_pct),
                                "ci_low": interval["ci_low"], "ci_high": interval["ci_high"],
                                "day_blocks": interval["blocks"]})
    descriptive_table = pd.DataFrame(descriptive)
    coverage = float(age.notna().mean()) if len(data) else 0
    if coverage < .5 or not nested["choices"]:
        return table, status_mix, descriptive_table, {"coverage_pct": coverage * 100,
            "verdict": "blocked" if coverage < .5 else "not estimable",
            "reason": "pool age coverage below 50%" if coverage < .5 else "no eligible nested exit folds; descriptive prespecified-rule results are reported"}
    signals = nested["signals"].copy()
    if signals.empty:
        return table, status_mix, descriptive_table, {"coverage_pct": coverage * 100, "verdict": "not estimable", "reason": "no out-of-sample signal trades"}
    signals["age_bucket"] = pd.cut(pd.to_numeric(signals.pool_age_hours, errors="coerce"), [-np.inf, 1, 4, 24, np.inf], labels=["<1h", "1–4h", "4–24h", ">24h"], right=False)
    summaries = {str(bucket): _interval(block, "net_return_pct", n_boot) for bucket, block in signals.groupby("age_bucket", observed=True)}
    return table, status_mix, descriptive_table, {"coverage_pct": coverage * 100, "verdict": "not estimable", "buckets": summaries, "reason": "bucket selection requires at least 30 training and 20 test observations"}


def flow_analysis(frame: pd.DataFrame, maxima: pd.DataFrame, nested: dict, n_boot: int) -> dict:
    data = engineer_flow(frame)
    coverage = {feature: float(data[feature].notna().mean()) for feature in FLOW_FEATURES}
    if not coverage or min(coverage.values()) < .5:
        return {"coverage_pct": {key: value * 100 for key, value in coverage.items()}, "verdict": "blocked", "reason": "one or more preregistered flow features have less than 50% coverage"}
    label_rule = "fat_tail|support|trail40|168h|200bps"
    if label_rule not in maxima:
        return {"coverage_pct": {key: value * 100 for key, value in coverage.items()}, "verdict": "blocked", "reason": "2x label path is unavailable"}
    multiples = data.id.astype(str).map(maxima[label_rule])
    data["y"] = np.where(multiples.notna(), multiples.ge(2).astype(float), np.nan)
    data["label_resolved_at"] = data.detected_at + 168 * 60 * 60 * 1000
    folds = walk_forward_splits(data, min_test_rows=20, embargo_hours=168)
    if not folds:
        return {"coverage_pct": {key: value * 100 for key, value in coverage.items()}, "verdict": "not estimable", "reason": "no purged 7-day folds"}
    chart, _ = out_of_fold_predictions(data, folds, FEATURES_WITHOUT_RISK)
    flow, _ = out_of_fold_predictions(data, folds, FLOW_FEATURES)
    combined, _ = out_of_fold_predictions(data, folds, [*FEATURES_WITHOUT_RISK, *FLOW_FEATURES])
    scored = data.copy(); scored["pred_chart"] = chart.pred_logistic; scored["pred_flow"] = flow.pred_logistic; scored["pred_combined"] = combined.pred_logistic
    differences = paired_metric_differences(scored, "pred_combined", "pred_chart", n_boot)
    auc = differences["roc_auc"]
    supported = np.isfinite(auc["ci_low"]) and auc["ci_low"] > 0
    return {"coverage_pct": {key: value * 100 for key, value in coverage.items()}, "folds": len(folds), "auc": {
        "chart": classification_metrics(scored.loc[scored.pred_chart.notna(), "y"], scored.loc[scored.pred_chart.notna(), "pred_chart"])["roc_auc"],
        "flow": classification_metrics(scored.loc[scored.pred_flow.notna(), "y"], scored.loc[scored.pred_flow.notna(), "pred_flow"])["roc_auc"],
        "combined": classification_metrics(scored.loc[scored.pred_combined.notna(), "y"], scored.loc[scored.pred_combined.notna(), "pred_combined"])["roc_auc"],
        "combined_minus_chart": auc}, "verdict": "supported" if supported else "not supported"}


def _matched_rule(frame: pd.DataFrame, matrix: pd.DataFrame, rule: str) -> pd.DataFrame:
    data = frame.loc[frame.id.astype(str).isin(matrix.index), ["id", "source", "chain", "pool", "day"]].copy()
    data["net_return_pct"] = data.id.astype(str).map(matrix[rule])
    blocks = []
    for key, group in data.dropna(subset=["net_return_pct"]).groupby(["chain", "pool", "day"]):
        signal = group.loc[group.source.ne("control"), "net_return_pct"]
        control = group.loc[group.source.eq("control"), "net_return_pct"]
        if len(signal) and len(control):
            blocks.append({"chain": key[0], "pool": key[1], "day": key[2],
                           "pair_day": f"{key[0]}|{key[1]}|{key[2]}",
                           "signal_mean": float(signal.mean()), "control_mean": float(control.mean()),
                           "difference": float(signal.mean() - control.mean())})
    return pd.DataFrame(blocks)


def matched_avoid(frame: pd.DataFrame, legacy_matrix: pd.DataFrame | None,
                  edge_matrix: pd.DataFrame, n_boot: int, permutation_draws: int) -> tuple[dict, pd.DataFrame]:
    established = [f"half_runner|tp5|support|24h|{cost}bps" for cost in [100, 200, 300]]
    if legacy_matrix is None or any(rule not in legacy_matrix for rule in established):
        return {"verdict": "blocked", "reason": "established exit grid unavailable"}, pd.DataFrame()
    records, edge_blocks = [], []
    for family, matrix, rules in [("established", legacy_matrix, established), ("fat_tail", edge_matrix, list(edge_matrix.columns))]:
        for rule in rules:
            matched = _matched_rule(frame, matrix, rule)
            interval = _fast_day_interval(matched, "difference", n_boot) if len(matched) else {"estimate": math.nan, "ci_low": math.nan, "ci_high": math.nan, "blocks": 0, "rows": 0}
            records.append({"family": family, "rule_id": rule, "matched_pair_days": int(len(matched)),
                            "signal_mean": float(matched.signal_mean.mean()) if len(matched) else math.nan,
                            "control_mean": float(matched.control_mean.mean()) if len(matched) else math.nan,
                            "difference": interval["estimate"], "ci_low": interval["ci_low"], "ci_high": interval["ci_high"],
                            "day_blocks": interval["blocks"],
                            "avoided_loss_per_100_stakes": -interval["estimate"] if np.isfinite(interval["estimate"]) else math.nan,
                            "avoided_loss_per_100_buys_at_100_usd": -100 * interval["estimate"] if np.isfinite(interval["estimate"]) else math.nan})
            if family == "fat_tail" and len(matched):
                block = matched[["pair_day", "day", "difference"]].copy(); block["rule_id"] = rule; edge_blocks.append(block)
    table = pd.DataFrame(records)
    base = table.loc[table.rule_id.eq(established[1])].iloc[0]
    fat = table.loc[table.family.eq("fat_tail") & table.ci_high.notna()].copy()
    familywise_p = math.nan; best_rule = None
    if edge_blocks and len(fat):
        long = pd.concat(edge_blocks, ignore_index=True)
        wide = long.pivot(index="pair_day", columns="rule_id", values="difference")
        days = long.drop_duplicates("pair_day").set_index("pair_day").reindex(wide.index).day
        observed = wide.mean(axis=0, skipna=True); best_rule = str(observed.idxmin()); observed_min = float(observed.min())
        unique_days = pd.Index(days.dropna().unique()); rng = np.random.default_rng(SEED); hits = 0
        for _ in range(permutation_draws):
            signs = pd.Series(rng.choice([-1.0, 1.0], size=len(unique_days)), index=unique_days)
            permuted = wide.mul(days.map(signs).to_numpy(), axis=0).mean(axis=0, skipna=True)
            hits += int(float(permuted.min()) <= observed_min)
        familywise_p = (hits + 1) / (permutation_draws + 1)
    edge_supported = bool(len(fat) and (fat.ci_high < 0).any() and np.isfinite(familywise_p) and familywise_p < .05)
    base_supported = bool(np.isfinite(base.ci_high) and base.ci_high < 0)
    estimable = bool(np.isfinite(base.ci_high))
    result = {"rule_id": established[1], "matched_pair_days": int(base.matched_pair_days),
              "difference": {"estimate": float(base.difference), "ci_low": float(base.ci_low),
                             "ci_high": float(base.ci_high), "blocks": int(base.day_blocks)},
              "avoided_loss_per_100_stakes": float(base.avoided_loss_per_100_stakes),
              "avoided_loss_per_100_buys_at_100_usd": float(base.avoided_loss_per_100_buys_at_100_usd),
              "best_fat_tail_rule": best_rule, "familywise_permutation_p": familywise_p,
              "permutation_draws": permutation_draws,
              "verdict": "supported" if base_supported and edge_supported else ("not estimable" if not estimable else "not supported")}
    return result, table


def monte_carlo(values: pd.DataFrame, simulations: int = 10_000) -> pd.DataFrame:
    data = values.dropna(subset=["net_return_pct", "day"])
    if data.empty:
        return pd.DataFrame()
    blocks = [block.net_return_pct.to_numpy(np.float32) for _, block in data.groupby("day")]
    rng = np.random.default_rng(20260905); rows = []
    # Preserve day-block resampling while constructing every 1,000-trade path
    # only once. Bankroll paths are then evaluated in vectorized form.
    sequences = np.empty((simulations, 1000), dtype=np.float32)
    for run in range(simulations):
        cursor = 0
        while cursor < sequences.shape[1]:
            block = blocks[rng.integers(0, len(blocks))]
            count = min(len(block), sequences.shape[1] - cursor)
            sequences[run, cursor:cursor + count] = block[:count]
            cursor += count
    clipped = np.maximum(sequences / 100, -1.0)
    for fraction in [.005, .01, .02, .05]:
        wealth = 1000 * np.cumprod(1 + fraction * clipped, axis=1, dtype=np.float64)
        peaks = np.maximum.accumulate(np.concatenate([np.full((simulations, 1), 1000.0), wealth], axis=1), axis=1)[:, 1:]
        path_drawdowns = 1 - wealth / peaks
        for horizon in [100, 300, 1000]:
            finals = wealth[:, horizon - 1]
            drawdowns = path_drawdowns[:, :horizon].max(axis=1)
            ruined = wealth[:, :horizon].min(axis=1) <= 500
            probability = float(ruined.mean()); se = math.sqrt(probability * (1 - probability) / simulations)
            rows.append({"fraction_pct": fraction * 100, "trades": horizon, "median_final_bankroll": float(np.median(finals)),
                         "p5_final_bankroll": float(np.quantile(finals, .05)), "median_max_drawdown_pct": float(100*np.median(drawdowns)),
                         "p95_max_drawdown_pct": float(100*np.quantile(drawdowns, .95)), "probability_losing_50pct": probability,
                         "probability_losing_50pct_ci_high": min(1.0, probability + 1.96 * se),
                         "survivable": probability + 1.96 * se < .05})
    return pd.DataFrame(rows)


def run_edge_program(frame: pd.DataFrame, edge_path: str | Path, legacy_path: str | Path, metadata_path: str | Path,
                     output_dir: str | Path, bootstrap_scale: float = 1.0, synthetic: bool = False) -> dict:
    metadata = json.loads(Path(metadata_path).read_text()) if Path(metadata_path).exists() else {}
    availability = data_availability(frame, metadata)
    result: dict = {"availability": availability, "verdicts": {"universe_base_rate": "benchmark",
        "fat_tail_exits": "blocked", "pool_age": "blocked", "order_flow": "blocked", "regime": "blocked",
        "avoid_filter": "blocked", "position_sizing": "blocked"}}
    if not Path(edge_path).exists():
        result["reason"] = "edge-exit-grid.csv.gz is unavailable; fetch the Phase 1 release assets"
        return result
    n_boot = 100 if synthetic else max(200, int(2_000 * bootstrap_scale))
    shuffle_draws = 20 if synthetic else 500
    matrix, maxima, configs = load_edge_grid(edge_path)
    overall, by_chain, by_day = base_rate_tables(frame, matrix, configs, n_boot)
    populations = exit_population_table(frame, matrix, configs, n_boot)
    nested = nested_edge_selection(frame, matrix, configs, n_boot, shuffle_draws)
    age_table, age_status, age_descriptive, age_result = pool_age_analysis(frame, matrix, configs, nested, n_boot)
    flow = flow_analysis(frame, maxima, nested, n_boot)
    legacy_matrix = load_exit_grid(legacy_path)[0] if Path(legacy_path).exists() else None
    avoid, avoid_table = matched_avoid(frame, legacy_matrix, matrix, n_boot, shuffle_draws)
    controls = nested["controls"]
    if controls.empty and REFERENCE_EDGE_RULE in matrix:
        controls = frame.loc[frame.source.eq("control")].copy(); controls["net_return_pct"] = controls.id.astype(str).map(matrix[REFERENCE_EDGE_RULE])
    sizing = monte_carlo(controls, simulations=200 if synthetic else 10_000)
    output = Path(output_dir); output.mkdir(parents=True, exist_ok=True)
    overall.to_csv(output / "phase1_base_rate.csv", index=False)
    by_chain.to_csv(output / "phase1_base_rate_by_chain.csv", index=False)
    by_day.to_csv(output / "phase1_base_rate_by_day.csv", index=False)
    populations.to_csv(output / "phase1_fat_tail_populations.csv", index=False)
    age_descriptive.to_csv(output / "phase1_pool_age.csv", index=False)
    avoid_table.to_csv(output / "phase1_avoid_filter.csv", index=False)
    sizing.to_csv(output / "phase1_position_sizing.csv", index=False)
    result.update(base_rate=overall, base_rate_by_chain=by_chain, base_rate_by_day=by_day,
                  exit_populations=populations, path_coverage=metadata.get("path_coverage", {}), nested=nested,
                  pool_age_table=age_table, pool_age_status=age_status, pool_age_results=age_descriptive,
                  pool_age=age_result, order_flow=flow, avoid_filter_table=avoid_table,
                  regime={"verdict": "blocked", "reason": "major-asset candles and point-in-time universe breadth are absent"},
                  avoid_filter=avoid, position_sizing=sizing)
    result["verdicts"].update(fat_tail_exits=nested["verdict"], pool_age=age_result["verdict"], order_flow=flow["verdict"],
                              avoid_filter=avoid["verdict"], position_sizing="descriptive" if len(sizing) else "blocked")
    return result


def _ci(value: dict) -> str:
    low, high, blocks = value.get("ci_low", math.nan), value.get("ci_high", math.nan), value.get("blocks", 0)
    if not np.isfinite(low) or not np.isfinite(high) or np.isclose(low, high):
        return f"not estimable ({blocks} blocks)"
    return f"[{low:.3f}, {high:.3f}]"


def _estimate(value: object, suffix: str = "") -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return "not estimable"
    return f"{numeric:.3f}{suffix}" if np.isfinite(numeric) else "not estimable"


def _md(frame: pd.DataFrame, digits: int = 3) -> str:
    if frame is None or frame.empty:
        return "_No estimable rows._"
    printable = frame.reset_index(drop=True).copy()
    for column in printable.select_dtypes(include=["number"]).columns:
        printable[column] = printable[column].map(lambda value: "NA" if not np.isfinite(value) else f"{value:.{digits}f}")
    headers = [str(column) for column in printable.columns]
    rows = [[str(value) for value in row] for row in printable.itertuples(index=False, name=None)]
    return "\n".join(["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |",
                      *["| " + " | ".join(row) + " |" for row in rows]])


def render_edge_program(result: dict) -> str:
    availability = result["availability"].reset_index()
    if "base_rate" not in result:
        return ("\n## 14. Memecoin edge program: Phase 1\n\n"
                f"**Blocked.** {result.get('reason', 'Required release artifacts are unavailable.')} "
                "The data audit still runs, and no missing field is fabricated.\n\n### Data availability audit\n\n"
                f"{_md(availability, 1)}")
    base = result["base_rate"]
    base_200 = base.loc[base.cost_bps.eq(200)].copy()
    headline = (base_200.sort_values("mean", ascending=False)
                .groupby(["structure", "time_hours"], as_index=False).first()
                [["structure", "time_hours", "rule_id", "trades", "mean", "median", "p5", "p95", "p99", "share_ge_2x", "share_ge_5x", "share_ge_10x", "mean_without_top_1pct", "ci_low", "ci_high"]])
    nested = result["nested"]
    reference_populations = result["exit_populations"]
    reference_populations = reference_populations.loc[reference_populations.rule_id.eq(REFERENCE_EDGE_RULE),
        ["population", "trades", "mean", "median", "p5", "p95", "p99", "share_ge_2x", "share_ge_5x", "share_ge_10x", "mean_without_top_1pct", "ci_low", "ci_high", "day_blocks"]]
    path_coverage = result.get("path_coverage", {})
    nested_text = (f"Nested 7-day-purged folds: **{nested['folds']}**; eligible fold choices: **{len(nested['choices'])}**. "
                   f"Signal expectancy **{_estimate(nested['signal_expectancy']['estimate'], '%')}**, CI {_ci(nested['signal_expectancy'])}; "
                   f"signal-minus-control **{_estimate(nested['difference']['estimate'], ' points')}**, CI {_ci(nested['difference'])}. "
                   f"Verdict: **{nested['verdict']}**.")
    age = result["pool_age"]
    flow = result["order_flow"]
    avoid = result["avoid_filter"]
    sizing = result["position_sizing"]
    age_reference = result["pool_age_results"]
    age_reference = age_reference.loc[age_reference.rule_id.eq(REFERENCE_EDGE_RULE),
                                      ["age_bucket", "population", "trades", "mean", "median", "share_ge_2x", "ci_low", "ci_high", "day_blocks"]]
    avoid_compact = result["avoid_filter_table"]
    if len(avoid_compact):
        established = avoid_compact.loc[avoid_compact.family.eq("established")]
        best = avoid_compact.loc[avoid_compact.rule_id.eq(avoid.get("best_fat_tail_rule"))]
        avoid_compact = pd.concat([established, best], ignore_index=True)[["family", "rule_id", "matched_pair_days", "signal_mean", "control_mean", "difference", "ci_low", "ci_high", "day_blocks"]]
    verdict_rows = [
        {"hypothesis": "Universe base rate", "result": "fixed benchmark", "CI": "see full base-rate CSV", "verdict": "benchmark"},
        {"hypothesis": "Fat-tail exits", "result": _estimate(nested["signal_expectancy"]["estimate"]), "CI": _ci(nested["signal_expectancy"]), "verdict": nested["verdict"]},
        {"hypothesis": "Pool age", "result": age.get("reason", "bucket comparison"), "CI": "not estimable", "verdict": age["verdict"]},
        {"hypothesis": "Order flow", "result": flow.get("reason", "combined vs chart"), "CI": "not estimable" if "auc" not in flow else str(flow["auc"]["combined_minus_chart"]), "verdict": flow["verdict"]},
        {"hypothesis": "Market regime", "result": result["regime"]["reason"], "CI": "not estimable", "verdict": "blocked"},
        {"hypothesis": "Signal as AVOID", "result": avoid.get("difference", {}).get("estimate", math.nan), "CI": _ci(avoid.get("difference", {})), "verdict": avoid["verdict"]},
        {"hypothesis": "Position sizing", "result": "universe control resampling", "CI": "Monte Carlo", "verdict": result["verdicts"]["position_sizing"]},
    ]
    return f"""
## 14. Memecoin edge program: Phase 1

All hypotheses were preregistered in `research/ml/preregistration/` before this analysis commit. The complete base-rate tables are committed as `phase1_base_rate.csv`, `phase1_base_rate_by_chain.csv`, and `phase1_base_rate_by_day.csv`; the table below shows the best universe-control rule within each structure/time group at 200 bps for compactness. Every headline strategy comparison is out of sample or explicitly labeled not estimable.

### 14.0 Data availability audit

{_md(availability, 1)}

Pool age, discovery counts, volume, and discovery liquidity come from the point-in-time candidate stored with each observation. FDV, market cap, and GoPlus evidence are signal-only and cannot be generalized to controls. Wallet events are counted only; addresses remain excluded. Major-asset candles are absent.

### 14.1 Universe base rate

{_md(headline)}

The full by-chain and by-day distributions include mean, median, p5–p99, and shares reaching 2×, 5×, and 10× for every rule and cost assumption.

**Coverage warning:** these distributions include resolved exits only. Because only **{path_coverage.get('complete_24h_pct', math.nan):.1f}%** of observations have a complete 24h path, **{path_coverage.get('complete_72h_pct', math.nan):.1f}%** have a complete 72h path, and **{path_coverage.get('complete_168h_pct', math.nan):.1f}%** have a complete 7d path, longer-horizon rows disproportionately contain early stops and trails. They are a right-censored benchmark, not a complete-horizon estimate.

### 14.2 Let winners run

{nested_text}

Forward-path coverage from the export: **{path_coverage.get('path_present_pct', math.nan):.1f}%** have at least one next bar; complete 24h paths **{path_coverage.get('complete_24h_pct', math.nan):.1f}%**, complete 72h paths **{path_coverage.get('complete_72h_pct', math.nan):.1f}%**, and complete 7d paths **{path_coverage.get('complete_168h_pct', math.nan):.1f}%**. Early stop/trail exits remain resolved even when the full time-exit horizon is not yet complete; surviving incomplete paths remain unresolved.

In-sample searched cells: **{nested['eligible_cells']}**; positive cells: **{nested['positive_cells']}**. The within-day permutation best-cell exceedance rate was **{nested['shuffle'].get('best_cell_fraction', math.nan):.3f}**. Expectancy without the top 1% is reported for every base-rate rule, exposing dependence on rare winners.

The locked 7d reference rule below is descriptive; `phase1_fat_tail_populations.csv` contains both populations under every prespecified rule.

{_md(reference_populations)}

### 14.3 Pool age

Pool-age coverage: **{age.get('coverage_pct', math.nan):.1f}%**. Verdict: **{age['verdict']}** — {age.get('reason', 'see bucket results')}.

{_md(result['pool_age_table'])}

The table below uses the locked `fixed20 + 40% trail + 7d + 200 bps` reference rule. `phase1_pool_age.csv` contains every prespecified rule, cost, source, and age bucket.

{_md(age_reference)}

Known GoPlus status mix by age bucket (signal/alert rows only):

{_md(result['pool_age_status'], 1)}

GoPlus status is sparse signal-only evidence. Candle paths contain OHLCV but no liquidity history, so the preregistered liquidity-collapse override is blocked rather than approximated from price.

### 14.4 Order-flow features

Coverage: `{json.dumps(flow.get('coverage_pct', {}), sort_keys=True)}`. Verdict: **{flow['verdict']}** — {flow.get('reason', 'see AUC comparison')}.

### 14.5 Regime baseline

**Blocked on Phase 2.** {result['regime']['reason']}.

### 14.6 Signal as an avoid filter

Matched pair-days: **{avoid.get('matched_pair_days', 0)}**. Signal-minus-control return: **{avoid.get('difference', {}).get('estimate', math.nan):.3f} points**, CI {_ci(avoid.get('difference', {}))}. Estimated prevented loss per 100 $100 buys: **${avoid.get('avoided_loss_per_100_buys_at_100_usd', math.nan):.2f}**. Verdict: **{avoid['verdict']}**. This is recommendation-only; live behavior is unchanged.

{_md(avoid_compact)}

The best observed fat-tail warning rule after searching the prespecified grid was `{avoid.get('best_fat_tail_rule')}`; the day-level sign-flip family-wise permutation p-value was **{avoid.get('familywise_permutation_p', math.nan):.3f}** across **{avoid.get('permutation_draws', 0)}** draws. `phase1_avoid_filter.csv` contains every rule. A negative point estimate alone does not support an avoid rule.

### 14.7 Position sizing and risk of ruin

{_md(sizing)}

With fat-tailed returns, sizing controls whether the bankroll survives long enough to encounter rare winners. These simulations use day-block resampling of the resolved, right-censored reference-rule returns and are descriptive stress tests, not evidence that the underlying strategy has an edge or a complete estimate of risk.

### Phase 1 verdicts

{_md(pd.DataFrame(verdict_rows))}
"""
