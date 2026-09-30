# V4 Alpha Funnel blueprint

## Objective

Produce timely FOMO-routable alerts with positive measured expectancy after estimated fees and slippage. Alert count is a constraint, not the objective. Every promoted rule must earn its place using forward outcomes.

## Alert lifecycle

1. **SCOUT** — a token has unusual activity worth monitoring; no entry recommendation.
2. **EARLY ENTRY** — aggressive support rejection or launch momentum. Small starter position only.
3. **CONFIRMED BUY** — price structure, flow and liquidity all confirm. Full planned position may be considered.
4. **MANAGE** — TP1, breakeven-stop, TP2, trailing-stop or thesis-failure notification tied to an acknowledged entry.

Telegram should support an inline `Entered` action or `/entered <contract> <amount> <price>`. Management alerts should be sent only for acknowledged positions.

## Three independent strategy families

### 1. Launch momentum

For pools 10 minutes to 6 hours old. Require accelerating five-minute volume and unique buyers, increasing liquidity, controlled price extension, acceptable holder concentration and a safe contract. Prefer the first pullback after an initial expansion rather than a vertical candle.

### 2. Trend pullback continuation

For pools at least four hours old. Require bullish 15-minute/one-hour structure, EMA9 above EMA21, a pullback into support or the fast average, contracting sell volume, then renewed buying. This should become the primary higher-quality BUY strategy.

### 3. Smart-money consensus

Maintain a cohort of wallets selected by measured forward performance, early-entry skill and low rug exposure. Trigger when at least two independent qualified wallets accumulate the same token within a short window and the market has not already run beyond the entry cap. Named social traders may be included as evidence but should not control the signal.

## Signal score

Use a transparent 100-point score rather than one binary pattern:

- 25 points: price structure and entry location
- 20 points: volume and unique-buyer acceleration
- 20 points: smart-wallet consensus
- 15 points: liquidity level, liquidity trend and estimated exit quality
- 10 points: 15-minute/one-hour market regime
- 10 points: contract and holder quality

Hard rejections remain outside the score: failed security checks, disappearing liquidity, excessive concentration, stale data, excessive extension, unacceptable price impact, and an expired quote.

Proposed tiers:

- 60–69: SCOUT
- 70–79: EARLY ENTRY
- 80+: CONFIRMED BUY

Thresholds must be calibrated from forward results rather than chosen to manufacture a desired alert count.

## Feedback loop

Persist every signal, including signals that are not sent. For each one, reconstruct the next 15 minutes, one hour, six hours and 24 hours from exact-pool candles. Store:

- maximum favorable and adverse excursion
- whether stop, TP1 or TP2 occurred first
- return after estimated FOMO fees and configurable slippage
- time to target and time to failure
- liquidity loss and whether an executable market remained

Report expectancy by strategy, chain, age bucket, liquidity bucket, score bucket and market regime. Require at least 30 forward signals before promoting a rule to CONFIRMED BUY. Automatically demote a strategy when its recent lower confidence bound falls below zero after costs.

## Data architecture under $100/month

Start with:

- CoinGecko Basic ($35/month) for reliable multichain pool discovery and five-minute OHLCV.
- Helius free webhooks for low-latency Solana wallet and program events.
- Existing DEX Screener exact-pool confirmation and GoPlus security checks.
- Birdeye Standard free tier for a small proof of concept of Solana smart-money and wallet analytics.

Only add Birdeye Lite ($39/month) after its endpoints and compute-unit use are validated against the proof of concept. That keeps the likely stack at $35 initially and at most $74/month after validation.

FOMO execution remains manual through direct token links unless FOMO supplies an approved trading interface. Private browser endpoints or session tokens should not become production dependencies.

## Build order

1. Outcome ledger for all chart alerts and unsent candidate signals.
2. Position acknowledgement and TP/stop management alerts.
3. Multitimeframe trend-pullback strategy.
4. Strategy-specific Telegram tiers and daily expectancy report.
5. Helius webhook receiver and performance-ranked Solana wallet cohort.
6. Birdeye proof of concept for wallet/smart-money enrichment.
7. Promote only strategies that pass forward expectancy and sample-size gates.

## Acceptance criteria

- No historical/lookahead data may affect a live signal.
- Exact-pool identity and fresh executable-range checks are mandatory.
- Results include configurable fees and slippage.
- A promoted BUY rule has at least 30 forward signals and positive net expectancy with a documented uncertainty bound.
- Every BUY alert contains entry window, invalidation, stop, TP1, TP2 and setup tier.
- Acknowledged positions receive deduplicated management alerts.
