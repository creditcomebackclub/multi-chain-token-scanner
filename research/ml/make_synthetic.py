from __future__ import annotations

import argparse
from pathlib import Path
import sys
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from scanner_ml import SEED
from scanner_ml.data import FEATURES, REQUIRED, RULES

def make_synthetic(path: str | Path, rows: int = 600) -> Path:
    rng = np.random.default_rng(SEED)
    start = pd.Timestamp("2026-01-01", tz="UTC")
    records = []
    chains = np.array(["solana", "ethereum", "bnb", "robinhood", "base"])
    for index in range(rows):
        detected = start + pd.Timedelta(hours=4 * index)
        signal = index % 5 != 0
        token_number = index // 3
        chain = str(chains[token_number % len(chains)])
        token = f"synthetic-token-{token_number:04d}"
        support_anchor = int((start + pd.Timedelta(hours=12 * token_number)).timestamp() * 1000)
        volume_ratio = float(rng.lognormal(.55, .35))
        risk = float(np.clip(rng.normal(6.5, 1.4), 2.5, 11))
        atr = float(np.clip(rng.normal(4.5, 1.2), 1, 10))
        body = float(rng.beta(3, 2)); close = float(rng.beta(5, 1.8))
        upper = float(rng.beta(1.5, 5)); lower = float(rng.beta(2, 4))
        ema9_slope = float(rng.normal(.35, .45)); ema21_slope = float(rng.normal(.15, .3))
        price_ema = float(rng.normal(.8, 1.3)); ema_spread = float(rng.normal(.25, .8)); price_sma = float(rng.normal(1.2, 3.5))
        drawdown = float(rng.normal(-12, 5)); tests = int(rng.integers(2, 6)); age = int(rng.integers(1, 18))
        linear = -1.15 + .45 * (volume_ratio - 1.5) - .11 * (risk - 6) + 1.0 * (close - .5) + .35 * ema9_slope + .09 * tests
        probability = 1 / (1 + np.exp(-linear))
        y = int(rng.random() < probability)
        first_hit = "tp1" if y else "stop"
        detected_ms = int(detected.timestamp() * 1000)
        resolved_ms = detected_ms + int(rng.integers(1, 24 * 12)) * 300_000
        green = bool(close > .58 and ema9_slope > -.1 and rng.random() > .2)
        green_volume = bool(green and volume_ratio >= 1.35)
        quality = bool(green_volume and volume_ratio >= 2)
        if signal:
            immediate_return = float(rng.choice([.5, 5.5], p=[.35, .65])) if y else float(-risk - 2)
            green_return = (float(rng.choice([.5, 5.5], p=[.3, .7])) if y else float(-risk - 2)) if green else np.nan
            source = "alert" if index % 7 == 0 else "signal"
        else:
            immediate_return = green_return = np.nan
            source = "control"
        record = {
            "id": f"synthetic-{index:05d}", "source": source, "chain": chain, "token": token,
            "pool": f"synthetic-pool-{token_number:04d}", "support_anchor": support_anchor, "detected_at": detected_ms,
            "entry_price": 100.0, "support_stop_price": 100.0 * (1-risk/100), "atr14": atr,
            "volumeRatio": volume_ratio, "riskPct": risk, "atrPct": atr, "bodyPct": body,
            "closePosition": close, "upperWickPct": upper, "lowerWickPct": lower,
            "ema9SlopePct": ema9_slope, "ema21SlopePct": ema21_slope,
            "priceToEma9Pct": price_ema, "ema9ToEma21Pct": ema_spread,
            "priceToSma50Pct": price_sma, "priorPeakDrawdownPct": drawdown,
            "supportTestCount": tests, "supportTouchAgeBars": age, "first_hit": first_hit,
            "label_resolved_at": resolved_ms, "y": y,
            "immediate_sim_status": "tp2" if y and immediate_return > 1 else "runner_breakeven" if y else "stop",
            "immediate_sim_net_return_pct": immediate_return,
            "immediate_sim_net_return_pct_300bps": immediate_return - 1 if signal else np.nan,
            "immediate_sim_entry_at": detected_ms, "immediate_sim_exit_at": resolved_ms,
            "greenHold_sim_status": ("tp2" if y and green_return > 1 else "runner_breakeven" if y else "stop") if green else "",
            "greenHold_sim_net_return_pct": green_return,
            "greenHold_sim_net_return_pct_300bps": green_return - 1 if np.isfinite(green_return) else np.nan,
            "greenHold_sim_entry_at": detected_ms + 300_000 if green else np.nan,
            "greenHold_sim_exit_at": resolved_ms if green else np.nan,
            "rule_immediate": signal, "rule_greenHold": green if signal else pd.NA,
            "rule_greenHoldVolume": green_volume if signal else pd.NA, "rule_qualityUnique": quality if signal else pd.NA,
            "screen_hold": green if signal else pd.NA, "screen_greenHold": green if signal else pd.NA,
            "screen_holdVolume": green_volume if signal else pd.NA, "screen_greenHoldVolume": green_volume if signal else pd.NA,
        }
        records.append(record)
    frame = pd.DataFrame(records)[REQUIRED]
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True); frame.to_csv(path, index=False)
    return path

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate a deterministic, clearly synthetic scanner ML dataset.")
    parser.add_argument("--output", default=ROOT / "data" / "synthetic.csv", type=Path)
    parser.add_argument("--rows", default=600, type=int)
    args = parser.parse_args()
    print(make_synthetic(args.output, args.rows))
