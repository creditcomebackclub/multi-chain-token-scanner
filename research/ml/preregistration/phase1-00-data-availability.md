# Phase 1.0 preregistration: data availability audit

- **Locked data:** production snapshot exported `2026-10-02T01:35:25.100Z`, CSV SHA-256 `416f4f04858e9476486a22aff2b0ef229f1dd245d93fb3ab15141a27f982bbd7`, plus its release-backed path artifact. No external market data may be added to the offline result.
- **Question:** Which requested covariates are present at detection time, and what fraction of observations have usable values?
- **Population:** every canonical snapshot observation, reported overall and by `signal`/`alert` versus `control`; database-only fields may be audited from the export query/schema but cannot be analyzed unless included point-in-time in the locked export.
- **Fields:** pool age; buyer, seller, and swap counts and rolling changes; liquidity and its change; FDV; market cap; wallet-watch events; and SOL, ETH, and BNB major-asset candles.
- **Primary metric:** non-null, finite point-in-time coverage percentage with numerator and denominator, plus provenance (`snapshot`, `path`, `database only`, or `absent`).
- **Decision rule:** missing fields are marked unavailable and every dependent analysis is skipped or narrowed. No proxy may be invented after seeing outcomes.

