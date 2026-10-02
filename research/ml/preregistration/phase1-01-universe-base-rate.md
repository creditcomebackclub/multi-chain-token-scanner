# Phase 1.1 preregistration: universe base rate

- **Hypothesis:** random eligible five-minute candles in the watched-token universe have non-positive net expectancy after realistic costs.
- **Population:** `source=control` rows with an exact next-bar open and sufficient forward-path coverage for the tested time exit. Signals and alerts are excluded.
- **Exit rules:** every Phase 1.2 no-take-profit and ladder rule at 24h, 72h, and 7d, with 100, 200, and 300 bps round-trip costs. Incomplete horizons remain unresolved rather than being treated as completed trades.
- **Primary metric:** mean net return with a day-block bootstrap interval. Median, p5, p10, p25, p50, p75, p90, p95, p99, and shares with net return at least 100%, 400%, and 900% are secondary. Results are also grouped by chain and UTC entry day.
- **Success criterion:** this is the fixed benchmark rather than a promotable strategy. Every later hypothesis must exceed the contemporaneous control mean on overlapping test days with a paired day-block interval above zero.

