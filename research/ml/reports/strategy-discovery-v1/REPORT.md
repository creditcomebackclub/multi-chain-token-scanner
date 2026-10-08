# Focused FOMO strategy discovery v1

**Retrospective research; modeled fills and costs. No validated BUY strategy or live change.**

## Decision

Frozen development candidate: **volume_ignition|trail**. Worth prospective testing under the registered confirmation criterion: **no / confirmation unavailable**. Twelve prespecified candidates were tested; none can be promoted without the separately required fresh execution and forward evidence.

## Development: reused published snapshot

Primary entry waits a full five-minute bar and uses that bar's open. Costs are 200bps round trip. One attempt per token per UTC day is chosen before inspecting the result. The same selected-pair universe and filters apply to every candidate. This historical sample has already been used for earlier research and is not pristine out-of-sample evidence.

| Candidate | Attempts / resolved | Days | Net mean | 95% day CI | Win rate | PF | $50-trade account P/L | Without best win | Coverage |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| support_reclaim / scalp | 10 / 5 | 5 | -1.83% | [-2.59, -0.97] | 0.00% | 0.00 | $-4.57 | -2.17% | 50.00% |
| trend_pullback / scalp | 30 / 25 | 6 | -3.14% | [-4.30, -1.97] | 8.00% | 0.10 | $-39.23 | -3.60% | 83.33% |
| volume_ignition / scalp | 21 / 17 | 5 | -0.84% | [-2.91, 1.31] | 35.29% | 0.64 | $-7.13 | -1.39% | 80.95% |
| return_ranked_ml / scalp | 0 / 0 | 0 | NA | not estimable (0 days, 0 trades / degenerate) | NA | NA | $0.00 | NA | NA |
| support_reclaim / runner | 10 / 3 | 3 | -3.56% | not estimable (3 days, 3 trades / degenerate) | 0.00% | 0.00 | $-5.33 | -5.17% | 30.00% |
| trend_pullback / runner | 30 / 22 | 6 | -2.73% | [-5.28, -0.15] | 27.27% | 0.39 | $-33.01 | -3.48% | 73.33% |
| volume_ignition / runner | 21 / 15 | 5 | -0.06% | [-1.31, 1.38] | 46.67% | 0.98 | $-1.94 | -0.99% | 71.43% |
| return_ranked_ml / runner | 1 / 1 | 1 | 3.00% | not estimable (1 days, 1 trades / degenerate) | 100.00% | NA | $1.50 | NA | 100.00% |
| support_reclaim / trail | 10 / 3 | 3 | -3.44% | not estimable (3 days, 3 trades / degenerate) | 0.00% | 0.00 | $-5.16 | -5.00% | 30.00% |
| trend_pullback / trail | 30 / 23 | 6 | -3.62% | [-5.00, -1.43] | 8.70% | 0.15 | $-36.60 | -4.16% | 76.67% |
| volume_ignition / trail | 21 / 16 | 5 | 0.34% | [-1.58, 1.33] | 43.75% | 1.15 | $-0.03 | -0.20% | 76.19% |
| return_ranked_ml / trail | 0 / 0 | 0 | NA | not estimable (0 days, 0 trades / degenerate) | NA | NA | $0.00 | NA | NA |

## Eligible-candle baselines

These take the first eligible candle per token/day, with the same delay and exits. They describe this selected-pair universe rather than the whole market.

| Candidate | Attempts / resolved | Days | Net mean | 95% day CI | Win rate | PF | $50-trade account P/L | Without best win | Coverage |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|
| scalp | 233 / 198 | 7 | -2.31% | [-2.94, -1.48] | 20.20% | 0.35 | $-171.96 | -2.37% | 84.98% |
| runner | 233 / 169 | 7 | -2.95% | [-3.98, -1.81] | 24.85% | 0.39 | $-106.06 | -3.04% | 72.53% |
| trail | 233 / 189 | 7 | -2.13% | [-2.87, -1.33] | 24.34% | 0.40 | $-82.19 | -2.29% | 81.12% |

### Matched same-token/day comparisons

Candidate returns minus the first eligible candle on its selected tokens/days, bootstrapped by paired UTC day. Positive means the entry filter did better. Different within-day entry times are intentional; unresolved paths remain excluded from each mean and are a coverage limitation.

| Candidate | Difference vs matched baseline | 95% day CI |
|---|---:|---|
| support_reclaim / scalp | 0.92pp | [-0.41, 2.10] |
| trend_pullback / scalp | -1.05pp | [-2.73, 0.61] |
| volume_ignition / scalp | 1.92pp | [-0.43, 4.29] |
| return_ranked_ml / scalp | NA | not estimable (0 days, 0 trades / degenerate) |
| support_reclaim / runner | -2.06pp | not estimable (3 days, 3 trades / degenerate) |
| trend_pullback / runner | -0.59pp | [-2.84, 1.60] |
| volume_ignition / runner | 0.97pp | [-0.67, 4.40] |
| return_ranked_ml / runner | 10.00pp | not estimable (1 days, 1 trades / degenerate) |
| support_reclaim / trail | -0.13pp | not estimable (3 days, 3 trades / degenerate) |
| trend_pullback / trail | -0.53pp | [-2.20, 1.54] |
| volume_ignition / trail | 2.20pp | [0.20, 3.87] |
| return_ranked_ml / trail | NA | not estimable (0 days, 0 trades / degenerate) |

The published legacy signal/exit result remains a historical reference in [the original report](../REPORT.md). It has a different signal population and exit structure, so it is not a matched comparison for this new study.

## Chronological development selection

Past-only selection takes a candidate only after >=10 selected training trades over >=3 days and a positive training mean. Model scores are generated with prior-day, purged/group-separated fits, not in-sample fits. Unavailable or negative selection stays in cash.

```json
[
  {
    "test_day": "2026-09-26",
    "candidate": "cash"
  },
  {
    "test_day": "2026-09-27",
    "candidate": "cash"
  },
  {
    "test_day": "2026-09-28",
    "candidate": "cash"
  },
  {
    "test_day": "2026-09-29",
    "candidate": "cash"
  },
  {
    "test_day": "2026-09-30",
    "candidate": "cash"
  },
  {
    "test_day": "2026-10-01",
    "candidate": "volume_ignition|trail"
  },
  {
    "test_day": "2026-10-02",
    "candidate": "cash"
  }
]
```

Selected strategy: 4 resolved trades, 1.14% mean net return, 95% CI not estimable (1 days, 4 trades / degenerate); illustrative constrained account P/L $2.29.

## Frozen retrospective confirmation

Unavailable: the fresh read-only production export could not be obtained. No confirmation result is fabricated.

All rows above are prespecified diagnostics. The single selected candidate is frozen from development; confirmation outcomes cannot change it. October 3–7 observations predate registration, so even this confirmation is retrospective.

## Cost and delay sensitivity

| Candidate | Delay | 100bps | 200bps | 300bps |
|---|---:|---:|---:|---:|
| support_reclaim / scalp | 0m | -0.77% | -1.77% | -2.77% |
| support_reclaim / scalp | 5m | -0.83% | -1.83% | -2.83% |
| support_reclaim / runner | 0m | -3.86% | -4.86% | -5.86% |
| support_reclaim / runner | 5m | -2.56% | -3.56% | -4.56% |
| support_reclaim / trail | 0m | -2.53% | -3.53% | -4.53% |
| support_reclaim / trail | 5m | -2.44% | -3.44% | -4.44% |
| trend_pullback / scalp | 0m | -1.19% | -2.19% | -3.19% |
| trend_pullback / scalp | 5m | -2.14% | -3.14% | -4.14% |
| trend_pullback / runner | 0m | -1.89% | -2.89% | -3.89% |
| trend_pullback / runner | 5m | -1.73% | -2.73% | -3.73% |
| trend_pullback / trail | 0m | -1.88% | -2.88% | -3.88% |
| trend_pullback / trail | 5m | -2.62% | -3.62% | -4.62% |
| volume_ignition / scalp | 0m | -0.82% | -1.82% | -2.82% |
| volume_ignition / scalp | 5m | 0.16% | -0.84% | -1.84% |
| volume_ignition / runner | 0m | -0.37% | -1.37% | -2.37% |
| volume_ignition / runner | 5m | 0.94% | -0.06% | -1.06% |
| volume_ignition / trail | 0m | 0.48% | -0.52% | -1.52% |
| volume_ignition / trail | 5m | 1.34% | 0.34% | -0.66% |
| return_ranked_ml / scalp | 0m | -0.78% | -5.00% | -6.00% |
| return_ranked_ml / scalp | 5m | 0.33% | NA | NA |
| return_ranked_ml / runner | 0m | 1.01% | -7.00% | -8.00% |
| return_ranked_ml / runner | 5m | -0.23% | 3.00% | 2.00% |
| return_ranked_ml / trail | 0m | -0.65% | -3.02% | -6.00% |
| return_ranked_ml / trail | 5m | -1.20% | NA | NA |

The ML model is fitted anew under each predeclared sensitivity's training labels. These are diagnostics, not extra candidates from which to choose a winner.

## Multiple-testing diagnostic

200 seeded within-day permutations refit ML and repeat selection. Familywise best-mean p=0.219 (200 finite draws); nested-selection p=0.165 (78 finite draws). These are exploratory diagnostics on a short, reused dataset and do not establish an independent market edge.

## Limitations and next decision

- Late discovery metadata is excluded. The fresh exporter additionally rejects candle features whose recorded timestamp differs from detection.
- Missing entries and gaps never get invented fills. An unfinished path is unresolved; resolved-return means can still suffer informative censoring. Per-candidate −100% missing-path stress means and coverage are in results.json.
- The $1,000 illustration uses $50 positions and max three simultaneous fills, with cash reservation before the outcome; reported drawdown uses realized equity, not unavailable intratrade mark-to-market. Unknown P/L is marked at zero only in this illustration and is separately stressed as a total loss.
- Modeled costs do not replace FOMO quotes, sellability/security checks, or actual fills. A 3% price stop does not limit rug losses to 3%.
- The inherited trailing simulator has only OHLC bars, so activation-bar target/trail ordering is assumed rather than observed. A lead that depends on these fills needs transaction-level execution evidence.
- The historical sample contains only a handful of market days and repeated pools. No count of candle rows substitutes for independent days.
- Phase 4 regime, young-pool, order-flow, wallet-following, and actual-cost hypotheses remain under their existing coverage gates.
- A future candidate requires >=100 resolved trades over >=20 new UTC days, >=95% outcome coverage, positive lower expectancy and matched-baseline bounds, and executable cost/security evidence. No alerts, collectors, or the locked Phase 3 challenger change automatically.

## Research rationale

Trend persistence is a plausible hypothesis, but [the original time-series momentum research](https://www.aqr.com/insights/research/journal-article/time-series-momentum) does not validate five-minute memecoin trades. Searching for a historical winner can itself create misleading results; [Bailey et al.'s backtest-overfitting paper](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) motivates keeping this short reused-sample search separate from new forward evidence. The calculations above, rather than those papers, determine this study's verdict.

## Reproduce

```sh
node --import tsx scripts/replay-strategy-discovery.mjs research/ml/data/snapshot.csv research/ml/data/paths.csv.gz research/ml/data/discovery-replay.csv
PYTHONPATH=research/ml research/ml/.venv/bin/python -m scanner_ml.strategy_discovery --snapshot research/ml/data/snapshot.csv --replay research/ml/data/discovery-replay.csv
```

Optional fresh input is produced by the read-only export script and passed through `--confirmation-snapshot` and `--confirmation-replay`. Data files stay ignored; reports retain input hashes and the full attempted-trade ledger.
