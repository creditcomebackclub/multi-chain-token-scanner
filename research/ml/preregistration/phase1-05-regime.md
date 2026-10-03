# Phase 1.5 preregistration: ex-ante market regime

- **Hypothesis:** a market regime known at entry identifies a buy-only subset whose net expectancy exceeds the same-period universe base rate.
- **Population:** observations with point-in-time SOL, ETH, or BNB five-minute candles and watched-universe breadth available before entry.
- **Features:** trailing 1h and 24h major-asset returns and the share of watched pairs with positive trailing 1h return. Chain maps to its native major where available; any pooled major rule and all cutoffs are selected on training folds only.
- **Exit rule:** the Phase 1.2 rule selected inside each outer training fold.
- **Primary metric:** nested out-of-sample mean net return for the training-selected regime minus eligible controls under the same exit on overlapping days, with a paired day-block interval.
- **Success criterion:** at least 30 training and 20 test trades, candidate expectancy lower 95% bound above zero, and paired difference lower bound above zero. If major-asset candles or breadth history are absent, verdict is `blocked on Phase 2`.

