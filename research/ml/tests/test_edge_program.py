import numpy as np
import pandas as pd

from scanner_ml.edge_program import _tail, engineer_flow, monte_carlo


def test_tail_summary_reports_extreme_winners_and_top_one_percent_dependence():
    values = pd.Series([0.0] * 99 + [900.0])
    result = _tail(values)
    assert result["trades"] == 100
    assert result["share_ge_2x"] == .01
    assert result["share_ge_5x"] == .01
    assert result["share_ge_10x"] == .01
    assert result["mean"] == 9
    assert result["mean_without_top_1pct"] == 0


def test_flow_features_use_only_prior_discovery_snapshots():
    base = 1_000_000
    frame = pd.DataFrame([
        {"chain": "solana", "pool": "p", "detected_at": base, "discovery_fetched_at": base,
         "discovery_buyers_5m": 10, "discovery_buys_5m": 12, "discovery_sells_5m": 6,
         "discovery_liquidity": 100, "discovery_volume_5m": 20},
        {"chain": "solana", "pool": "p", "detected_at": base + 15*60_000, "discovery_fetched_at": base + 15*60_000,
         "discovery_buyers_5m": 14, "discovery_buys_5m": 21, "discovery_sells_5m": 7,
         "discovery_liquidity": 110, "discovery_volume_5m": 33},
    ])
    result = engineer_flow(frame)
    assert np.isnan(result.iloc[0].buyer_acceleration)
    assert result.iloc[1].buyer_acceleration == 4
    assert result.iloc[1].count_ratio_trend == 1
    assert abs(result.iloc[1].liquidity_change_15m - 10) < 1e-10
    assert result.iloc[1].volume_to_liquidity == .3


def test_position_sizing_is_seeded_and_never_risks_more_than_fraction():
    values = pd.DataFrame({"day": pd.to_datetime(["2026-01-01", "2026-01-02", "2026-01-03"], utc=True),
                           "net_return_pct": [10, -100, 20]})
    first = monte_carlo(values, simulations=20)
    second = monte_carlo(values, simulations=20)
    pd.testing.assert_frame_equal(first, second)
    assert (first.p5_final_bankroll > 0).all()
