import numpy as np
import pandas as pd

from scanner_ml.evaluate import calibration_metrics, classification_metrics, metric_intervals

def test_metrics_match_hand_computed_brier_and_calibration():
    metrics=classification_metrics([0,1],[.25,.75])
    assert np.isclose(metrics["brier"],.0625)
    calibration=calibration_metrics([0,1],[.25,.75])
    assert np.isclose(calibration["brier"],.0625)

def test_block_bootstrap_is_deterministic():
    frame=pd.DataFrame({"y":[0,1,0,1,1,0,1,0],"prediction":[.2,.8,.3,.7,.6,.4,.9,.1],"day":pd.to_datetime(["2026-01-01"]*4+["2026-01-02"]*4,utc=True)})
    assert metric_intervals(frame,"prediction",20)==metric_intervals(frame,"prediction",20)
