# Cost model v1: conservative execution-cost replacement

- **Locked before implementation:** this specification is effective at the Git commit that first adds this file. No code may compute `model:cost-model-v1` shadow costs before that commit. The model is not fitted to strategy outcomes or owner fills.
- **Purpose:** estimate round-trip execution drag when an approved read-only FOMO quote is unavailable. It is a conservative replacement for the Phase 3 cost gate, not an execution quote and not a prediction of any individual fill.
- **Provenance:** every reported cost is labelled exactly `observed`, `model:cost-model-v1`, or `modeled:flat-bps`. Missing evidence is `not available`; one provenance is never silently substituted for another.

## Observed owner fills

An observed round trip begins with the existing manual `/entered CONTRACT DOLLARS PRICE` command and ends with `/exited CONTRACT DOLLARS_RECEIVED PRICE [FEES_USD]`. Both commands record the exact chain and pool plus a contemporaneous exact-pool DEX Screener spot-price and liquidity snapshot. The entry also retains the original alert reference price and alert-time DEX snapshot.

For a completed trade:

- entry slippage versus reference, in bps: `(actual entry price / alert reference price - 1) × 10,000`;
- entry slippage versus contemporaneous spot, in bps: `(actual entry price / entry spot price - 1) × 10,000`;
- exit slippage versus contemporaneous spot, in bps: `(exit spot price / actual exit price - 1) × 10,000`;
- explicit fee bps: `FEES_USD / entry DOLLARS × 10,000`, or zero when the optional value is omitted;
- realized round-trip cost, in bps: `max(0, entry-vs-spot slippage + exit-vs-spot slippage + explicit fee bps)`.

The alert-reference comparison is diagnostic and is not added to realized cost because intervening market movement is not execution cost. Negative combined slippage is floored at zero rather than treated as a trading edge. Report count, median, p75, and p90 overall, by chain, and by entry-liquidity bucket: `<$50k`, `$50k–<$100k`, `$100k–<$250k`, `$250k–<$1m`, and `≥$1m`.

## Locked conservative model

The primary position size is `SHADOW_POSITION_USD`, default **$50**. A fixed **$250** sensitivity row is also reported. For position size `Q`, exact-pool USD liquidity `L_entry` at entry and `L_exit` at exit, platform fee `F` bps per side, and per-transaction network estimate `N` USD:

1. Treat usable pool-side liquidity as half the reported pool liquidity.
2. Approximate one-side price impact as `Q / (L / 2)`.
3. Multiply each side's impact by a locked pessimism multiplier of **1.5**.
4. Compute round-trip impact bps as `1.5 × [Q/(L_entry/2) + Q/(L_exit/2)] × 10,000`.
5. Add platform fees `2F`.
6. Add two network transactions: `(2N/Q) × 10,000` bps.
7. The final modeled round-trip cost is the larger of the sum above and a locked **100 bps floor**.

The model deliberately charges a full-position exit even when a strategy scales out, making the estimate pessimistic. There is no data-driven coefficient fitting or later parameter adjustment within v1.

`FOMO_FEE_BPS_PER_SIDE` supplies `F`; the locked conservative default is **100 bps per side** when unset and is labelled an assumption. Per-transaction network estimates are configurable, with these locked defaults: Solana **$0.10**, Ethereum **$5.00**, BNB Chain **$0.20**, Robinhood **$0.20**, and Base **$0.20**. Configuration may replace a default to reflect an externally documented fee, but changing the 1.5 multiplier, formula, floor, bucket boundaries, or calibration rule requires `cost-model-v2` and a new preregistration.

For completed owner trades, `L_entry` and `L_exit` are the command-time DEX snapshots. For shadow signals, entry liquidity is the recorded exact-pool signal snapshot and exit liquidity is the closest recorded exact-pool monitoring sample within ten minutes of the simulated exit. A row missing either endpoint is `not available` under this model and cannot help a cost gate. Control rows without two exact-pool liquidity endpoints remain `not available` for model and observed views; the existing flat-bps control comparison remains visible but cannot itself satisfy the cost condition.

## Calibration, fixed in advance

For every completed owner round trip with both liquidity endpoints, compare its `observed` cost with the model estimate at that trade's actual entry size. Report:

- coverage: the share for which modeled cost is at least observed cost;
- median and p90 positive underestimation, where underestimation is `max(observed - modeled, 0)` bps.

The model is never re-fit to those fills. Before 20 comparable observed round trips, status is `valid — calibration not yet evaluable`. At 20 or more, v1 becomes permanently **invalidated** when more than **25%** of comparable trades have observed cost greater than modeled cost by more than **1 bp**. Invalidation is sticky even if later observations would lower that share. Restoring model eligibility requires a separately preregistered `cost-model-v2`.

## Shadow and promotion use

The shadow report keeps three independent views:

- `modeled:flat-bps`: the existing fixed deduction; descriptive only and never promotion-eligible;
- `model:cost-model-v1`: row-level v1 costs where both liquidity endpoints exist;
- `observed`: the p75 observed cost of the row's entry-liquidity bucket, and `not available` when that bucket has no completed observed trade.

An observed view can satisfy the cost condition only when every signal included in its primary expectancy has an observed bucket estimate. The v1 model view can satisfy the cost condition only when every signal included in its primary expectancy has both liquidity endpoints and v1 has not been invalidated. Sample-size, distinct-day, positive expectancy-interval, positive same-period edge, and manual owner-review requirements remain unchanged. No cost view promotes a strategy automatically.
