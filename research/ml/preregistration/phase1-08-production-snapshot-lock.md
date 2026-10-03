# Phase 1 production snapshot lock

The Phase 1 hypotheses, populations, metrics, and success criteria were committed
before the production refresh. This file freezes the exact refresh used for the
final report; it changes none of those specifications.

- **Exported at:** `2026-10-02T14:54:13.150Z`
- **Observation cutoff:** `2026-10-02T14:45:00Z`
- **Snapshot rows:** 11,275
- **Snapshot CSV SHA-256:** `1aea41b8e94dde453f19395984a5495527a6ff5e5a643cd515f61f034b4c02d6`
- **Path CSV SHA-256 (decompressed):** `6de17c8e98a26ce4d9fe8804a3d236942bca3f1818a38ccc4fc16c146c49f1a7`
- **Legacy grid CSV SHA-256 (decompressed):** `8a7e45917704f76db4a00f6d0f12e9614244c55f098a67f4002b5a890a1dd3f1`
- **Phase 1 edge-grid CSV SHA-256 (decompressed):** `46a1faa38d9a4871aefb17932b8e5f888549cf0528a978ae897bc70ee9a9eab9`
- **Simulator parity:** passed for all 11,275 snapshot rows
- **External market data:** none

The original audit preregistration named the earlier committed snapshot because
it was the only frozen artifact then available. The refresh uses the same
production tables and point-in-time observation records, adds the preregistered
context columns and seven-day paths, and includes observations accumulated before
the cutoff above. No outcome-dependent field or external series was added.
