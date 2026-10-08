# Multi-Chain Event-Study Pipeline for Short-Horizon Crypto Signals

An event-study and forward-validation system for short-horizon crypto price signals across Solana, Ethereum, BNB Chain, Robinhood Chain, and Base. The TypeScript service collects point-in-time market observations and runs the live scanner; the offline Python layer tests whether its engineered 5-minute features beat hand-written rules after modeled costs.

It has no wallet integration, transaction signing, or trade execution. An automated risk check or high score does not establish that a token is safe or predict a return.

## Research: does the signal have an edge?

### Key findings

- **No tested legacy exit rule has positive out-of-sample expectancy.** Nested exit selection produced **+0.100%** per signal trade (95% day-block CI: **−0.603% to +0.847%**, 26 trades); controls and every top-decile model-ranked control population were negative.
- Signal/alert candles reached TP1 before the stop **53.7%** of the time versus **59.4%** for eligible same-pair control candles, a **−5.6 percentage-point** difference (95% day-block CI: −23.4 to +11.0).
- The current exit's observed positive-return rate was **38.7%**, far below the **73.4%** rate required to break even under its observed +2.22% average win and −6.13% average loss. Both rates in this repo count trades with a net-positive simulated return: the strategy table's **57.9%** covers only the **38** later, out-of-fold trades, while **38.7%** covers all **75** immediate-entry simulations, so the gap reflects which period is measured (the earlier trades fared far worse), not a different definition.
- Removing `riskPct` retained **95.9%** of logistic AUC and **89.8%** of gradient-boosting AUC. Stop-distance geometry contributed to ranking, but did not explain all of it.
- Naive shuffled validation reported **0.177 Brier** versus **0.224** under purged walk-forward validation, a **0.047-point optimism gap**.
- **Phase 1 found no promotable memecoin edge.** All 126 fat-tail signal cells with enough resolved trades were negative in sample, but none of the still-open seven-day survivors has a complete seven-day path yet. The seven-day-purged comparison, pool-age selection, and order-flow models therefore need a longer forward history; the market-regime test is blocked on Phase 2 candles, and the matched avoid filter was not supported.
- **Focused discovery's frozen volume-ignition lead failed confirmation.** Development averaged **+0.34%** after modeled 200bps costs across 16 resolved trades (95% day-block CI **−1.58% to +1.33%**, familywise permutation **p=0.219**). On October 3–7, the unchanged candidate averaged **−0.45%** across 23 resolved trades (95% CI **−3.25% to +1.68%**), **−1.45%** at 300bps, and **−0.90%** without its best winner. Only **23 of 32** attempts resolved. This chronological confirmation is still retrospective, not prospective evidence. See [the separate discovery report](research/ml/reports/strategy-discovery-v1/REPORT.md).

The portfolio research question is whether point-in-time 5-minute setup features predict TP1-first outcomes better than the hand-written rules after modeled costs. The offline Python study uses expanding-window validation, purges overlapping 24-hour label windows, preserves post-test embargoes in later training folds, applies a 24-hour pre-test gap, keeps repeated token/support groups together, and selects model thresholds and calibration only inside training folds.

**Headline result from the September 26–October 2 production snapshot:** the present signal does not establish a cost-adjusted edge, and changing exits did not rescue it. The dataset has 11,275 observations and 9,892 resolved labels. All 432 legacy exit-grid cells were negative in sample on signals; nested fold selection was nearly flat out of sample, but its interval includes losses and gains. The new 144-cell fat-tail grid likewise had no positive estimable signal cell, and the seven-day-purged test needs more calendar history. See [the full research report](research/ml/reports/REPORT.md) and the five notebooks in `research/ml/notebooks/`.

```sh
npm run research:export
python3.12 -m venv research/ml/.venv
research/ml/.venv/bin/pip install -r research/ml/requirements.txt
research/ml/.venv/bin/python research/ml/run_all.py
```

The committed snapshot and report do not require the large research artifacts for tests or CI. Fetch the production candle paths and both precomputed exit grids from the `research-edge-phase1-2026-10-02` GitHub Release when reproducing the study:

```sh
npm run research:fetch-data
```

The command downloads all three files and verifies their decompressed SHA-256 hashes against `research/ml/data/snapshot.meta.json`. `exit-grid.csv.gz` and `edge-exit-grid.csv.gz` are derived from the committed `snapshot.csv`, `paths.csv.gz`, and the TypeScript path simulator, so both are regenerable from the path artifact; the release includes them to avoid repeating the 432-cell and 144-cell simulations.

The export contains one canonical row per research observation with an exact next-bar entry candle, labels delivered setups as `source=alert` rather than duplicating them, and omits wallet addresses, Telegram identity, and credential data. It writes compressed seven-day OHLCV paths, the 432-cell legacy exit grid, and the 144-cell fat-tail/ladder grid. The TypeScript path simulator exactly reproduces the existing shadow simulator under the current rule before testing alternatives. Models remain offline and cannot affect live alerts.

### Focused strategy discovery

The separately pushed [FOMO discovery registration](research/ml/preregistration/fomo-strategy-discovery-v1.md) compares support reclaims, trend pullbacks, volume ignition, and a fixed return-ranking model against three exit structures. It tests net trade returns with a full five-minute entry delay, 100–300bps costs, one attempted entry per token/day, and past-only daily selection. The existing September 26–October 2 snapshot is reused development data; it cannot certify a new live edge. Missing entries and path gaps stay unresolved. Models cannot change alerts or the existing shadow challenger.

After fetching the path artifact and installing the Python research dependencies, run `npm run research:discover` for development only. The [discovery report](research/ml/reports/strategy-discovery-v1/REPORT.md), input hashes, candidate specification, and attempted-trade ledger make the comparison reproducible. Tests and CI use synthetic data and do not require the large artifacts or production access.

The frozen October 8 export is published on the data-only [confirmation release](https://github.com/creditcomebackclub/multi-chain-token-scanner/releases/tag/research-discovery-confirmation-2026-10-08), outside Git. `npm run research:fetch-confirmation` verifies the snapshot, decompressed paths, metadata, and exact exporter source against the committed [artifact manifest](research/ml/reports/strategy-discovery-v1/confirmation-artifact.json). Its replay is regenerable from the snapshot and paths:

```sh
npm run research:fetch-confirmation
node --import tsx scripts/replay-strategy-discovery.mjs research/ml/data/strategy-discovery-v1/snapshot.csv research/ml/data/strategy-discovery-v1/paths.csv.gz research/ml/data/strategy-discovery-v1/replay.csv
PYTHONPATH=research/ml research/ml/.venv/bin/python -m scanner_ml.strategy_discovery --snapshot research/ml/data/snapshot.csv --replay research/ml/data/discovery-replay.csv --confirmation-snapshot research/ml/data/strategy-discovery-v1/snapshot.csv --confirmation-replay research/ml/data/strategy-discovery-v1/replay.csv
```

For another authorized read-only export, `node scripts/export-strategy-discovery.mjs --railway --tunnel` temporarily opens the existing Railway SSH connection and closes it after export, without changing Railway variables or deploying. The confirmation cutoff and candidate remain fixed; a later export cannot add newer outcomes to this test. Picking a different candidate after seeing confirmation requires another independent test.

### Optional read-only research collection

Phase 2 research collectors are disabled by default and cannot score, reserve, or send a BUY alert. `REGIME_CANDLES_ENABLED` stores closed 5-minute SOL, ETH, and BNB candles through the same paced candle client used by chart research. `YOUNG_POOL_RESEARCH_ENABLED` records a research-only 10-minute-to-4-hour pool cohort, the same exact-pool GoPlus evidence used elsewhere, sampled market outcomes, and near-zero-liquidity collapses as total losses. When `WALLET_WATCH_ENABLED` is already enabled by the owner, confirmed watched-wallet buys also create identity-free research rows with source-to-detection delay and sampled outcomes; wallet addresses remain in configuration and operational tables and are not added to exports or reports.

`CANDLE_RETENTION_DAYS` controls chart and regime candle retention and remains **35** by default. The committed production snapshot contains 45,081 chart-candle rows over that window, about **1,288 rows per extra day** at the observed rate. Budget roughly **0.4 MiB per added day** (about 12 MiB per 30 added days) using a conservative 320 bytes per row for heap and two indexes; verify the live value with `pg_total_relation_size` because PostgreSQL page fill and text widths vary.

No approved read-only FOMO execution-quote interface is available. With `EXECUTION_COST_LOGGING_ENABLED=true`, the scanner therefore learns costs only from owner-reported FOMO fills: `/entered CONTRACT DOLLARS PRICE` stores the alert reference plus contemporaneous exact-pool DEX price/liquidity, and `/exited CONTRACT DOLLARS_RECEIVED PRICE [FEES_USD]` records the exit snapshot and closes the monitor. `/costs` reports observed median/p75/p90 cost overall, by chain, and by entry-liquidity bucket, together with the preregistered `cost-model-v1` calibration and $50/$250 sensitivity. DEX spot remains a comparison point and is never described as a FOMO fill. No wallet, signing key, or order interface exists. See [the preregistration](research/ml/preregistration/cost-model-v1.md).

Research milestone notifications default on with `RESEARCH_MILESTONES_ENABLED=true`. They use the validated private Telegram health-notice channel and a separate Postgres idempotency ledger, so they never reserve or consume BUY or SCOUT capacity. Set `RESEARCH_COLLECTOR_ACTIVATED_AT` to the original prospective activation timestamp when first deploying this feature; an existing persisted activation record takes precedence. `DB_VOLUME_LIMIT_MB` defaults to 500 and drives one-time warnings at 80% and 90%. The hourly monitor reports the 21-day and preferred 28-day Phase 4 checkpoints, shadow sample/day/evidence gates, collector stalls and recoveries, and storage pressure. `/milestones` lists pending, sent, unavailable-delivery, and not-applicable states.

## Free shortlist mode

Set `SCAN_MODE=shortlist` and `INGESTION_ENABLED=true` to poll the public GeckoTerminal new/trending pool feeds for Solana, Ethereum, BNB Chain, Robinhood, and Base about every 15 minutes. This path makes no Bitquery requests. It keeps pools between 10 minutes and 24 hours old, excludes known stablecoin, wrapped-major, liquid-staking, and established-base-asset symbols, then uses batched DEX Screener requests to confirm the exact pool and add independent liquidity, FDV, and five-minute price-move checks. Rules v2 require at least $20K liquidity on Solana/Robinhood or $40K on EVM chains, $5K five-minute volume, 25 swaps, 15 buyers, and a 1.10 buy/sell count ratio. It risk-checks at most one market-qualified token per chain per refresh with GoPlus. Telegram `/shortlist` shows market-screen matches and `/recent` shows relevant new-token near misses. Optional automatic informational SCOUT pushes require `SCOUT_PUSH_ENABLED=true`, are capped at three per rolling 24 hours, and cannot consume any of the ten daily chart BUY slots.

The public feed is limited and IP-rate-limited, so this is a best-effort watchlist rather than complete chain scanning. It does not provide a trustworthy memecoin category, so exclusions are conservative metadata heuristics and an ordinary speculative token can still appear. It does not compute the full strategy score, track all trades or wallet concentration, verify a live execution quote, accrue rollout observation credit, or send automatic candidate pushes. A listed token may still fail to buy or sell at the shown price; check a live FOMO quote, fees, sellability, and slippage before any order.

## Try it without accounts

Requires Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
```

The demo uses clearly labeled synthetic provider fixtures. It shows a qualifying candidate, duplicate removal, the formatted alert, and a security-outage rejection. It does not contact any provider or send a message. Tests run a PostgreSQL 17 engine through PGlite without requiring Docker.

Build verification: **121 tests passed** and TypeScript compilation passed. The free shortlist Docker build and Railway deployment have also been exercised with live public pool data on all five configured chains.

## Start full observation

1. Obtain a Bitquery token with access to `Trading.Trades` HTTP and WebSocket subscriptions for the chains you intend to collect.
2. Create a private Telegram bot with BotFather. Set its token and your numeric **private chat** ID in deployment secrets. Send `/start` to the bot once after the service is running. Only the configured chat can control it.
3. Copy `.env.example` to `.env`. Set `DATABASE_URL` and `BITQUERY_TOKEN`. Add Telegram credentials for commands and health notices. Leave `PUSH_ENABLED=false`.
4. Run `npm run build && npm start`, or use Docker Compose below.

Optional GoPlus bearer credentials go in `GOPLUS_TOKEN`. Without a token the adapter attempts the public endpoint within a conservative request rate. Account or chain limitations result in `UNKNOWN` and block candidate alerts.

`config/watched-wallets.json` contains inert example addresses for the optional wallet-watch module. Replace them with addresses you are authorized to monitor before enabling `WALLET_WATCH_ENABLED`; the feature is disabled by default.

For local Postgres, install/start Docker, choose a URL-safe `POSTGRES_PASSWORD` in `.env`, and run:

```sh
docker compose up --build -d
docker compose logs -f scanner
```

The compose service supplies `DATABASE_URL` internally. For `npm start` against the compose database, set it separately to `postgres://scanner:<password>@localhost:5432/scanner`.

## Railway

Create a Railway project with a managed Postgres service and deploy this directory as a service. The included `Dockerfile` and `railway.toml` define the build, one replica, and `/health` readiness. Add `DATABASE_URL` as a reference to Postgres's private connection URL and add provider credentials as service variables. For the free path use `SCAN_MODE=shortlist`; for the full path use `SCAN_MODE=full` plus a Bitquery plan that supports the required traffic. Keep candidate pushes disabled for the observation period. Disable sleeping/serverless behavior so commands and scheduled refreshes remain available.

`/live` reports process liveness. `/health` checks Postgres and returns 503 when durable alert delivery is unavailable. Provider failures appear in Telegram `/status` and `provider_health`; a provider outage does not require replacing the running container.

The current Railway deployment runs the free shortlist path. Full-mode provider entitlements and the original rollout gates still require separate live validation before full analysis or candidate pushes can be enabled.

## Behavior

| Area | Implemented behavior |
| --- | --- |
| Free shortlist | Best-effort GeckoTerminal discovery plus candidate-driven DEX Screener exact-pool checks on all five chains, with stale, missing, and partial feeds labeled. No Bitquery traffic or full-strategy score. |
| Chains | Solana, Ethereum, BNB, Robinhood, and Base have distinct IDs. Each Bitquery chain must pass a current confirmed-trade probe. Failed chains reconnect and remain blocked from alerts. |
| FOMO | Routes follow the supplied plan. Base is research-only unless `BASE_FOMO_CONFIRMED=true` is deliberately set after manual verification. Route availability is not inferred from data-provider coverage. |
| Ingestion | Bitquery `Trading.Trades`, quote-side executed USD flow, canonical decimal dedup keys, persistent event IDs, per-chain reconnects, ping/pong, bounded queues, bounded HTTP gap repair. Only recognized DEX families enter the scanner. |
| Helius | Optional confirmed transaction discovery hints using your verified DEX/launchpad program allowlist. It creates candidate identities but does not infer priced swaps or new-pool creation from raw balances. Bitquery owns scored USD flow. |
| Enrichment | Candidate-driven DEX Screener lookups, batches of 30, 30-second cache, exact chain/base-token identity, one selected pool across confirmations. Flow from other pools cannot inflate that pool's liquidity-based score. |
| Risk | EVM and Solana GoPlus schemas; critical control flags, tax changes, holder and creator concentration, and EVM creator-address checks. Missing critical fields remain `UNKNOWN` and cannot trigger automatic pushes. Metadata is escaped in Telegram. |
| Score | The supplied hard thresholds and 25/25/20/15/15 component weights. Exact interpolation is defined in `src/scoring.ts`; thresholds are in `config/rules.json`. Missing candles receive no invented indicator points. |
| Confirmation | Two qualifying snapshots 60–180 seconds apart, same pool, nondecreasing liquidity/buy USD/buy-to-sell USD ratio, and no increase in buy/sell tax. Any failed snapshot interrupts confirmation. |
| Delivery | Private-chat validation, persisted pause/resume, database-serialized reservation, at most ten candidate attempts per rolling 24 hours across free and full modes, and one attempt per token/chain in that window. Ambiguous sends are not retried. Free pushes are explicitly labeled `NEW-TOKEN WATCH`; they do not claim a full score or verified execution. |
| Outcomes | Observe-only qualifying references as well as delivered alerts; 1h/6h/24h prices, liquidity, observed favorable/adverse movement, and configured hit rates. Gaps and missing horizon samples are reported as incomplete. |
| Retention | Raw trades, discoveries, and inactive candidates: 48 hours. Scores, alerts, rule versions, and outcome history remain in Postgres for weekly review. |

## Telegram

- `/start` — validate the configured private chat.
- `/status` — mode, rule ID, rollout approval, chain routes, provider health.
- `/pause` / `/resume` — persist candidate delivery preference; `/resume` cannot bypass rollout or security gates.
- `/shortlist` — in free mode, fresh 10m–24h market-screen matches with separate security status and links.
- `/recent` — in free mode, relevant 10m–24h near misses; in full mode, recent rejected/sub-threshold candidates.
- `/stats` — in free mode, observed first-hit TP1/stop and later TP2 counts for delivered chart alerts; in full mode, results separated by rule version, reference type, and horizon.
- `/shadow` — progress for preregistered forward-only strategy variants, with separate `modeled:flat-bps`, `model:cost-model-v1`, and `observed` cost views, day-block confidence intervals, and the same-period control benchmark.
- `/milestones` — every research checkpoint and its pending, sent, delivery-unknown, or not-applicable status.
- `/entered CONTRACT DOLLARS PRICE` — acknowledge an actual fill from a delivered chart alert in the last 24 hours and arm manual TP/stop/liquidity notifications.
- `/exited CONTRACT DOLLARS_RECEIVED PRICE [FEES_USD]` — record the actual manual exit, exact-pool comparison snapshot, and optional explicit fees; closes the monitor.
- `/costs` — observed execution-cost distributions and the locked model calibration/invalidation status.
- `/positions` — list open position monitors. `/closed CONTRACT` closes one manually.

Health notices do not consume the ten-candidate cap. There is one warning attempt after five minutes of provider degradation and one recovery attempt. Database failure pauses candidate delivery; Telegram command replies and persisted health warnings also wait for database recovery.

## Rollout gate

Do not set `PUSH_ENABLED=true` immediately. Follow [the rollout guide](docs/rollout.md). The code requires seven elapsed observation days with a recent healthy minute record, current chain coverage, zero duplicate sent alerts, and at least 90% one-minute acceptance across qualifying references. Missing acceptance evidence counts as failure.

DEX Screener liquidity and price changes do **not** measure executable price impact. The gate therefore requires separately collected read-only quote/preview evidence for the configured order size. It does not substitute a price change for slippage. There is no automatic wallet connection or order to obtain that evidence.

After review, run `npm run approve-rollout -- path/to/review.json`, then enable `PUSH_ENABLED`. Start with a private one-day dry run without trades. Any threshold/routing scope change invalidates the corresponding approval. When changing scoring code, increment the algorithm revision in `src/config.ts` as well.

## Important implementation limits

- Live Bitquery/Helius and paid account entitlements were not exercised in this build. Initial tests use documented response shapes and synthetic data, not claimed production recordings. Capture real shortlisted responses with `npm run capture -- ethereum <full-token-address>`; review and add them to regression tests before rollout.
- Helius is a discovery-only first integration. DEX-specific swap/new-pool decoding and independent USD pricing are future work. Set `HELIUS_ENABLED=true`, `HELIUS_API_KEY`, and comma-separated `HELIUS_PROGRAM_IDS` only after verifying the program addresses and your plan's `transactionSubscribe` support.
- GoPlus control/concentration gates deliberately reject uncertain evidence, including fewer than ten reported holders. Pool/locker labels do not exempt large holders without verified ownership/lock evidence. This may suppress otherwise interesting candidates.
- Backfill handles inclusive timestamp boundaries and refuses saturated one-second slices or more than 2,000 requests. A gap longer than 15 minutes repairs the recent interval and blocks scoring while the old gap remains inside the rolling hour. It is not silently treated as complete history.
- The candidate evaluation batch is bounded at 30 per minute, with older unevaluated candidates first. Busy feeds and conservative GoPlus limits can delay evaluation; fresh-data checks block late alerts. Monitor throughput and storage during observation before increasing scope. Full-chain ingestion can be substantial.
- Delivery favors avoiding duplicate notifications. A timeout/crash may consume an alert slot even when no message arrived. Telegram offers no transaction shared with Postgres, so exactly-once external delivery is not claimed.
- Outcome excursions reflect collected confirmed trade observations. They are not realized P&L, and liquidity at a historical horizon cannot be reconstructed from a later spot response. Missing data stays missing.

## API references checked during implementation

- [Bitquery Trading.Trades fields, deduplication, network IDs, and USD semantics](https://docs.bitquery.io/docs/trading/crypto-trades-api/trades-api/)
- [Bitquery WebSocket authentication](https://docs.bitquery.io/docs/authorization/websocket/)
- [Robinhood chain identifiers](https://docs.bitquery.io/docs/blockchain/robinhood/)
- [Helius confirmed transaction subscriptions](https://www.helius.dev/docs/rpc/websocket/transaction-subscribe)
- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [GoPlus EVM risk fields](https://docs.gopluslabs.io/reference/response-details), [Solana risk fields](https://docs.gopluslabs.io/reference/response-detail-1), [address security](https://docs.gopluslabs.io/reference/response-details-1)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Railway configuration](https://docs.railway.com/config-as-code/reference)


## Rolling 5-minute scalp watchlist

Set `SCAN_MODE=shortlist`, `CHART_SETUPS_ENABLED=true`, `INGESTION_ENABLED=true`, and `PUSH_ENABLED=true`. Keep `WALLET_WATCH_ENABLED=false` to disable all copied-trader alerts. The existing Railway service performs the work even when the Mac is offline.

The watchlist fills up to ten slots from the existing public discovery feed, distributed across FOMO-tradeable configured chains. Research-only chains cannot occupy a slot. It refreshes every 15 minutes, preserves a pair while its support setup is armed, prioritizes current five-minute activity relative to liquidity, permits older tokens, excludes known majors/stablecoins, and requires pool age >=4h, liquidity >=$50,000, and reported 24h volume >=$100,000. Every selected pair is evaluated each five-minute cycle so an entire rotation no longer consumes the full ten-minute entry window.

Each cycle retrieves up to 500 five-minute USD candles per pair. The API includes verified no-swap intervals as flat OHLC with zero volume (`include_empty_intervals=true`); missing responses are never filled locally. Only closed, valid, consecutive candles are used; at least 80 are required. Support uses confirmed historical pivot lows from the preceding 24 hours, at least two touches separated by 30 minutes and clustered within 4%. The zone is frozen at the touch: 2.5% below to 3.5% above the mean of the two lows. It arms after a >=6% pullback; support expires after 6h or two closes below its lower edge.

A `SUPER AGGRESSIVE 5M BUY` alert fires on the first strong green rejection from a repeatedly tested support zone. It requires volume >=1.2x the preceding 20-bar mean, price above a rising EMA9, and EMA9 no more than 1.5% below EMA21. It deliberately does not wait for SMA50 confirmation or a full break above the support zone. Signal risk above 8% and entries more than ten minutes late are rejected. DEX Screener must confirm the exact pool still has >=$50,000 liquidity and GoPlus must return PASS. The alert fixes a support stop, takes 50% at +5%, moves the runner stop to the actual entry, and takes the remaining 50% at +10%. Targets are gross of fees and slippage. These checks do not guarantee sellability or prevent every rug pull. No orders or exits are placed automatically.

Chart BUY alerts have ten attempts per rolling 24h and a per-token/chain 24h cooldown. Optional SCOUT pushes have a separate three-message allowance and cannot consume BUY capacity. Bootstrap records a baseline without replaying old alerts. Persisted cursors and alert identities prevent restart duplicates; ambiguous Telegram sends are not retried. `/pause` suppresses delivery while scanning continues. `/setups` shows the selected pairs and their last evaluation.

The free monitor samples every delivered chart alert from DEX Screener about once per minute for 24 hours. `/stats` reports whether TP1 (+5%) or the fixed support stop was observed first and whether TP2 (+10%) was later observed. These are spot observations rather than executable fills; brief intraminute touches, fees, slippage, and FOMO execution are excluded. After a real entry, `/entered CONTRACT DOLLARS PRICE` uses the actual fill for +5%/+10% management alerts, keeps the alert's structural stop, moves the remainder to breakeven after TP1, and warns if exact-pool liquidity falls by at least half or below $10,000. It never submits an order.

Every raw 5M setup is also recorded before the live quote, security, pause, cooldown, and quota gates. The same free spot monitor measures those shadow setups for 24 hours, and `/stats` reports their first observed TP1/stop result plus the gate decision. This separates strategy quality from delivery failures and supplies forward evidence for later rule changes.

The research dataset also records every evaluated closed candle as either a qualifying signal or a non-trigger control. It persists rolling OHLCV history plus candle body/wicks, close location, ATR14, volatility, EMA9/EMA21 slopes and distances, SMA50 distance, drawdown from the prior peak, support-zone geometry, prior support-test count, support age, volume ratio, and the result of every signal condition. Signal rows add the first DEX Screener quote, quote lag and divergence from the candle close, liquidity, FDV, market cap, five-minute price change, GoPlus status/reasons/taxes, and delivery-gate decision.

Outcomes use the first DEX quote after detection when available and otherwise the next five-minute candle open as an explicit proxy. The evaluator records MFE, MAE, their timestamps, TP1/stop ordering, TP2 timing, and returns at 15m, 30m, 1h, 3h, 6h, 12h, and 24h. `/research` summarizes seven days of signals and controls. Modeled net returns subtract `RESEARCH_ROUND_TRIP_COST_BPS` (default 200 = 2%); this is a configurable research assumption because FOMO, routing, network, spread, and slippage costs vary and the actual transaction quote is not available to the scanner.

The preregistered Phase 3 shadow cohort starts at `2026-10-03T14:33:12Z` and evaluates the previously selected `trailing | TP1 +8% | fixed 3% | 24h` challenger on new signal and control observations only. `/shadow` reports progress toward 180 resolved signals and 20 entry days. It cannot send or reserve an alert. Flat-bps results are descriptive only; the cost gate requires either complete observed bucket-p75 evidence or complete `cost-model-v1` endpoints while that model remains valid, plus the existing positive expectancy and same-period control-edge intervals and manual owner review.

The research milestone monitor checks at most once per hour. For this production cohort, set `RESEARCH_COLLECTOR_ACTIVATED_AT=2026-10-03T15:22:45Z`; the scanner persists that value for the regime and young-pool collectors and does not overwrite it on restart. Phase 4 becomes ready only after 21 elapsed days and at least 15 distinct UTC observation days in every enabled collector, followed by a separate preferred checkpoint at 28 days. Shadow notifications fire once at 25%, 50%, and 100% of each registered variant's required signals, once at its distinct-day requirement, and once if every automatic evidence gate passes. The final message says owner review is required and changes nothing automatically.

Without `COINGECKO_PRO_API_KEY`, public discovery and candles share a serialized request queue and rate-limit cooldown. With a CoinGecko paid API key, discovery remains on the free route while chart candles use the paid on-chain endpoint and a separate paced client. This allows the ten-chart five-minute cycle to run more reliably without spending paid credits on discovery. The cycle never overlaps itself; outages, rate limits, gaps, or slow requests can delay coverage. This is a forward watch experiment, not a return claim. Original new-token age/security rules remain separate.
