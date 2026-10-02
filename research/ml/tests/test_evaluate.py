import numpy as np
import pandas as pd

from scanner_ml.evaluate import (
    calibration_metrics, classification_metrics, metric_intervals,
    interval_text, paired_metric_differences, strategy_comparison,
)

def test_metrics_match_hand_computed_brier_and_calibration():
    metrics=classification_metrics([0,1],[.25,.75])
    assert np.isclose(metrics["brier"],.0625)
    calibration=calibration_metrics([0,1],[.25,.75])
    assert np.isclose(calibration["brier"],.0625)

def test_block_bootstrap_is_deterministic():
    frame=pd.DataFrame({"y":[0,1,0,1,1,0,1,0],"prediction":[.2,.8,.3,.7,.6,.4,.9,.1],"day":pd.to_datetime(["2026-01-01"]*4+["2026-01-02"]*4,utc=True)})
    assert metric_intervals(frame,"prediction",20)==metric_intervals(frame,"prediction",20)

def test_sparse_day_blocks_are_reported_as_not_estimable():
    day=pd.Timestamp("2026-01-01",tz="UTC")
    frame=pd.DataFrame({
        "id":[f"row-{i}" for i in range(6)], "day":[day]*6,
        "detected_at":np.arange(6), "fold":[0]*6, "group_id":[f"g-{i}" for i in range(6)],
        "immediate_sim_net_return_pct":[1,-2,3,-4,5,-6],
        "immediate_sim_net_return_pct_300bps":[0,-3,2,-5,4,-7],
        "greenHold_sim_net_return_pct":[1,-2,3,-4,5,-6],
        "greenHold_sim_net_return_pct_300bps":[0,-3,2,-5,4,-7],
        "immediate_sim_exit_at":np.arange(6)+10, "greenHold_sim_exit_at":np.arange(6)+10,
        "rule_immediate":[True]*6, "rule_greenHold":[True]*6,
        "rule_greenHoldVolume":[True]*6, "rule_qualityUnique":[True]*6,
        "pred_logistic":[.8,.2,.8,.2,.8,.2], "model_threshold":[.5]*6,
        "selected_screen":["screen_hold"]*6, "screen_hold":[True]*6,
        "screen_greenHold":[False]*6, "screen_holdVolume":[False]*6,
        "screen_greenHoldVolume":[False]*6,
    })
    table,paired,_=strategy_comparison(frame,n_boot=20)
    assert table.loc["model_filtered","expectancy_ci_95"]=="not estimable (1 blocks)"
    assert table.loc["model_filtered","win_rate_ci_95"]=="not estimable (1 blocks)"
    assert paired["ci_95"]=="not estimable (1 blocks)"

def test_paired_metric_difference_requires_three_day_blocks():
    frame=pd.DataFrame({
        "y":[0,1,0,1,0,1], "left":[.1,.9,.2,.8,.3,.7], "right":[.2,.8,.3,.7,.4,.6],
        "day":pd.to_datetime(["2026-01-01"]*3+["2026-01-02"]*3,utc=True),
    })
    result=paired_metric_differences(frame,"left","right",20)
    assert result["brier"]["blocks"]==2
    assert np.isnan(result["brier"]["ci_low"])

def test_zero_width_interval_is_not_estimable():
    assert interval_text(1.25,1.25,4)=="not estimable (4 blocks)"
