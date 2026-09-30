# Super-aggressive scalp v3 — 2026-09-25

## Live behavior

- Trigger on the first strong green rejection candle at a twice-tested support zone.
- Allow a trigger from the middle of the support zone instead of waiting for a close above its upper edge.
- Require 1.2x the preceding 20-candle volume average.
- Require price above a rising EMA9; allow EMA9 to sit as much as 1.5% below EMA21.
- Do not require price above SMA50.
- Allow pairs four hours or older with at least $50,000 liquidity and $100,000 reported 24-hour volume.
- Reject signal risk above 8%; cap the maximum permitted live entry at 10% risk to the structural stop.
- Expire entry after ten minutes, retain the 24-hour token cooldown, and retain the ten-alert rolling daily cap.
- Keep exact-pool DEX Screener validation and require a GoPlus `PASS`.

The plan remains 50% at +5%, move the remainder's stop to the actual entry, and the final 50% at +10%. No transaction is placed automatically.

## Research snapshot

On 14 currently discoverable trending pairs covering roughly 41 hours, this rule generated 110 raw signals. Applying a 24-hour per-pair cooldown reduced that to 17: 11 reached +5% before the structural stop, two reached the stop first, and four were still open at the end of their available 24-hour window.

The universe was selected using current trending data, so the result contains lookahead and survival bias. The increased count shows that the rule is materially more aggressive; the percentages are not a forecast of live performance.
