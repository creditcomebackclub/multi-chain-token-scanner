# Five-minute buy alerts — September 13, 2026

Deployed 23953ed8-10fc-4808-9e8b-5867c1e98562. Runtime verified: module present, CHART_SETUPS_ENABLED=true, PUSH_ENABLED=true, paused=false.

The existing causal support-reclaim detector is unchanged. New alerts provide a rule-based manual entry plan:
- Entry range: support-zone upper edge through 1% above signal close.
- Expiry: ten minutes after the signal candle closed, not ten minutes after Telegram receipt.
- Stop: 0.5% below support-zone floor. This is a proposed price exit rule, distinct from the detector's two-close structural invalidation.
- Take profit: sell half at +50% from actual fill. Alert example uses signal close. Remainder is manually managed.
- Price quotes outside the range, older than 60 seconds, from the future, or after expiry cannot trigger a buy alert; freshness is checked again after security checks.
- Market liquidity, GoPlus PASS, global pause, shared ten-per-day cap, and duplicate prevention remain required.
- Plan version and numeric levels are stored with each new chart alert in existing JSON data; no schema migration.

These are signal levels, not executable quotes, position tracking, automatic orders, or follow-up exit notifications. Costs are excluded from displayed percent targets; gaps or removed liquidity can cause losses exceeding the stop.

Verification: full check passed 92 tests; then additional worker-level anti-chasing and saved-plan assertions passed with the 12-test focused chart suite. No real order or test Telegram message was sent.

AKE source: saved sent alert 27c30716305c1c590f239df5af81b0c3edba4a400d3f56ce810c0c9edf668441. Candle closed Sep 13 09:50 Arizona, Telegram sent 09:53:36. The accompanying drawing uses actual exact-pool GeckoTerminal candles. The depicted entry/stop/target are retrospective illustrations of the new rules and were not included in the original watch alert. Original entry window has expired.

Chart artifacts: outputs/ake-chart/{ake-buy-setup.png,ake-buy-setup.pdf,candles.json,plan.json,draw.py}. The right-hand target diagram is not a price forecast. Reproduce with matplotlib installed and the saved candles.json (draw.py also accepts the original temporary download path).
