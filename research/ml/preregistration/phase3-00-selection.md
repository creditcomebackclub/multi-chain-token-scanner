# Phase 3 shadow-variant selection

- **Locked:** 2026-10-03T14:33:12Z
- **Purpose:** select forward shadow variants from evidence that existed before Phase 3 implementation.

Phase 1 did not mark any new hypothesis as supported or as "not estimable but promising." The fat-tail grid had 126 estimable in-sample cells and all had negative expectancy; its seven-day out-of-sample comparison was not estimable. Pool-age, order-flow, and regime hypotheses lacked the required forward coverage, so none has a pre-registered positive direction to promote into shadow testing. The AVOID hypothesis was not supported. Position sizing was descriptive rather than an entry or exit variant.

Accordingly, Phase 3 will run only the previously locked challenger required by the program: `trailing-tp8-fixed3-24h-v1`. No Phase 1 result is re-labelled as promising after inspection, and no AVOID annotation will be added.

The missing-data hypotheses may be registered later, after the separately reviewed Phase 2 collectors have produced enough prospective observations. Any such registration requires a new commit made before its cohort start.
