# Phase 1.6 preregistration: signal as an avoid filter

- **Hypothesis:** current signal candles underperform otherwise eligible candles on the same pair and UTC day, making the signal useful as a warning rather than a buy trigger.
- **Population:** each signal or delivered-alert row matched to all control rows on the same chain, pool, and UTC day. Days without both groups are excluded; matching never uses future outcomes.
- **Exit rules:** the established immediate half-runner rule at 100, 200, and 300 bps plus each Phase 1.2 fat-tail structure. No rule is selected using test outcomes.
- **Primary metric:** signal mean net return minus matched-control mean net return, first averaged within pair-day blocks and then across blocks, with a pair-day/day-block bootstrap interval.
- **Loss-prevention metric:** for 100 equal-dollar buys, avoided loss is the negative matched return difference multiplied by 100 stakes; report both stake units and the dollar value for $100 per buy.
- **Success criterion:** the upper 95% bound of signal-minus-control return is below zero for the 200 bps established exit and remains below zero under at least one prespecified fat-tail structure after family-wise permutation adjustment. This is recommendation-only and cannot change live alerts in Phase 1.

