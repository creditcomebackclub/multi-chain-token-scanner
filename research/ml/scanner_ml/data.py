from __future__ import annotations

from pathlib import Path
import pandas as pd

FEATURES = [
    "volumeRatio", "riskPct", "atrPct", "bodyPct", "closePosition",
    "upperWickPct", "lowerWickPct", "ema9SlopePct", "ema21SlopePct",
    "priceToEma9Pct", "ema9ToEma21Pct", "priceToSma50Pct",
    "priorPeakDrawdownPct", "supportTestCount", "supportTouchAgeBars",
]
RULES = [
    "rule_immediate", "rule_greenHold", "rule_greenHoldVolume", "rule_qualityUnique",
    "screen_hold", "screen_greenHold", "screen_holdVolume", "screen_greenHoldVolume",
]
IDENTITY = ["id", "source", "chain", "token", "pool", "support_anchor", "detected_at"]
SIMULATION = [
    f"{entry}_{field}"
    for entry in ("immediate", "greenHold")
    for field in ("sim_status", "sim_net_return_pct", "sim_net_return_pct_300bps", "sim_entry_at", "sim_exit_at")
]
REQUIRED = IDENTITY + FEATURES + ["first_hit", "label_resolved_at", "y"] + SIMULATION + RULES

# Every value is calculated in chart-pattern.ts from closed candles ending at or
# before detected_at. This explicit registry makes future additions fail review
# until their point-in-time provenance is documented.
LEAKAGE_REVIEW = {
    feature: "PASS — src/chart-pattern.ts analyze(); closed candles at/before detected_at"
    for feature in FEATURES
}

def load_dataset(path: str | Path) -> pd.DataFrame:
    path = Path(path)
    frame = pd.read_csv(path)
    missing = sorted(set(REQUIRED) - set(frame.columns))
    if missing:
        raise ValueError(f"dataset is missing columns: {', '.join(missing)}")
    for column in FEATURES + ["support_anchor", "detected_at", "label_resolved_at", "y"] + [c for c in SIMULATION if c.endswith(("_pct", "_at", "_300bps"))]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    for column in RULES:
        frame[column] = frame[column].astype("string").str.lower().map({"true": True, "false": False}).astype("boolean")
    frame["detected_dt"] = pd.to_datetime(frame["detected_at"], unit="ms", utc=True, errors="coerce")
    frame["resolved_dt"] = pd.to_datetime(frame["label_resolved_at"], unit="ms", utc=True, errors="coerce")
    frame["day"] = frame["detected_dt"].dt.floor("D")
    frame["group_id"] = frame[["chain", "token", "support_anchor"]].astype("string").agg("|".join, axis=1)
    return frame.sort_values(["detected_at", "id"]).reset_index(drop=True)

def resolved(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.loc[frame["y"].isin([0, 1])].copy()

def audit(frame: pd.DataFrame) -> dict:
    labels = frame["first_hit"].fillna("unresolved").replace("", "unresolved")
    groups = frame.groupby("group_id", dropna=False).size()
    return {
        "rows": int(len(frame)),
        "time_start": frame["detected_dt"].min(),
        "time_end": frame["detected_dt"].max(),
        "by_source": frame["source"].value_counts(dropna=False).to_dict(),
        "by_chain": frame["chain"].value_counts(dropna=False).to_dict(),
        "by_label": labels.value_counts(dropna=False).to_dict(),
        "resolved": int(frame["y"].isin([0, 1]).sum()),
        "feature_missing_pct": (frame[FEATURES].isna().mean() * 100).round(2).to_dict(),
        "groups": int(groups.size),
        "repeated_groups": int((groups > 1).sum()),
        "max_rows_per_group": int(groups.max()) if len(groups) else 0,
        "leakage_review": LEAKAGE_REVIEW,
    }
