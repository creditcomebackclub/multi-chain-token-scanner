# Multi-chain token scanner

A runnable TypeScript service implementing the scanner's core path: confirmed trades → deduplication → rolling flow → market enrichment → contract-risk gate → scoring → two snapshots → capped private Telegram alerts.

It has no wallet integration, transaction signing, or trade execution. An automated risk check or high score does not establish that a token is safe or predict a return.

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

Build verification: **113 tests passed** and TypeScript compilation passed. The free shortlist Docker build and Railway deployment have also been exercised with live public pool data on all five configured chains.

## Start full observation

1. Obtain a Bitquery token with access to `Trading.Trades` HTTP and WebSocket subscriptions for the chains you intend to collect.
2. Create a private Telegram bot with BotFather. Set its token and your numeric **private chat** ID in deployment secrets. Send `/start` to the bot once after the service is running. Only the configured chat can control it.
3. Copy `.env.example` to `.env`. Set `DATABASE_URL` and `BITQUERY_TOKEN`. Add Telegram credentials for commands and health notices. Leave `PUSH_ENABLED=false`.
4. Run `npm run build && npm start`, or use Docker Compose below.

Optional GoPlus bearer credentials go in `GOPLUS_TOKEN`. Without a token the adapter attempts the public endpoint within a conservative request rate. Account or chain limitations result in `UNKNOWN` and block candidate alerts.

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
- `/entered CONTRACT DOLLARS PRICE` — acknowledge an actual fill from a delivered chart alert in the last 24 hours and arm manual TP/stop/liquidity notifications.
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

Without `COINGECKO_PRO_API_KEY`, public discovery and candles share a serialized request queue and rate-limit cooldown. With a CoinGecko paid API key, discovery remains on the free route while chart candles use the paid on-chain endpoint and a separate paced client. This allows the ten-chart five-minute cycle to run more reliably without spending paid credits on discovery. The cycle never overlaps itself; outages, rate limits, gaps, or slow requests can delay coverage. This is a forward watch experiment, not a return claim. Original new-token age/security rules remain separate.
