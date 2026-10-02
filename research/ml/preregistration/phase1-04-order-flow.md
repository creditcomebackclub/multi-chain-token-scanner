# Phase 1.4 preregistration: order-flow features

- **Hypothesis:** point-in-time order flow improves both 2×-before-stop ranking and top-decile expectancy beyond chart features alone.
- **Population:** observations with complete point-in-time flow history and sufficient price paths. The fixed binary label is reaching 2× before the applicable initial stop; same-bar conflicts count as stop first.
- **Features:** unique-buyer acceleration; buy/sell count-ratio trend; liquidity changes over 15, 30, and 60 minutes; and volume-to-liquidity ratio. Chart-only uses the existing no-`riskPct` feature set. Flow-only and combined sets are fixed before fitting; missing values are handled inside training folds only.
- **Models:** the existing logistic and histogram-gradient-boosting pipelines, fitted and calibrated inside purged walk-forward training folds.
- **Primary metric:** paired out-of-fold AUC difference, combined minus chart-only, with a day-block interval. Flow-only versus chart-only is secondary.
- **Trading metric:** top-decile net expectancy under the Phase 1.2 fold-selected exit versus eligible controls on the same test days.
- **Success criterion:** combined-minus-chart AUC lower 95% bound above zero and combined top-decile expectancy-minus-base-rate lower bound above zero. If any required feature has less than 50% coverage, the comparison is `blocked` rather than imputed from outcomes.

