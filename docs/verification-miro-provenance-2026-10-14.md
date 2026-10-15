# Miro source-map verification, 14 October 2026

Status: implemented and checked locally. Miro remains disconnected; no board was published.

The requested board maps saved sources to their use in the investigation, policy checks, recommendation, human review and outputs. It must distinguish original records from received clarification, recorded decisions from waiting states, and prepared downloads from published board items. No source reference is fetched automatically.

The shared builder produces sources, saved checks, recommendations, review states and available outputs. It separates cited evidence from records that were merely gathered. A current policy is not presented as the policy used by older checks unless the saved record establishes that relationship. Previous review history remains visible even when the current review field is empty. Historical approvals do not confer fresh permission.

## Local verification

| Check | Result |
|---|---|
| Backend provenance, provider-response and preparation tests | 89 passed, including the legacy handover dependency check |
| Sponsor interface, sessions, reset and downloads | 36 passed |
| Final combined application suite | 481 passed, including the later Arize additions |
| Application build and Sites handoff checks | Build passed; four Sites tests passed |
| Browser inspection | Prepared map opened while disconnected; publishing stayed disabled |
| Browser download | The ambiguous-items case at revision three produced 19 records and 25 labelled connections; the downloaded graph matched the saved case and supported record paths |

The prepared publisher creates cards and connections, then independently reads each expected object back. It does not mark a partial map complete. Missing response identities remain unresolved; recovery does not repost missing objects. Existing verified receipts remain unchanged during readback. These provider behaviours were tested with injected responses, not a Miro account.

The browser check expanded original sources and downloaded the prepared map without making a sponsor request. [Screenshot](diagrams/miro-prepared-map.png), [download verification](../ARTIFACTS.md#excluded-afad409357ed5974), [saved map](../ARTIFACTS.md#excluded-949ed34634d1b690), [backend test log](../ARTIFACTS.md#excluded-beaa2e5a3c5aadf0), [final combined suite](../ARTIFACTS.md#excluded-f700c7983f8a0660).

## Preservation and limits

All twelve cases in the reset-enabled rehearsal survived the checked restart unchanged. The original PostgreSQL demonstration also retained its twelve cases. Fifteen original data files and four earlier preparation archives retained their hashes. No new refund was approved, reserved or submitted in either user-facing preview during these checks. [Preservation record](../ARTIFACTS.md#excluded-1b818b142cac2c64).

This JSON is custom preparation, not a verified native Miro import. Later publication needs a configured board and token, explicit network permission, and account acceptance. Clickable record URLs require an appropriate configured public origin and access to the case. They retrieve the current record and may show a later revision; they are not immutable snapshot URLs. Source references remain quoted text and are not fetched.

The [completed demo-reset verification](verification-demo-reset-2026-10-14.md) remains a separate record.
