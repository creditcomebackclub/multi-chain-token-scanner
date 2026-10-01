import numpy as np

from scanner_ml.power import analytic_payoff_sensitivity, analytic_required_n, breakeven_win_rate

def test_breakeven_uses_asymmetric_empirical_payoffs():
    result=breakeven_win_rate([5,5,-10,-10])
    assert np.isclose(result["breakeven_win_rate"],2/3)

def test_payoff_sensitivity_rewards_larger_targets_and_tighter_risk():
    table=analytic_payoff_sensitivity(.5,targets=(5,10),risk_caps=(3,8),costs_bps=(200,))
    at_five=table.loc[(table.tp1_pct==5)&(table.max_risk_pct==8),"breakeven_win_rate"].iloc[0]
    at_ten=table.loc[(table.tp1_pct==10)&(table.max_risk_pct==8),"breakeven_win_rate"].iloc[0]
    tight=table.loc[(table.tp1_pct==5)&(table.max_risk_pct==3),"breakeven_win_rate"].iloc[0]
    assert at_ten<at_five
    assert tight<at_five
    assert analytic_required_n(2/3,.8)>0
