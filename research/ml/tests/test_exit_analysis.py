import numpy as np
import pandas as pd

from scanner_ml.exit_analysis import _interval
from scanner_ml.report import _estimate_ci


def test_exit_interval_is_not_estimable_with_fewer_than_three_day_blocks():
    rows = pd.DataFrame({"day": pd.to_datetime(["2026-01-01", "2026-01-01", "2026-01-02", "2026-01-02"], utc=True),
                         "net_return_pct": [1.0, -1.0, 2.0, -2.0]})
    result = _interval(rows, "net_return_pct", 100)
    assert result["blocks"] == 2
    assert np.isnan(result["ci_low"]) and np.isnan(result["ci_high"])
    assert "not estimable (2 blocks)" in _estimate_ci(result)


def test_exit_interval_has_width_with_three_day_blocks():
    rows = pd.DataFrame({"day": pd.to_datetime(["2026-01-01"]*3+["2026-01-02"]*3+["2026-01-03"]*3, utc=True),
                         "net_return_pct": [2, 1, 3, -3, -2, -1, 4, 5, 6]})
    result = _interval(rows, "net_return_pct", 200)
    assert result["ci_high"] > result["ci_low"]
