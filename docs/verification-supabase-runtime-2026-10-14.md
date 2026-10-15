# Supabase runtime preparation: local verification

Checked on 14 October 2026. The executable database preparation passes its local checks. The office UI and API still use SQLite; no Supabase account, deployed gateway, sign-in flow or provider connection was tested or enabled.

## Results

| Check | Result |
| --- | --- |
| Application suite | All 192 Node tests passed. This includes 18 new runtime-client checks and eight import/export checks. |
| Application build | Passed; Sites output files were produced. |
| Separate Sites check | All four tests passed. These are also included in the main suite. |
| Actual PostgreSQL execution | All 20 checks passed across 246 SQL round trips, including 53 expected denied or conflicting actions. |
| Synthetic imports | Both generated import scripts applied. Focused: 12 cases and 11 orders. Busy: 50 cases and 46 orders. No memberships or approvals were imported. |
| Investigation outcomes | All 62 cases matched their expected outcomes; investigation created no approvals or new refunds. |
| Existing local data | All 15 baseline database, sidecar and pack-marker hashes matched. All 12 running case revisions were unchanged. |
| Approved rehearsal | The £20 mug approval and simulated receipt were preserved exactly in a private, non-executable archive snapshot. |

The PostgreSQL run used version 16.15 from the cached `postgres:16-alpine` image. Its newly created container had networking disabled, no published host ports and no existing data mounts. The harness used a local Unix socket, did not pull images, and removed its own container after the run. Existing containers and databases were not used.

The applied migration hash matches the final source:

```text
978124369465da09c0e838730a82b6cbeb6b58b7e45db5cf30f3fe7105a40750
```

## What the database run established

- Anonymous callers, anonymously signed-in test sessions, missing identities and users outside the tenant were denied. Row policies hid other tenants' rows, and a cross-tenant order reference failed its foreign-key constraint.
- Investigator and reviewer actions were separated. Browser and service roles could not write the private tables directly. Administrative import remained a separate permission.
- Repeating identical intake or approval commands returned the saved identity. Changed reuse failed. Concurrent workers did not own the same live claim; expired claims acquired a higher version, and stale owners could not finish them.
- Wrong amounts, missing packing evidence, changed policy, stale revisions and changed fingerprints could not produce an approval. Oversized proposal identifiers were rejected.
- Concurrent approvals of duplicate claims reserved the remedy once. Failed attempts rolled back; saved balances remained within order totals.
- Recorded approvals, operations, retry keys and audit events rejected attempted modification.
- The actual asynchronous repository consumed real SQL results through an injected local transport and independently read back saved cases. No HTTP request was made by that bridge.

| Pack | Awaiting approval | Held | Labelled historical remedy |
| --- | ---: | ---: | ---: |
| Focused 12 | 6 | 5 | 1 |
| Busy 50 | 26 | 20 | 4 |

After the scenario checks, explicit test reviewer actions in the disposable database produced three disabled reservations totalling £46.50. These were test fixtures, separate from the user's approved £20 rehearsal refund. There were five imported historical fixtures, zero executable payments and zero provider submissions. No submission or settlement RPC exists in this stage.

## Existing history and export

The selected rehearsal database was copied after stable byte checks and inspected through a private temporary SQLite copy. The source database was not opened by SQLite, so inspection could not create source sidecars or run startup recovery. The exporter preserved raw JSON, approvals, snapshots, fingerprints, operation identities, original retry keys and receipts. The original twelve cases remained unchanged.

The exported history is private and quarantined. Its local reviewer label grants no authenticated cloud authority. It is not accepted by the operational synthetic importer and is excluded from shared preparation archives.

## Limits and remaining work

The harness supplies test-only identity functions and role fixtures. It does not verify real JWT signatures, session expiry at the gateway, deployed Supabase grants, account permissions or login behaviour. The client rejects unsuitable token shapes, but this is not signature verification.

The new repository is not wired into the current application. Authentication, the complete asynchronous application workflow, hosted worker recovery, payment execution and reconciliation, controlled cutover and rollback remain separate stages. The earlier decision-packet archive SQL was not exercised by these runtime tests. Administrative owners retain their database powers.

Tests used the installed dependencies; a fresh dependency installation was not performed. The existing office interface was not changed in this work. See the [runtime guide](SUPABASE-RUNTIME.md) and [migration plan](SUPABASE-MIGRATION.md) for the exact implemented scope and next steps.

## Evidence in the complete project

- [PostgreSQL verification and source hash](../ARTIFACTS.md#excluded-21c91e21c6a615bc)
- [Database execution log](../ARTIFACTS.md#excluded-0a9a56133ee8bb8b)
- [Application test output](../ARTIFACTS.md#excluded-66cf9345efc99d8e)
- [Build output](../ARTIFACTS.md#excluded-a2cc7c97df5f916b)
- [Sites checks](../ARTIFACTS.md#excluded-1e1af0d93cc6f8cb)
- [SQLite preservation check](../ARTIFACTS.md#excluded-4d26984ed4525c8c)

Reproduce preparation with `npm run supabase:prepare`, and database checks with `npm run test:supabase:local`. The ordinary `npm test` command never starts Docker. No command in this record enables an external service.
