import numpy as np
import pandas as pd

from scanner_ml.edge_program import _tail, engineer_flow, load_edge_grid, matched_avoid, monte_carlo


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


def test_avoid_filter_requires_established_and_familywise_fat_tail_evidence():
    rows = []
    legacy_values = {}
    edge_values = {}
    legacy_rules = [f"half_runner|tp5|support|24h|{cost}bps" for cost in [100, 200, 300]]
    edge_rules = ["fat_tail|support|trail20|24h|200bps", "ladder|support|trail40|24h|200bps"]
    for day_number in range(6):
        day = pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=day_number)
        signal_id, control_id = f"s{day_number}", f"c{day_number}"
        rows.extend([
            {"id": signal_id, "source": "signal", "chain": "solana", "pool": "pool", "day": day},
            {"id": control_id, "source": "control", "chain": "solana", "pool": "pool", "day": day},
        ])
        for rule in legacy_rules:
            legacy_values.setdefault(rule, {})[signal_id] = -10
            legacy_values.setdefault(rule, {})[control_id] = 0
        for rule in edge_rules:
            edge_values.setdefault(rule, {})[signal_id] = -20
            edge_values.setdefault(rule, {})[control_id] = 0
    frame = pd.DataFrame(rows)
    legacy = pd.DataFrame(legacy_values); edge = pd.DataFrame(edge_values)
    result, table = matched_avoid(frame, legacy, edge, n_boot=200, permutation_draws=500)
    assert result["verdict"] == "supported"
    assert result["familywise_permutation_p"] < .05
    assert len(table) == 5


def test_incomplete_path_is_not_a_negative_two_x_label(tmp_path):
    path = tmp_path / "edge.csv.gz"
    pd.DataFrame([
        {"id": "open-low", "rule_id": "r", "structure": "fat_tail", "stop": "fixed20", "trail_pct": 40,
         "time_hours": 168, "cost_bps": 200, "net_return_pct": 10, "gross_return_pct": 12,
         "exit_reason": "open", "exit_at": 1, "resolved": False, "max_multiple": 1.5},
        {"id": "open-hit", "rule_id": "r", "structure": "fat_tail", "stop": "fixed20", "trail_pct": 40,
         "time_hours": 168, "cost_bps": 200, "net_return_pct": 120, "gross_return_pct": 122,
         "exit_reason": "open", "exit_at": 1, "resolved": False, "max_multiple": 2.5},
        {"id": "closed-low", "rule_id": "r", "structure": "fat_tail", "stop": "fixed20", "trail_pct": 40,
         "time_hours": 168, "cost_bps": 200, "net_return_pct": -22, "gross_return_pct": -20,
         "exit_reason": "stop", "exit_at": 1, "resolved": True, "max_multiple": 1.2},
    ]).to_csv(path, index=False, compression="gzip")
    _, maxima, _ = load_edge_grid(path)
    assert np.isnan(maxima.loc["open-low", "r"])
    assert maxima.loc["open-hit", "r"] == 2.5
    assert maxima.loc["closed-low", "r"] == 1.2
