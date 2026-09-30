# Security data audit — September 13, 2026

The scanner remains in free shortlist mode with chart setups and candidate pushes enabled. Trader-wallet alerts remain disabled. No market or security thresholds were relaxed.

## Fresh checks of six saved UNKNOWN market matches

| Token | Chain | Fresh result | Evidence |
|---|---|---|---|
| DAYC | Base | UNKNOWN | GoPlus reports `is_open_source=0`; major contract flags and taxes remain unavailable. |
| 属兔 | BNB | REJECT | Holder data became available and exceeds concentration limits. |
| LSBK | Base | REJECT | Creator concentration exceeds the limit; source is not verified and other fields remain missing. |
| ALL | Solana | UNKNOWN | Current GoPlus response has `creators: []`. |
| Stunk | Solana | UNKNOWN | Current GoPlus response has `creators: []`. |
| GOM | Ethereum | REJECT | Holder concentration exceeds the limit; sell restrictions/tax evidence remains incomplete. |

These are fresh security rechecks of saved candidates, not fresh buy recommendations. Market conditions and pool age were not requalified for sending historical alerts.

## Compatibility repair

Live Solana responses use `creators`, while the parser previously required `creator`. The parser now recognizes either and examines both if both are returned. Empty, malformed, or incomplete lists still return UNKNOWN. A malicious flag in either field still rejects the token. This change does not make the currently empty ALL/Stunk creator lists pass.

83 tests passed, including current-schema acceptance, malformed/empty evidence blocking, and conflicting risk preservation. Deployment `53285dae-614d-46da-b95f-652a380a36c2` succeeded.

## Alternate source investigation

Public Rugcheck reports returned creator addresses for ALL and Stunk. At the time checked, Stunk's report had an empty risk list and ALL's report included a copycat warning. This is not a guarantee of safety, evidence of profitable entry, or an equivalent replacement for the existing creator malicious-address check. A GoPlus address-security request for Stunk's creator using `chain_id=solana` returned code 5000/system error; it did not verify the creator. No Rugcheck-based automatic PASS fallback was enabled.

Primary references:
- https://docs.gopluslabs.io/reference/response-details (missing contract/tax fields are unknown, especially for closed-source contracts)
- https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=ASoQZA3Dee2HU34Vwx3b5SAtTaczJtZcyx1T413nDALL
- https://api.rugcheck.xyz/v1/tokens/ASoQZA3Dee2HU34Vwx3b5SAtTaczJtZcyx1T413nDALL/report
- https://api.rugcheck.xyz/v1/tokens/FLk6FKAN26m1FT4ucguwy3uHBMzLKcEu8KMTYD2Zpump/report
