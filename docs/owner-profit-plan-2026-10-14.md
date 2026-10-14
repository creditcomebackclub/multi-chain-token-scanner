# Owner profit plan — locked October 14, 2026

The owner explicitly selected this plan in chat before its implementation or retrospective re-simulation: sell 50% at +100% from the actual entry, then trail the remaining 50% at 20% below its highest observed price. This is an owner-selected plan, not promotion of a research winner or a claim of profitability.

- Keep the existing entry range, ten-minute expiry, structural stop, security policy and delivery limits.
- TP1 is twice the actual fill price. Sell half when that price is reached.
- Activate the runner trail only after TP1. Its stop is the greater of actual entry and 80% of the highest observed post-TP1 price. The peak and stop are persisted in Postgres, and neither may decrease.
- There is no fixed TP2 and no automatic 24-hour exit in this owner plan. Actual position monitoring remains manual and continues until a closing event or owner closure. A TP1 notice is not a recorded sale or an executed order.
- New alerts carry their own plan version. Already delivered alerts and already registered positions retain their stored exits.
- The legacy +5%/+10% offline studies and the locked Phase 3 +8%/ATR challenger keep their original exit definitions. Their results do not validate this new owner plan.

## Retrospective ten-call comparison

Push this record separately before calculating results. Replay the ten delivered alert IDs frozen in the October 14 alert audit, rather than selecting a new cohort after viewing returns. Use $50 at the first recorded delivery-time quote only when it satisfies the stored entry range and expiry; also report reference-price entries as an explicitly idealized diagnostic. Use stored spot samples, targets filled at their levels, and the first observed crossing price when worse than the stop. Subtract the existing modeled 200 bps round-trip cost only for closed trades.

Do not invent a 24-hour exit: if a path ends before a stop or runner exit, report it as unresolved with a last-observed value separately. A later +100% touch after an initial stop cannot count as a winning trade. Report material sampling gaps and exclude uncertain paths from a reliable realized-profit subtotal. No new optimization, threshold search or model fit is part of this comparison; it is retrospective and cannot establish a forward edge.

## Deployment and rollback

Merge the implementation before deploying, and deploy only from main. New code must continue reading legacy stored plans and positions. To roll back the new default, change the plan builder back to the legacy exits while keeping the nullable-target and trailing-position readers; do not deploy an old image that cannot read new trailing positions. No historical data migration or relabeling is authorized.
