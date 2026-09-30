from __future__ import annotations

import math
import numpy as np
import pandas as pd
from statsmodels.stats.proportion import proportion_confint

from . import SEED

Z_95 = 1.6448536269514722  # one-sided 95%
Z_80 = 0.8416212335729143

def breakeven_win_rate(returns) -> dict:
    values = pd.Series(returns, dtype=float).dropna()
    wins, losses = values[values > 0], values[values < 0]
    average_win = float(wins.mean()) if len(wins) else math.nan
    average_loss = float(abs(losses.mean())) if len(losses) else math.nan
    rate = average_loss / (average_win + average_loss) if np.isfinite(average_win + average_loss) and average_win + average_loss > 0 else math.nan
    return {"average_net_win_pct": average_win, "average_net_loss_pct": average_loss, "breakeven_win_rate": rate}

def analytic_required_n(p0: float, p1: float, alpha: float = .05, power: float = .8) -> int | None:
    if not (0 < p0 < p1 < 1):
        return None
    # One-sided normal approximation to a lower confidence bound above p0.
    numerator = Z_95 * math.sqrt(p0 * (1 - p0)) + Z_80 * math.sqrt(p1 * (1 - p1))
    return int(math.ceil((numerator / (p1 - p0)) ** 2))

def monte_carlo_win_power(p0: float, p1: float, n: int, empirical_returns, simulations: int = 2_000, seed: int = SEED) -> float:
    rng = np.random.default_rng(seed + n)
    empirical = pd.Series(empirical_returns, dtype=float).dropna().to_numpy()
    wins, losses = empirical[empirical > 0], empirical[empirical < 0]
    if not len(wins) or not len(losses):
        return math.nan
    # For the Wilson win-rate test, the magnitudes within the empirical win
    # and loss pools are ancillary: resampling their signs at p1 is exactly a
    # binomial draw. Expectancy power below resamples the full return values.
    successes = rng.binomial(n, p1, size=simulations)
    lower = np.array([proportion_confint(int(value), n, alpha=.05, method="wilson")[0] for value in successes])
    return float(np.mean(lower > p0))

def monte_carlo_required_n(p0: float, p1: float, empirical_returns, maximum: int = 5_000, simulations: int = 2_000) -> int | None:
    analytic = analytic_required_n(p0, p1)
    if analytic is None:
        return None
    candidates = sorted(set(max(20, int(analytic * factor)) for factor in np.linspace(.6, 1.8, 25)))
    candidates.extend([maximum])
    for n in candidates:
        if n <= maximum and monte_carlo_win_power(p0, p1, n, empirical_returns, simulations=simulations) >= .8:
            return n
    return None

def expectancy_power(returns, edges=(.25, .5, 1.0, 2.0), simulations: int = 2_000) -> pd.DataFrame:
    empirical = pd.Series(returns, dtype=float).dropna().to_numpy()
    if len(empirical) < 5:
        return pd.DataFrame(columns=["true_edge_pct", "required_n"])
    centered = empirical - empirical.mean()
    rng = np.random.default_rng(SEED)
    rows = []
    for edge in edges:
        required = None
        for n in sorted(set(np.geomspace(25, 2_000, 32).astype(int))):
            samples = rng.choice(centered, size=(simulations, n), replace=True) + edge
            means = samples.mean(axis=1); standard = samples.std(axis=1, ddof=1)
            lower = means - Z_95 * standard / np.sqrt(n)
            if float(np.mean(lower > 0)) >= .8:
                required = n; break
        rows.append({"true_edge_pct": edge, "required_n": required})
    return pd.DataFrame(rows)

def power_analysis(returns, simulations: int = 2_000) -> tuple[dict, pd.DataFrame, pd.DataFrame]:
    empirical = pd.Series(returns, dtype=float).dropna().to_numpy()
    breakeven = breakeven_win_rate(empirical)
    p0 = breakeven["breakeven_win_rate"]
    if not np.isfinite(p0):
        return breakeven, pd.DataFrame(), pd.DataFrame()
    rates = [rate for rate in np.arange(math.ceil((p0 + .03) * 100) / 100, min(.96, p0 + .26), .03)]
    win_rows = [{"true_win_rate": float(rate), "analytic_n": analytic_required_n(p0, float(rate)), "monte_carlo_n": monte_carlo_required_n(p0, float(rate), empirical, simulations=simulations)} for rate in rates]
    return breakeven, pd.DataFrame(win_rows), expectancy_power(empirical, simulations=simulations)
