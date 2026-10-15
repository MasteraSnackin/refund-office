# Local PostgreSQL office verification — 14 October 2026

The separate office application now uses local PostgreSQL for working cases, investigation claims, recorded review and disabled approval reservations. It was exercised without contacting Supabase or any sponsor service. The original SQLite preview and its approved £20 simulated refund were preserved.

## Automated checks

| Check | Result |
| --- | --- |
| Full application test suite | 247 passed; none failed or skipped. |
| Production build | Passed; Sites output files were generated. |
| Separate Sites worker checks | 4 passed. These are also included in the application suite. |
| Real PostgreSQL workflow harness | 27 checks passed: 20 base migration checks and 7 application workflow checks. |
| Prepared Supabase repository checks | 28 passed using injected responses. These are included in the application suite. |

The PostgreSQL harness applied the frozen first migration and the additive review/recovery migration to a newly created disposable container. It exercised all 62 base synthetic scenarios, tenant isolation, competing claims, stale approvals, duplicate reservations and immutable financial records. Application checks then covered background investigation of the focused pack, evidence holds, explicit reopening, closure, failed claims, lease exhaustion, recovery and an actual local HTTP session → disabled reservation → report → logout flow.

The database container had no network, no published ports and no existing data mounts. It was removed after the run. Test-only approval records belonged to that disposable database; they were not user decisions or approvals in either preview. No payment submission function or endpoint exists in this PostgreSQL application path.

Machine-readable database evidence is in `work/runtime-application/verification.json`. Test and build logs are in the same directory. The earlier first-migration evidence remains separately preserved in `work/supabase-runtime/`.

## Browser rehearsal

The separate preview on port 4273 was checked in the in-app browser:

- Local investigator entry displayed the synthetic workspace and expiry time. Its recommendation panel had no approval or closure control.
- Ending the session cleared the office and returned to profile selection.
- Local reviewer entry exposed the exact £20 reservation action and required a reason. The action was inspected but not submitted.
- The inbox displayed six recommendations awaiting approval, five held cases and one labelled historical remedy.
- The £25.01 policy hold explained that the saved proposal exceeded the investigation's policy limit.
- Evidence cards displayed readable saved order, packing and delivery facts. Their original evidence bodies and fingerprints remained unchanged.
- The decision brief downloaded and stated that no human decision or payment had been recorded for the fresh case.

The preview created **zero new approvals, zero new reservations and zero payments**. Its existing remedy is a supplied synthetic historical fixture. The queue processed all twelve cases and remained healthy after it became empty.

## Restart and data preservation

The new rehearsal was stopped cleanly and resumed using its exact saved marker and owned Docker volume. All twelve case revisions, histories, raw evidence bodies, fingerprints and pending decisions matched their pre-restart values. The worker did not repeat completed investigations. The old session was rejected after restart, and a fresh local profile was required.

The original SQLite preview remained running on ports 4173/4174. All fifteen original database/sidecar/pack files matched their earlier hashes, all twelve original case revisions were unchanged, and the approved mug case's decision and receipt matched exactly. The earlier sponsor and first-migration archives were not regenerated.

The new retained Docker volume belongs only to this synthetic rehearsal. Its container has networking disabled and no published ports. This volume is not included in a handover archive.

## Boundaries of the evidence

The selectable reviewer and investigator profiles are local test identities. Anyone with access to the local preview can choose either profile. These checks do not verify Supabase login, signed tokens, hosted session refresh, real tenant administration or production access controls.

The hosted repository's prepared methods were tested with injected responses only. No live model analysis, speech generation, hosted database call, cloud deployment, sponsor workflow or Stripe request was performed. The local background investigator uses deterministic rules.

A reservation is not a refund. Online authentication, hosted gateway permissions and a separately designed payment execution/reconciliation path still require implementation or account-based verification before a hosted cutover. Nothing in this verification authorises connecting a service or moving money.
