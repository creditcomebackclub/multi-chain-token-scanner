# Phase 1.3 preregistration: pool age

- **Hypothesis:** a point-in-time pool-age bucket identifies entries with better fat-tail expectancy than the watched-universe base rate.
- **Population:** observations with a finite creation timestamp known at detection; fixed buckets are `<1h`, `1–4h`, `4–24h`, and `>24h`.
- **Exit rule:** the Phase 1.2 rule selected inside each outer training fold. If Phase 1.2 cannot select an eligible rule, report descriptive bucket results for every prespecified rule and make no supported verdict.
- **Primary metric:** nested out-of-sample mean net return for the training-selected age bucket minus all eligible controls under the same exit on overlapping days, with a paired day-block interval.
- **Risk audit:** report point-in-time GoPlus status mix by bucket when present. If path liquidity exists, a fall to at most 1% of entry liquidity or at most $1,000 is a liquidity collapse and forces a −100% gross outcome at that bar; if liquidity paths are absent, mark this test blocked rather than inferring it from price.
- **Success criterion:** at least 30 training and 20 test observations in the selected bucket, paired lower 95% bound above zero, and candidate expectancy lower bound above zero after costs. Buckets with lower coverage are `not estimable`.

