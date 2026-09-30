import numpy as np

from scanner_ml.power import analytic_required_n, breakeven_win_rate

def test_breakeven_uses_asymmetric_empirical_payoffs():
    result=breakeven_win_rate([5,5,-10,-10])
    assert np.isclose(result["breakeven_win_rate"],2/3)
    assert analytic_required_n(2/3,.8)>0
