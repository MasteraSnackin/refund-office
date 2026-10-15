# Supabase working-store preparation

This guide describes the first executable stage of the working-database migration: a separate PostgreSQL schema, synthetic imports and an asynchronous client. A subsequent [local office rehearsal](LOCAL-POSTGRES-OFFICE.md) now connects the interface, background worker and review controls to that schema through a local SQL transport. The original preview still uses SQLite. No Supabase account, authentication gateway or hosted endpoint has been contacted. The ordinary local database path cannot submit or settle a payment. A separate [hosted application](HOSTED-SETUP.md) and optional [Stripe test execution module](../integrations/supabase/runtime/PAYMENT-EXECUTION.md) are now prepared but remain disconnected.

## What is implemented

| Component | Behaviour |
| --- | --- |
| [Runtime migration](../integrations/supabase/runtime/001_runtime.sql) | Tenant-scoped orders, evidence, cases, policy versions, history, investigation leases, human approvals and reserved operations. |
| [Database contract](../integrations/supabase/runtime/CONTRACT.md) | Bounded workflow actions, exact inputs, role checks and response formats. An investigation can stop at Review or a recorded historical remedy. |
| [Asynchronous client](../server/supabase-runtime-repository.mjs) | Explicit connection gates, a caller-supplied user session, stable write identities, bounded requests and independent case readback. Unknown write outcomes stay unresolved. |
| [Synthetic preparation](../scripts/prepare-supabase-runtime.mjs) | Deterministic imports for the 12-case and 50-case packs, with fixed fictional tenant identities, counts and hashes. Imports create no members or approvals. |
| [SQLite archive exporter](../server/supabase-import.mjs) | Reads a verified temporary copy of an explicitly named source. Preserves raw approvals, snapshots, fingerprints, retry keys and receipts as non-executable history. |
| [Local PostgreSQL checks](../scripts/test-supabase-runtime.mjs) | Creates its own disposable database from a cached image, with networking disabled and no host ports or existing database mounts. It removes that container after testing. |

The operational schema is independent of the earlier decision-packet archive. Applying one does not apply the other. The application does not select this new client merely because a setting or credential exists.

## Keep the demonstration offline

The existing demo launchers continue to force external services off. No changes to credentials are needed for the checks below.

```sh
npm run supabase:prepare
npm run test:supabase:local
npm test
npm run build
```

Preparation only writes local files. The database test requires a local Docker daemon and the already-cached `postgres:16-alpine` image. It refuses to pull an image, uses `--network=none`, and does not use existing project containers. The ordinary application test command does not start Docker. The test harness supplies a test-only `auth.uid()` implementation; this exercises PostgreSQL roles and policies, not Supabase login or JWT verification.

Generated imports and mappings are in `migration-prep/`. A separate migration add-on archive is supplied alongside the earlier sponsor pack. Neither archive is a standalone application. Reuse the complete project for running the demo and tests. Private SQLite snapshots are excluded from both shared packs.

## Approval remains a distinct human action

An investigator claims work with an expiring lease and a monotonically increasing claim version. It proposes an interpretation; database checks validate it against the saved order, evidence and policy. It cannot create an approval or a new refund operation.

A reviewer supplies the exact saved revision, amount, facts fingerprint, reason and a stable command identity. The database rechecks those facts and the remaining balance while holding its mutation lock. It saves one approval and one reservation together. The resulting case says `approved-not-submitted`; the operation says `reserved` and `submissionEnabled:false`. There is no submission or settlement function in this stage.

New fingerprints use the explicitly named `postgres-jsonb-v1` scheme. They do not replace or reinterpret the existing SQLite fingerprints. An archived `local-reviewer` approval preserves what happened locally; it does not establish an authenticated cloud reviewer or authorise a later payment.

If a write times out, the client does not assume failure or create a fresh identity. It reports an unresolved result so the saved record can be inspected using the original identity. A successful response is followed by a separate case read before intake, investigation completion or approval is reported as verified.

## Connection settings prepared for later

The client requires all three deliberate gates before reading credentials or requesting a user session:

- `REFUND_OFFICE_NETWORK=enabled`
- `REFUND_OFFICE_WORKING_STORE=supabase`
- `REFUND_OFFICE_ENABLED_INTEGRATIONS` contains `supabase-runtime`

These are activation requirements, not instructions to enable them now. The earlier archive's `supabase` permission does not enable working storage. The client also requires a standard HTTPS Supabase project origin, a publishable key and a current non-anonymous user session. Privileged project keys are rejected. Reading token claims locally only rejects unsuitable inputs; the future Supabase gateway must verify signatures, and database functions derive identity from `auth.uid()` and tenant membership.

Do not paste keys into documentation or commit filled configuration files. No credentials or membership are supplied in these imports. Fixed synthetic tenant identities are not account identifiers.

## Remaining account acceptance and cutover work

1. Configure and exercise the prepared hosted sign-in and repository boundary in a separately authorised synthetic project. Preserve the local rehearsal and its test profiles; they do not verify online identity.
2. Verify real sign-in, session expiry, tenant membership and gateway permissions in a separately authorised synthetic Supabase project. Local database tests cannot establish those account-specific behaviours.
3. Verify the implemented review and investigation recovery transactions through the hosted gateway. Production policy administration and reviewer-management screens remain absent; the prepared hosted workflow still needs account acceptance.
4. Verify the separately prepared test executor against an authorised Stripe test account. It requires a new exact execution authorisation, dedicated role, saved intent and independent provider retrieval. Keep the ordinary workflow reservation-only; a lost write without a known refund identity must not be reposted.
5. Rehearse a controlled cutover with one authoritative writer and payment executor. Reconcile counts, identities, amounts, receipts and unresolved operations, and test rollback before accepting real data.

The [migration plan](SUPABASE-MIGRATION.md) describes these stages and their acceptance evidence. The [verification record](verification-supabase-runtime-2026-10-14.md) records the actual local checks and their limits.

Database guidance used for this preparation: [Supabase database functions](https://supabase.com/docs/guides/database/functions), [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security) and [PostgreSQL locking](https://www.postgresql.org/docs/current/explicit-locking.html).
