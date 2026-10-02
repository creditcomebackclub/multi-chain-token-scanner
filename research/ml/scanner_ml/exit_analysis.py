from __future__ import annotations

from pathlib import Path
import numpy as np
import pandas as pd

from . import SEED
from .data import FEATURES_WITHOUT_RISK

MIN_TRAIN_TRADES = 10


def load_exit_grid(path: str | Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    path = Path(path)
    columns = ["id", "rule_id", "structure", "tp1_pct", "stop", "time_hours", "cost_bps", "net_return_pct", "resolved"]
    grid = pd.read_csv(path, usecols=columns, dtype={"id": "category", "rule_id": "category", "structure": "category", "stop": "category"})
    grid["net_return_pct"] = pd.to_numeric(grid["net_return_pct"], errors="coerce")
    if grid["resolved"].dtype != bool:
        grid["resolved"] = grid["resolved"].astype("string").str.lower().eq("true")
    grid.loc[~grid["resolved"], "net_return_pct"] = np.nan
    configs = grid.drop_duplicates("rule_id")[["rule_id", "structure", "tp1_pct", "stop", "time_hours", "cost_bps"]].copy()
    configs["rule_id"] = configs["rule_id"].astype(str)
    matrix = grid.pivot(index="id", columns="rule_id", values="net_return_pct").astype("float32")
    matrix.index = matrix.index.astype(str); matrix.columns = matrix.columns.astype(str)
    return matrix, configs.set_index("rule_id").sort_index()


def _interval(values: pd.DataFrame, column: str, n_boot: int, transform=lambda x: x) -> dict:
    data = values.dropna(subset=[column, "day"])
    blocks = int(data["day"].nunique())
    estimate = float(transform(data[column]).mean()) if len(data) else np.nan
    result = {"estimate": estimate, "ci_low": np.nan, "ci_high": np.nan, "blocks": blocks, "rows": int(len(data))}
    if blocks < 3 or len(data) < 5:
        return result
    grouped = [block for _, block in data.groupby("day")]
    rng = np.random.default_rng(SEED)
    draws = []
    for _ in range(n_boot):
        sample = pd.concat([grouped[i] for i in rng.integers(0, blocks, blocks)], ignore_index=True)
        draws.append(float(transform(sample[column]).mean()))
    result.update(ci_low=float(np.quantile(draws, .025)), ci_high=float(np.quantile(draws, .975)))
    return result


def _difference(left: pd.DataFrame, right: pd.DataFrame, column: str, n_boot: int, transform=lambda x: x) -> dict:
    l = left.dropna(subset=[column]).groupby("day")[column].apply(lambda x: float(transform(x).mean()))
    r = right.dropna(subset=[column]).groupby("day")[column].apply(lambda x: float(transform(x).mean()))
    paired = pd.concat([l.rename("left"), r.rename("right")], axis=1).dropna()
    blocks = len(paired); estimate = float(left[column].pipe(transform).mean() - right[column].pipe(transform).mean()) if len(left) and len(right) else np.nan
    result = {"estimate": estimate, "ci_low": np.nan, "ci_high": np.nan, "blocks": blocks}
    if blocks < 3:
        return result
    rng = np.random.default_rng(SEED); draws = []
    for _ in range(n_boot):
        sample = paired.iloc[rng.integers(0, blocks, blocks)]
        draws.append(float((sample.left - sample.right).mean()))
    result.update(ci_low=float(np.quantile(draws, .025)), ci_high=float(np.quantile(draws, .975)))
    return result


def _population_summary(rows: pd.DataFrame, n_boot: int) -> dict:
    expectancy = _interval(rows, "net_return_pct", n_boot)
    win_rate = _interval(rows, "net_return_pct", n_boot, lambda values: values > 0)
    return {"trades": int(rows["net_return_pct"].notna().sum()), "expectancy": expectancy, "win_rate": win_rate}


def most_risk_correlated_features(frame: pd.DataFrame, folds, count: int = 3) -> tuple[list[str], list[str], dict[str, float]]:
    if not folds:
        return [], FEATURES_WITHOUT_RISK, {}
    training = frame.loc[folds[0].train]
    correlations = training[["riskPct", *FEATURES_WITHOUT_RISK]].corr(method="spearman")["riskPct"].drop("riskPct").abs().dropna().sort_values(ascending=False)
    excluded = correlations.head(count).index.tolist()
    return excluded, [feature for feature in FEATURES_WITHOUT_RISK if feature not in excluded], correlations.to_dict()


def _shuffle_test(frame: pd.DataFrame, matrix: pd.DataFrame, signal_ids: list[str], observed_positive: int, observed_best: float, draws: int = 500) -> dict:
    common = frame.loc[frame.id.astype(str).isin(matrix.index)].copy()
    common["matrix_pos"] = common.id.astype(str).map({key: pos for pos, key in enumerate(matrix.index)})
    signal = set(signal_ids); groups = []
    for _, block in common.groupby("day"):
        positions = block.matrix_pos.astype(int).to_numpy(); count = int(block.id.astype(str).isin(signal).sum())
        if count:
            groups.append((positions, count))
    values = matrix.to_numpy(dtype=np.float32, copy=False); rng = np.random.default_rng(SEED)
    positive_hits = 0; best_hits = 0; positive_total = 0
    for _ in range(draws):
        chosen = np.concatenate([rng.choice(positions, size=count, replace=False) for positions, count in groups])
        means = np.nanmean(values[chosen], axis=0)
        positive_count = int(np.sum(means > 0)); positive_total += positive_count
        positive_hits += int(positive_count >= observed_positive)
        best_hits += int(np.nanmax(means) >= observed_best)
    return {"draws": draws, "positive_cell_p_value": positive_hits / draws,
            "expected_positive_cell_fraction": positive_total / (draws * matrix.shape[1]), "best_cell_fraction": best_hits / draws}


def analyze_exit_grid(frame: pd.DataFrame, folds, no_risk_oof: pd.DataFrame, pruned_oof: pd.DataFrame,
                      grid_path: str | Path, n_boot: int = 2_000, shuffle_draws: int = 500) -> dict | None:
    if not Path(grid_path).exists() or not folds:
        return None
    matrix, configs = load_exit_grid(grid_path)
    frame = frame.copy(); frame["id"] = frame.id.astype(str)
    signal_mask = frame.source.ne("control")
    signal_ids = frame.loc[signal_mask & frame.id.isin(matrix.index), "id"].tolist()
    in_sample = matrix.reindex(signal_ids)
    counts = in_sample.count(); means = in_sample.mean(); eligible = means[counts >= MIN_TRAIN_TRADES]
    positive_cells = int((eligible > 0).sum())
    best_rule = str(eligible.idxmax()) if len(eligible) else None
    best_mean = float(eligible.max()) if len(eligible) else np.nan

    fold_records = []; population_rows: dict[str, list[pd.DataFrame]] = {name: [] for name in ["signals", "controls", "logistic_top_decile", "hgb_top_decile", "pruned_logistic_top_decile", "pruned_hgb_top_decile"]}
    for fold in folds:
        train = frame.loc[fold.train]; test = frame.loc[fold.test]
        train_ids = train.loc[train.source.ne("control") & train.id.isin(matrix.index), "id"].tolist()
        train_values = matrix.reindex(train_ids); train_counts = train_values.count(); train_means = train_values.mean(); candidates = train_means[train_counts >= MIN_TRAIN_TRADES]
        if candidates.empty:
            continue
        chosen = str(candidates.idxmax())
        fold_records.append({"fold": fold.number, "rule_id": chosen, "train_trades": int(train_counts[chosen]), "train_expectancy_pct": float(candidates[chosen])})
        test = test.loc[test.id.isin(matrix.index)].copy(); test["net_return_pct"] = test.id.map(matrix[chosen])
        population_rows["signals"].append(test.loc[test.source.ne("control")])
        controls = test.loc[test.source.eq("control")].copy(); population_rows["controls"].append(controls)
        for model, output, label in [("logistic", no_risk_oof, "logistic_top_decile"), ("hgb", no_risk_oof, "hgb_top_decile"), ("logistic", pruned_oof, "pruned_logistic_top_decile"), ("hgb", pruned_oof, "pruned_hgb_top_decile")]:
            score = f"pred_{model}"
            scored = controls.copy(); scored["score"] = output.reindex(scored.index)[score]
            scored = scored.dropna(subset=["score"])
            if len(scored): population_rows[label].append(scored.loc[scored.score >= scored.score.quantile(.9)])

    fold_table = pd.DataFrame(fold_records)
    populations = {name: pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=[*frame.columns, "net_return_pct"]) for name, parts in population_rows.items()}
    summaries = {name: _population_summary(rows, n_boot) for name, rows in populations.items()}
    nested = populations["signals"]
    nested_summary = summaries["signals"]
    optimism = best_mean - nested_summary["expectancy"]["estimate"] if np.isfinite(best_mean) and np.isfinite(nested_summary["expectancy"]["estimate"]) else np.nan
    comparisons = {}
    for name in ["controls", "logistic_top_decile", "hgb_top_decile", "pruned_logistic_top_decile", "pruned_hgb_top_decile"]:
        comparisons[name] = {
            "expectancy_signal_minus_population": _difference(nested, populations[name], "net_return_pct", n_boot),
            "win_rate_signal_minus_population": _difference(nested, populations[name], "net_return_pct", n_boot, lambda values: values > 0),
        }
    shuffle = _shuffle_test(frame, matrix, signal_ids, positive_cells, best_mean, shuffle_draws) if best_rule else {}
    best_config = configs.loc[best_rule].to_dict() if best_rule else {}
    regime = {"status": "skipped", "reason": "The committed path export contains watched token-pair candles only; it has no SOL, ETH, or BNB major-asset candle series. No external data was fetched."}
    return {"cells": int(len(configs)), "minimum_training_trades": MIN_TRAIN_TRADES, "positive_in_sample_cells": positive_cells,
            "best_in_sample_rule": best_rule, "best_in_sample_config": best_config, "best_in_sample_expectancy_pct": best_mean,
            "nested_oos": nested_summary, "optimism_gap_pct": optimism, "fold_choices": fold_table,
            "populations": summaries, "comparisons": comparisons, "shuffle": shuffle, "regime": regime}
