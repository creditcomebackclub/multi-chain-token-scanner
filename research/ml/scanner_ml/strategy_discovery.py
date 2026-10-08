"""Bounded, offline search over the separately registered FOMO candidates."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from .data import FEATURES_WITHOUT_RISK

SEED = 20261007
HOUR = 3_600_000
BAR = 300_000
EXITS = ("scalp", "runner", "trail")
PATTERNS = ("support_reclaim", "trend_pullback", "volume_ignition", "return_ranked_ml")
CANDIDATES = tuple(f"{pattern}|{exit}" for pattern in PATTERNS for exit in EXITS)
DEVELOPMENT_END = pd.Timestamp("2026-10-03", tz="UTC")


def prepare(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    for column in [*FEATURES_WITHOUT_RISK, "riskPct", "detected_at", "entry_price", "support_anchor"]:
        result[column] = pd.to_numeric(result[column], errors="coerce").replace([np.inf, -np.inf], np.nan)
    result["id"] = result.id.astype(str)
    result["day"] = pd.to_datetime(result.detected_at, unit="ms", utc=True).dt.floor("D")
    result["anchored"] = result.support_anchor.notna()
    result["group"] = result.chain.astype(str) + "|" + result.token.astype(str) + "|" + result.support_anchor.astype(str)
    result.loc[~result.anchored, "group"] = result.loc[~result.anchored, "id"]
    result["eligible"] = result.atrPct.gt(0) & result.atrPct.le(8) & result.entry_price.gt(0)
    result["green"] = result.bodyPct.gt(0) & (result.closePosition - result.lowerWickPct - result.bodyPct).abs().le(1e-6)
    return result.sort_values(["detected_at", "id"]).reset_index(drop=True)


def pattern_masks(frame: pd.DataFrame) -> dict[str, pd.Series]:
    base = frame.eligible & frame.green
    return {
        "support_reclaim": base & frame.lowerWickPct.ge(.20) & frame.closePosition.ge(.70)
        & frame.volumeRatio.ge(1.2) & frame.ema9SlopePct.gt(0) & frame.priceToEma9Pct.between(0, 2)
        & frame.ema9ToEma21Pct.ge(0) & frame.supportTestCount.ge(2) & frame.riskPct.gt(0) & frame.riskPct.le(5),
        "trend_pullback": base & frame.closePosition.ge(.65) & frame.priceToSma50Pct.gt(0)
        & frame.ema21SlopePct.gt(0) & frame.ema9ToEma21Pct.gt(0) & frame.priceToEma9Pct.between(0, 2)
        & frame.volumeRatio.ge(1) & frame.priorPeakDrawdownPct.between(-20, -4),
        "volume_ignition": base & frame.bodyPct.ge(.50) & frame.closePosition.ge(.80)
        & frame.volumeRatio.ge(2) & frame.ema9SlopePct.gt(0) & frame.ema21SlopePct.ge(0)
        & frame.ema9ToEma21Pct.abs().le(1) & frame.priceToEma9Pct.between(0, 3)
        & frame.priorPeakDrawdownPct.ge(-20),
    }


def first_per_token_day(frame: pd.DataFrame) -> pd.DataFrame:
    # Choose before looking at resolution, profit, or eventual sellability.
    return frame.sort_values(["detected_at", "id"]).drop_duplicates(["chain", "token", "day"], keep="first")


def prior_training(frame: pd.DataFrame, test: pd.DataFrame) -> pd.DataFrame:
    if test.empty:
        return frame.iloc[:0].copy()
    start = test.day.min().value / 1_000_000
    groups = set(test.loc[test.anchored, "group"])
    return frame.loc[
        frame.eligible
        & frame.detected_at.lt(start - 6*HOUR) & frame.exit_at.lt(start)
        & ~frame.group.isin(groups)
    ].copy()


def fit_return_model(train: pd.DataFrame):
    training = first_per_token_day(train)
    training = training.loc[training.resolved & training.net_return_pct.notna()]
    if len(training) < 30 or training.day.nunique() < 3:
        return None
    model = Pipeline([
        ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
        ("scale", StandardScaler()),
        ("ridge", Ridge(alpha=10)),
    ])
    weights = 1 / training.groupby("day").id.transform("count")
    model.fit(training[FEATURES_WITHOUT_RISK], training.net_return_pct, ridge__sample_weight=weights.to_numpy())
    return model


def oof_scores(frame: pd.DataFrame) -> pd.Series:
    scores = pd.Series(np.nan, index=frame.index)
    for _, test in frame.groupby("day", sort=True):
        model = fit_return_model(prior_training(frame, test))
        if model is not None:
            scores.loc[test.index] = model.predict(test[FEATURES_WITHOUT_RISK])
    return scores


def candidate_rows(frame: pd.DataFrame, pattern: str, scores: pd.Series | None = None) -> pd.DataFrame:
    if pattern == "return_ranked_ml":
        selected = frame.eligible & scores.reindex(frame.index).gt(0) if scores is not None else pd.Series(False, index=frame.index)
    elif pattern == "baseline":
        selected = frame.eligible
    else:
        selected = pattern_masks(frame)[pattern]
    return first_per_token_day(frame.loc[selected]).copy()


def mean_interval(rows: pd.DataFrame, samples: int = 2000, seed: int = SEED) -> dict:
    data = rows.loc[rows.resolved & rows.net_return_pct.notna()]
    grouped = data.groupby("day").net_return_pct.agg(["sum", "count"])
    estimate = float(data.net_return_pct.mean()) if len(data) else math.nan
    result = {"estimate": estimate, "blocks": len(grouped), "trades": len(data), "ci": None}
    if len(grouped) < 3 or len(data) < 5:
        return result
    rng = np.random.default_rng(seed)
    chosen = rng.integers(0, len(grouped), (samples, len(grouped)))
    values = grouped["sum"].to_numpy()[chosen].sum(axis=1) / grouped["count"].to_numpy()[chosen].sum(axis=1)
    low, high = np.quantile(values, [.025, .975])
    if not np.isclose(low, high, atol=1e-12, rtol=0):
        result["ci"] = [float(low), float(high)]
    return result


def paired_difference(left: pd.DataFrame, right: pd.DataFrame, samples: int = 2000) -> dict:
    l = left.loc[left.resolved & left.net_return_pct.notna()].groupby("day").net_return_pct.agg(["sum", "count"])
    r = right.loc[right.resolved & right.net_return_pct.notna()].groupby("day").net_return_pct.agg(["sum", "count"])
    paired = l.join(r, lsuffix="_l", rsuffix="_r", how="inner")
    result = {"estimate": math.nan, "blocks": len(paired),
              "trades": int(min(paired.count_l.sum(), paired.count_r.sum())), "ci": None}
    if paired.empty:
        return result
    result["estimate"] = float(paired.sum_l.sum()/paired.count_l.sum()-paired.sum_r.sum()/paired.count_r.sum())
    if len(paired) < 3 or min(paired.count_l.sum(), paired.count_r.sum()) < 5:
        return result
    chosen = np.random.default_rng(SEED).integers(0, len(paired), (samples, len(paired)))
    values = paired.sum_l.to_numpy()[chosen].sum(axis=1)/paired.count_l.to_numpy()[chosen].sum(axis=1)
    values -= paired.sum_r.to_numpy()[chosen].sum(axis=1)/paired.count_r.to_numpy()[chosen].sum(axis=1)
    low, high = np.quantile(values, [.025, .975])
    if not np.isclose(low, high, atol=1e-12, rtol=0):
        result["ci"] = [float(low), float(high)]
    return result


def portfolio(rows: pd.DataFrame) -> dict:
    # Allocate and reserve before seeing outcomes. Unresolved fills retain cash
    # until the configured time exit; their unknown P/L is reported separately.
    cash = 1000.0
    active = []
    fills = []
    equity = [1000.0]
    skipped = 0
    for row in rows.sort_values(["entry_at", "id"]).itertuples():
        due = [item for item in active if item[0] <= row.entry_at]
        for item in sorted(due):
            cash += 50 + item[1]
            active.remove(item)
            equity.append(cash + 50*len(active))
        if len(active) >= 3 or cash < 50 or not np.isfinite(row.fill_price):
            skipped += 1
            continue
        pnl = 50*row.net_return_pct/100 if row.resolved and np.isfinite(row.net_return_pct) else 0.0
        cash -= 50
        active.append((row.exit_at, pnl, row.id))
        fills.append(row.id)
    for item in sorted(active):
        cash += 50+item[1]
        active.remove(item)
        equity.append(cash+50*len(active))
    curve = np.asarray(equity)
    drawdown = float(np.max(np.maximum.accumulate(curve)-curve))
    return {"ending_balance": float(cash), "pnl": float(cash-1000), "max_drawdown_usd": drawdown,
            "fills": len(fills), "skipped_capacity_or_fill": skipped, "filled_ids": fills}


def summary(rows: pd.DataFrame, samples: int = 2000) -> dict:
    known = rows.loc[rows.resolved & rows.net_return_pct.notna()]
    values = known.net_return_pct
    wins, losses = values[values > 0], values[values <= 0]
    stress = rows.net_return_pct.where(rows.resolved & rows.net_return_pct.notna(), -100)
    without_best = values.drop(values.idxmax()) if len(values) > 1 else pd.Series(dtype=float)
    return {"attempts": len(rows), "resolved": len(known), "days": int(known.day.nunique()),
            "coverage": float(len(known)/len(rows)) if len(rows) else math.nan,
            "expectancy": mean_interval(rows, samples), "win_rate": float((values > 0).mean()) if len(values) else math.nan,
            "profit_factor": float(wins.sum()/-losses.sum()) if losses.sum() < 0 else math.nan,
            "mean_without_best": float(without_best.mean()) if len(without_best) else math.nan,
            "missing_path_stress_mean": float(stress.mean()) if len(stress) else math.nan,
            "portfolio": portfolio(rows)}


def score_candidates(frames: dict[str, pd.DataFrame]) -> tuple[dict[str, pd.DataFrame], dict[str, pd.Series]]:
    scores = {exit: oof_scores(frame) for exit, frame in frames.items()}
    rows = {f"{pattern}|{exit}": candidate_rows(frame, pattern, scores[exit])
            for exit, frame in frames.items() for pattern in PATTERNS}
    return rows, scores


def choose(rows: dict[str, pd.DataFrame]) -> str | None:
    eligible = []
    for name, trades in rows.items():
        known = trades.loc[trades.resolved & trades.net_return_pct.notna()]
        if len(known) >= 10 and known.day.nunique() >= 3:
            mean = float(known.net_return_pct.mean())
            if mean > 0:
                eligible.append((mean, name))
    return max(eligible, key=lambda pair: (pair[0], pair[1]))[1] if eligible else None


def nested_selection(frames: dict[str, pd.DataFrame], scores: dict[str, pd.Series]) -> tuple[pd.DataFrame, list[dict]]:
    reference = next(iter(frames.values()))
    pieces, choices = [], []
    for day in sorted(reference.day.unique()):
        train_candidates = {}
        for exit, frame in frames.items():
            test = frame.loc[frame.day.eq(day)]
            training = prior_training(frame, test)
            for pattern in PATTERNS:
                train_candidates[f"{pattern}|{exit}"] = candidate_rows(training, pattern, scores[exit])
        winner = choose(train_candidates)
        choices.append({"test_day": str(pd.Timestamp(day).date()), "candidate": winner or "cash"})
        if winner:
            pattern, exit = winner.split("|")
            test = frames[exit].loc[frames[exit].day.eq(day)]
            trades = candidate_rows(test, pattern, scores[exit])
            trades["candidate"] = winner
            pieces.append(trades)
    empty = reference.iloc[:0].copy()
    return (pd.concat(pieces) if pieces else empty), choices


def shuffle_outcomes(frames: dict[str, pd.DataFrame], seed: int) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    reference = next(iter(frames.values()))
    donors = pd.Series(reference.index, index=reference.index)
    for _, block in reference.groupby("day", sort=True):
        donors.loc[block.index] = rng.permutation(block.index)
    result = {}
    for exit, frame in frames.items():
        shuffled = frame.copy()
        source = frame.loc[donors.to_numpy()]
        shuffled["net_return_pct"] = source.net_return_pct.to_numpy()
        shuffled["resolved"] = source.resolved.to_numpy()
        duration = (source.exit_at-source.entry_at).to_numpy()
        shuffled["exit_at"] = shuffled.entry_at+duration
        result[exit] = shuffled
    return result


def permutation_diagnostic(frames: dict[str, pd.DataFrame], real_rows: dict[str, pd.DataFrame], selected: pd.DataFrame,
                           draws: int = 200) -> dict:
    observed = max((float(r.loc[r.resolved].net_return_pct.mean()) for r in real_rows.values()
                    if r.resolved.sum() >= 10 and r.loc[r.resolved].day.nunique() >= 3), default=math.nan)
    observed_nested = float(selected.loc[selected.resolved].net_return_pct.mean()) if len(selected) else math.nan
    maxima, nested_means = [], []
    for number in range(draws):
        null = shuffle_outcomes(frames, SEED+number)
        candidates, scores = score_candidates(null)
        maximum = max((float(r.loc[r.resolved].net_return_pct.mean()) for r in candidates.values()
                       if r.resolved.sum() >= 10 and r.loc[r.resolved].day.nunique() >= 3), default=math.nan)
        nested, _ = nested_selection(null, scores)
        maxima.append(maximum)
        nested_means.append(float(nested.loc[nested.resolved].net_return_pct.mean()) if len(nested) else math.nan)
        if (number+1) % 25 == 0:
            print(f"Permutation checks: {number+1}/{draws}", file=sys.stderr, flush=True)
    max_values = np.asarray(maxima); max_values = max_values[np.isfinite(max_values)]
    nested_values = np.asarray(nested_means); nested_values = nested_values[np.isfinite(nested_values)]
    return {"draws": draws, "observed_best_mean": observed, "finite_max_draws": len(max_values),
            "familywise_p": float((1+(max_values >= observed).sum())/(1+len(max_values))) if np.isfinite(observed) and len(max_values) else math.nan,
            "observed_nested_mean": observed_nested, "finite_nested_draws": len(nested_values),
            "nested_p": float((1+(nested_values >= observed_nested).sum())/(1+len(nested_values))) if np.isfinite(observed_nested) and len(nested_values) else math.nan}


def load_inputs(snapshot: Path, replay: Path) -> tuple[dict[str, pd.DataFrame], dict]:
    meta = json.loads(snapshot.with_name("snapshot.meta.json").read_text())
    if hashlib.sha256(snapshot.read_bytes()).hexdigest() != meta["csv_sha256"]:
        raise ValueError("snapshot SHA-256 mismatch")
    frame = prepare(pd.read_csv(snapshot))
    output = pd.read_csv(replay)
    output["resolved"] = output.resolved.astype(str).str.lower().eq("true")
    cutoff = pd.Timestamp(meta.get("cutoff", meta["exported_at"])).value/1_000_000
    # Both entry sensitivities have the same mature observation population.
    frame = frame.loc[frame.detected_at+BAR+6*HOUR <= cutoff].copy()
    frames = {}
    for delay in [0, 1]:
        for exit in EXITS:
            block = output.loc[output.exit.eq(exit) & output.delay_bars.eq(delay)].rename(columns={"entry_price":"fill_price"})
            frames[f"{exit}:{delay}"] = frame.merge(block.drop(columns=["exit", "delay_bars"]), on="id", how="left", validate="one_to_one").reset_index(drop=True)
            frames[f"{exit}:{delay}"]["resolved"] = frames[f"{exit}:{delay}"].resolved.fillna(False).astype(bool)
    meta = {**meta, "snapshot_file": str(snapshot), "replay_sha256": hashlib.sha256(replay.read_bytes()).hexdigest(), "mature_rows": len(frame)}
    return frames, meta


def confirmation_rows(development: dict[str, pd.DataFrame], test: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    output = {}
    for exit, frame in test.items():
        training = prior_training(development[exit], frame)
        model = fit_return_model(training)
        scores = pd.Series(model.predict(frame[FEATURES_WITHOUT_RISK]), index=frame.index) if model is not None and len(frame) else None
        for pattern in PATTERNS:
            output[f"{pattern}|{exit}"] = candidate_rows(frame, pattern, scores)
    return output


def clean_json(value):
    if isinstance(value, dict): return {str(k): clean_json(v) for k,v in value.items()}
    if isinstance(value, list): return [clean_json(v) for v in value]
    if isinstance(value, (bool, np.bool_)): return bool(value)
    if isinstance(value, (float, np.floating)): return float(value) if np.isfinite(value) else None
    if isinstance(value, (int, np.integer)): return int(value)
    return value


def fmt(value, suffix="", places=2):
    return "NA" if value is None or not np.isfinite(value) else f"{value:.{places}f}{suffix}"


def ci_text(interval: dict) -> str:
    if interval["ci"] is None:
        return f"not estimable ({interval['blocks']} days, {interval['trades']} trades / degenerate)"
    low, high = interval["ci"]
    # More precision avoids making a narrow but nondegenerate CI look zero-width.
    places = 4 if round(low, 2) == round(high, 2) else 2
    return f"[{low:.{places}f}, {high:.{places}f}]"


def table(summaries: dict[str, dict]) -> str:
    rows = ["| Candidate | Attempts / resolved | Days | Net mean | 95% day CI | Win rate | PF | $50-trade account P/L | Without best win | Coverage |",
            "|---|---:|---:|---:|---|---:|---:|---:|---:|---:|"]
    for name, item in summaries.items():
        label = name.replace('|', ' / ')
        rows.append(f"| {label} | {item['attempts']} / {item['resolved']} | {item['days']} | {fmt(item['expectancy']['estimate'],'%')} | {ci_text(item['expectancy'])} | {fmt(item['win_rate']*100,'%')} | {fmt(item['profit_factor'])} | ${item['portfolio']['pnl']:.2f} | {fmt(item['mean_without_best'],'%')} | {fmt(item['coverage']*100,'%')} |")
    return "\n".join(rows)


def run_study(snapshot: Path, replay: Path, out: Path, confirmation_snapshot: Path | None = None,
              confirmation_replay: Path | None = None, samples: int = 2000, permutations: int = 200) -> dict:
    all_frames, metadata = load_inputs(snapshot, replay)
    development = {exit: all_frames[f"{exit}:1"].loc[all_frames[f"{exit}:1"].day.lt(DEVELOPMENT_END)].reset_index(drop=True) for exit in EXITS}
    candidates, scores = score_candidates(development)
    selected, choices = nested_selection(development, scores)
    frozen = choose(candidates)
    summaries = {name: summary(rows, samples) for name, rows in candidates.items()}
    baseline = {exit: candidate_rows(frame,"baseline") for exit,frame in development.items()}
    null = permutation_diagnostic(development,candidates,selected,permutations)
    confirmation_metadata = None
    confirm, confirm_frames = {}, {}
    if confirmation_snapshot and confirmation_replay:
        fresh, confirmation_metadata = load_inputs(confirmation_snapshot, confirmation_replay)
        confirm_frames = {exit: fresh[f"{exit}:1"].loc[fresh[f"{exit}:1"].day.ge(DEVELOPMENT_END)].reset_index(drop=True) for exit in EXITS}
        confirm = confirmation_rows(development, confirm_frames)
    confirmation_summary = {name:summary(rows,samples) for name,rows in confirm.items()}
    sensitivities = []
    for delay in [0,1]:
        frames = {exit:all_frames[f"{exit}:{delay}"].loc[all_frames[f"{exit}:{delay}"].day.lt(DEVELOPMENT_END)].reset_index(drop=True) for exit in EXITS}
        for cost in [100,200,300]:
            changed_frames = {exit: frame.assign(net_return_pct=frame.gross_return_pct-cost/100)
                              for exit, frame in frames.items()}
            populations,_ = score_candidates(changed_frames)
            for name,rows in populations.items():
                result=summary(rows,samples)
                sensitivities.append({"candidate":name,"delay_minutes":delay*5,"cost_bps":cost,"mean":result['expectancy']['estimate'],"resolved":result['resolved']})
    comparisons = {}
    for name,rows in candidates.items():
        exit=name.split('|')[1]
        keys=set(zip(rows.chain,rows.token,rows.day))
        matched=baseline[exit].loc[[key in keys for key in zip(baseline[exit].chain,baseline[exit].token,baseline[exit].day)]]
        comparisons[name]=paired_difference(rows,matched,samples)
    frozen_summary = confirmation_summary.get(frozen) if frozen else None
    worth_testing = False
    if frozen_summary and frozen_summary['resolved']:
        frozen_rows=confirm[frozen];exit=frozen.split('|')[1]
        comparator=candidate_rows(confirm_frames[exit],'baseline')
        keys=set(zip(frozen_rows.chain,frozen_rows.token,frozen_rows.day))
        comparator=comparator.loc[[key in keys for key in zip(comparator.chain,comparator.token,comparator.day)]]
        difference=paired_difference(frozen_rows,comparator,samples)
        comparisons['frozen_confirmation']=difference
        worth_testing=bool(frozen_summary['expectancy']['estimate']>1 and difference['estimate']>0
                           and frozen_summary['mean_without_best']>0)
    result = {"registration":"fomo-strategy-discovery-v1","metadata":metadata,"confirmation_metadata":confirmation_metadata,
              "candidate_count":len(CANDIDATES),"development":summaries,"baselines":{exit:summary(rows,samples) for exit,rows in baseline.items()},
              "nested":summary(selected,samples),"choices":choices,"frozen_candidate":frozen,
              "confirmation":confirmation_summary,"comparisons":comparisons,"sensitivity":sensitivities,"permutation":null,
              "worth_prospective_testing":worth_testing,"live_promotable":False}
    out.mkdir(parents=True,exist_ok=True)
    pieces=[]
    for population,groups in [('development',candidates),('confirmation',confirm)]:
        for name,rows in groups.items():
            exported=rows[['id','day','chain','token','detected_at','entry_at','fill_price','exit_at','exit_reason','resolved','net_return_pct']].copy()
            exported['candidate']=name;exported['population']=population;pieces.append(exported)
    if pieces:pd.concat(pieces).to_csv(out/'trades.csv',index=False)
    (out/'results.json').write_text(json.dumps(clean_json(result),indent=2,allow_nan=False)+'\n')
    (out/'candidate.json').write_text(json.dumps({"strategy":frozen,"status":"research candidate" if frozen else "cash; no eligible positive candidate",
        "worth_prospective_testing":worth_testing,"alerts_enabled":False,"registration":"fomo-strategy-discovery-v1",
        "minimum_forward_trades":100,"minimum_forward_days":20,"primary_delay_minutes":5,"modeled_round_trip_cost_bps":200,
        "development_snapshot_sha256":metadata['csv_sha256'],"development_replay_sha256":metadata['replay_sha256'],
        "registration_sha256":hashlib.sha256((Path(__file__).parents[1]/'preregistration/fomo-strategy-discovery-v1.md').read_bytes()).hexdigest(),
        "model_features":FEATURES_WITHOUT_RISK,"ridge_alpha":10},indent=2)+'\n')
    sensitivity_rows=['| Candidate | Delay | 100bps | 200bps | 300bps |','|---|---:|---:|---:|---:|']
    for name in CANDIDATES:
        for delay in [0,5]:
            values=[next(item['mean'] for item in sensitivities if item['candidate']==name and item['delay_minutes']==delay and item['cost_bps']==cost) for cost in [100,200,300]]
            sensitivity_rows.append(f"| {name.replace('|', ' / ')} | {delay}m | "+' | '.join(fmt(value,'%') for value in values)+' |')
    selected_summary=result['nested']
    comparison_rows=['| Candidate | Difference vs matched baseline | 95% day CI |', '|---|---:|---|']
    for name, interval in comparisons.items():
        comparison_rows.append(f"| {name.replace('|', ' / ')} | {fmt(interval['estimate'],'pp')} | {ci_text(interval)} |")
    report=f"""# Focused FOMO strategy discovery v1

**Retrospective research; modeled fills and costs. No validated BUY strategy or live change.**

## Decision

Frozen development candidate: **{frozen or 'none; cash'}**. Worth prospective testing under the registered confirmation criterion: **{'yes' if worth_testing else 'no / confirmation unavailable'}**. Twelve prespecified candidates were tested; none can be promoted without the separately required fresh execution and forward evidence.

## Development: reused published snapshot

Primary entry waits a full five-minute bar and uses that bar's open. Costs are 200bps round trip. One attempt per token per UTC day is chosen before inspecting the result. The same selected-pair universe and filters apply to every candidate. This historical sample has already been used for earlier research and is not pristine out-of-sample evidence.

{table(summaries)}

## Eligible-candle baselines

These take the first eligible candle per token/day, with the same delay and exits. They describe this selected-pair universe rather than the whole market.

{table(result['baselines'])}

### Matched same-token/day comparisons

Candidate returns minus the first eligible candle on its selected tokens/days, bootstrapped by paired UTC day. Positive means the entry filter did better. Different within-day entry times are intentional; unresolved paths remain excluded from each mean and are a coverage limitation.

{'\n'.join(comparison_rows)}

The published legacy signal/exit result remains a historical reference in [the original report](../REPORT.md). It has a different signal population and exit structure, so it is not a matched comparison for this new study.

## Chronological development selection

Past-only selection takes a candidate only after >=10 selected training trades over >=3 days and a positive training mean. Model scores are generated with prior-day, purged/group-separated fits, not in-sample fits. Unavailable or negative selection stays in cash.

```json
{json.dumps(choices,indent=2)}
```

Selected strategy: {selected_summary['resolved']} resolved trades, {fmt(selected_summary['expectancy']['estimate'],'%')} mean net return, 95% CI {ci_text(selected_summary['expectancy'])}; illustrative constrained account P/L ${selected_summary['portfolio']['pnl']:.2f}.

## Frozen retrospective confirmation

{table(confirmation_summary) if confirmation_summary else 'Unavailable: the fresh read-only production export could not be obtained. No confirmation result is fabricated.'}

All rows above are prespecified diagnostics. The single selected candidate is frozen from development; confirmation outcomes cannot change it. October 3–7 observations predate registration, so even this confirmation is retrospective.

## Cost and delay sensitivity

{'\n'.join(sensitivity_rows)}

The ML model is fitted anew under each predeclared sensitivity's training labels. These are diagnostics, not extra candidates from which to choose a winner.

## Multiple-testing diagnostic

{permutations} seeded within-day permutations refit ML and repeat selection. Familywise best-mean p={fmt(null['familywise_p'],places=3)} ({null['finite_max_draws']} finite draws); nested-selection p={fmt(null['nested_p'],places=3)} ({null['finite_nested_draws']} finite draws). These are exploratory diagnostics on a short, reused dataset and do not establish an independent market edge.

## Limitations and next decision

- Late discovery metadata is excluded. The fresh exporter additionally rejects candle features whose recorded timestamp differs from detection.
- Missing entries and gaps never get invented fills. An unfinished path is unresolved; resolved-return means can still suffer informative censoring. Per-candidate −100% missing-path stress means and coverage are in results.json.
- The $1,000 illustration uses $50 positions and max three simultaneous fills, with cash reservation before the outcome; reported drawdown uses realized equity, not unavailable intratrade mark-to-market. Unknown P/L is marked at zero only in this illustration and is separately stressed as a total loss.
- Modeled costs do not replace FOMO quotes, sellability/security checks, or actual fills. A 3% price stop does not limit rug losses to 3%.
- The inherited trailing simulator has only OHLC bars, so activation-bar target/trail ordering is assumed rather than observed. A lead that depends on these fills needs transaction-level execution evidence.
- The historical sample contains only a handful of market days and repeated pools. No count of candle rows substitutes for independent days.
- Phase 4 regime, young-pool, order-flow, wallet-following, and actual-cost hypotheses remain under their existing coverage gates.
- A future candidate requires >=100 resolved trades over >=20 new UTC days, >=95% outcome coverage, positive lower expectancy and matched-baseline bounds, and executable cost/security evidence. No alerts, collectors, or the locked Phase 3 challenger change automatically.

## Research rationale

Trend persistence is a plausible hypothesis, but [the original time-series momentum research](https://www.aqr.com/insights/research/journal-article/time-series-momentum) does not validate five-minute memecoin trades. Searching for a historical winner can itself create misleading results; [Bailey et al.'s backtest-overfitting paper](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) motivates keeping this short reused-sample search separate from new forward evidence. The calculations above, rather than those papers, determine this study's verdict.

## Reproduce

```sh
node --import tsx scripts/replay-strategy-discovery.mjs research/ml/data/snapshot.csv research/ml/data/paths.csv.gz research/ml/data/discovery-replay.csv
PYTHONPATH=research/ml research/ml/.venv/bin/python -m scanner_ml.strategy_discovery --snapshot research/ml/data/snapshot.csv --replay research/ml/data/discovery-replay.csv
```

Optional fresh input is produced by the read-only export script and passed through `--confirmation-snapshot` and `--confirmation-replay`. Data files stay ignored; reports retain input hashes and the full attempted-trade ledger.
"""
    (out/'REPORT.md').write_text(report)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--replay',type=Path,required=True)
    parser.add_argument('--confirmation-snapshot',type=Path)
    parser.add_argument('--confirmation-replay',type=Path)
    parser.add_argument('--out',type=Path,default=Path('research/ml/reports/strategy-discovery-v1'))
    args=parser.parse_args()
    result=run_study(args.snapshot,args.replay,args.out,args.confirmation_snapshot,args.confirmation_replay)
    print(json.dumps({'candidate':result['frozen_candidate'],'worth_prospective_testing':result['worth_prospective_testing'],'report':str(args.out/'REPORT.md')}))


if __name__=='__main__':main()
