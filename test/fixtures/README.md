# Fixture provenance

These are **synthetic test fixtures** built against the official Bitquery Trading.Trades, DEX Screener, GoPlus, and Helius response structures cited in the project README. Addresses and metrics are examples. They are not live production recordings or assertions about the risk of any real token.

`AmountsInUsd.Base` deliberately disagrees with the quote leg to exercise executed-USD normalization. The EVM factory differs from the pool to prevent a pool-identity regression. Metadata includes HTML characters to exercise escaping. Tests modify these fixtures to simulate duplicate legs, missing fields, critical risks, gaps, and malformed metadata.

Before rollout, add sanitized real account captures from `npm run capture` and confirmed Helius notifications. Record their capture time, chain, provider/API version where available, and any redactions. Never store headers, API keys, bot tokens, or deployment credentials.
