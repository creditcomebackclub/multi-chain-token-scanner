# Phase 1.2 preregistration: let winners run

- **Hypothesis:** a buy-only exit that preserves the memecoin right tail beats the same-period eligible-control base rate out of sample.
- **Population:** signals and delivered alerts are the candidate population; all eligible controls are the benchmark. Entry is the exact next five-minute bar open.
- **Exit rules:** (a) no take-profit with support, fixed 10%, fixed 20%, or 2×ATR initial stop and a 20%, 30%, or 40% high-water trailing stop; (b) a ladder selling 25% at 2×, 25% at 5×, and trailing the remaining 50% at 40%. Each rule uses 24h, 72h, or 7d time exits and 100, 200, or 300 bps costs. Stops and active trails win same-bar conflicts, gap exits use the worse bar open, and incomplete time horizons remain unresolved.
- **Selection:** select the rule on each outer training fold by mean net return, requiring at least 30 training signals. Apply only that rule to the purged outer test fold. No full-sample best rule is a headline result.
- **Primary metric:** nested out-of-sample mean net return minus the control mean under the identical fold-selected rule on overlapping test days, with a paired day-block bootstrap interval.
- **Secondary metrics:** absolute expectancy; median and tail percentiles; share at least 2×, 5×, and 10×; expectancy after removing the top 1% within each evaluated population; and a within-day permutation family-wise check over the searched rule grid.
- **Success criterion:** the paired lower 95% confidence bound is above zero, the candidate expectancy lower bound is above zero net of costs, and the permutation p-value is below 0.05.

