# Phase 1.7 preregistration: position sizing and risk of ruin

- **Hypothesis:** fixed-fractional position size materially changes the chance that a bankroll survives long enough to realize a fat-tailed edge.
- **Population:** the locked out-of-sample returns from the best Phase 1 candidate that meets its preregistered success criterion, plus the universe-control base rate under the identical exit. If no candidate is supported, simulate the universe benchmark and label candidate sizing `not available`.
- **Simulation:** seeded day-block resampling of empirical returns, starting bankroll $1,000, fractions 0.5%, 1%, 2%, and 5% of current bankroll per trade, horizons 100, 300, and 1,000 trades. Use 10,000 Monte Carlo paths and seed 20260905. Returns below −100% are floored at −100%; no leverage is added.
- **Primary metrics:** median and 5th-percentile final bankroll, median and 95th-percentile maximum drawdown, and probability final bankroll or intrapath bankroll falls to $500 or less.
- **Success criterion:** sizing is descriptive, not a strategy-selection search. A size is called survivable only if the upper 95% binomial bound for 50% bankroll loss is below 5% at all three horizons; otherwise it is not supported.
