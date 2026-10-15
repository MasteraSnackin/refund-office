# Supabase working-database migration

The first implementation stage includes a separate operational SQL migration, asynchronous repository, deterministic synthetic imports and an isolated PostgreSQL test harness. See the [runtime guide](SUPABASE-RUNTIME.md) and its [verification record](verification-supabase-runtime-2026-10-14.md). The next [local application stage](LOCAL-POSTGRES-OFFICE.md) connects the office interface, worker and review actions to PostgreSQL on this device, with selectable test profiles and disabled payment submission. The original preview remains on SQLite. No Supabase connection, cloud deployment or real login flow has been enabled. The earlier decision-packet archive remains separate. [Hosted identity and API code](HOSTED-SETUP.md), a shared sponsor-action ledger and the optional test executor are now prepared; account acceptance and cutover remain future work.

Begin with a separate Supabase project containing synthetic records. Keep payment submission disabled throughout schema and migration testing. Account access, database behaviour, row-level security and real service permissions still need verification.

## Target model

Use a merchant workspace as the tenant boundary. Keep tenant identity in every operational row and every composite relationship. The case, order, approval, operation and intake event must belong to the same tenant. Do not infer tenant membership from an identifier supplied by the browser.

| Target table or responsibility | Purpose and constraints |
| --- | --- |
| `tenants` and `tenant_memberships` | A merchant workspace and authenticated users with explicit reviewer or operator roles. Membership changes are privileged actions. |
| `orders` and `order_lines` | Authorised order identity, currency, total, line prices and ordered quantities. Store monetary values as integer minor units. A tenant-scoped source identity prevents duplicate imports. |
| `evidence_records` | Source, source reference, captured time, content hash, immutable content/version and provenance. Synthetic data carries an explicit flag. New evidence creates a version rather than overwriting facts behind an approval. |
| `cases` and `case_evidence` | Complaint, order reference, stage, outcome, revision and links to exact evidence versions. Use a tenant-scoped case identifier. |
| `policy_versions` | Immutable limit and rules versions. The case and approval reference the version evaluated. |
| `case_events` | Append-only action records with tenant, case, event sequence, authenticated actor or worker identity, action, timestamp and public explanation. Never store model hidden reasoning or credentials. |
| `approvals` | Authenticated reviewer, reason, decision time, amount, currency, order/line/issue, provider, policy version, case revision and canonical facts fingerprint. Approval cannot be supplied by an intake worker. |
| `refund_operations` | Exact original payload, tenant/order/line/issue uniqueness, idempotency key, approval reference, state, submission time and provider receipt. Keep uncertain operations instead of replacing them. |
| `intake_requests` | Tenant-scoped unique event identity, payload hash, case reference, status, attempts and safe error. Same identity and same payload returns the saved case; conflicting reuse fails. |
| `job_claims` or `work_items` | Claim owner, lease expiry, attempt count, next eligible time and a fencing version for durable investigation/payment workers. |

Composite foreign keys and server-side checks must prevent a row from pointing into another tenant. Keep a unique operation constraint on `(tenant_id, order_id, line_id, issue)`. A provider account must also be unambiguous for that tenant and operation; changing it must invalidate an unsubmitted approval rather than reuse authority across accounts.

The existing private archive can remain a separate output store. Its per-user ownership is useful for the current archive experiment but is not a substitute for this tenant model.

## Authentication and access

The original `local-reviewer` label must not become a trusted cloud identity. The prepared hosted API validates a signed-in session and tenant membership before acting; its real account behaviour still needs verification. The server supplies the actor to the transaction; it ignores any actor or tenant authority claimed in an input body.

Enable row-level security on every exposed table. Anonymous users receive no case access. Reviewers can read only their permitted tenant and perform narrowly defined review actions. A user in two tenants must choose a permitted tenant context explicitly. Direct browser writes must not create approvals, operation reservations, receipts or job leases.

Expose bounded server transactions for workflow actions rather than a general case-update endpoint. If a security-definer database function is used, give it a controlled owner, an explicit safe search path, qualified table names and narrow execute grants. Verify whether its owner bypasses row-level security and implement tenant checks inside the function accordingly. A service-role credential remains server-side and does not make caller-supplied tenant data trustworthy.

Worker credentials should have only the functions needed for their role. Intake investigators cannot approve or submit payments. The separate payment executor can claim a newly authorised execution linked to the original reservation and write a checked result. It cannot manufacture approval or change the original payload. Administrative access is still powerful; this design does not claim a tamper-proof ledger.

## Preserve the payment boundary

The operational workflow and optional execution module implement these transaction boundaries. Verify them through the real gateway before activation:

1. Investigate against an exact evidence snapshot and policy version. Save the advisory proposal and deterministic checks. Stop at Review.
2. Receive a real review action with the expected case revision, exact amount, facts fingerprint and reason. Verify the authenticated reviewer and tenant membership.
3. Lock the relevant case and order balance, then recheck current evidence, policy, duplicate remedies and reserved balance. Save the approval, immutable original payload and unique operation reservation atomically. Competing requests must yield one operation.
4. Obtain a new explicit reviewer authorisation for the original approval, exact amount and test-account/payment mapping. A dedicated executor claims that separate execution. Before first submission, revalidate the bound facts and save submission intent; the original idempotency key must already exist.
5. Submit outside the database transaction. Keep the external request bounded. A successful HTTP write response alone is insufficient: independently retrieve and match the provider record to the saved operation.
6. Commit the verified result using the operation identity and current claim version. A lost response or crash leaves an uncertain operation for reconciliation with its original payload and key. It must never create a replacement identity.

A database transaction cannot atomically commit a remote Stripe refund. The gap between recorded submission intent and the remote result is an expected recovery state. Preserve it in the design and tests. In the new execution module, a lost response without a saved refund identity stays blocked from another POST. Only a known identity can be independently retrieved; lease expiry does not grant permission to resubmit.

## Replace process locks with durable claims

The original SQLite engine's promise locks protect one Node process. The PostgreSQL workflow instead atomically assigns an investigation lease and increasing fencing version; the separate payment module has its own claims. A second worker cannot claim it before the lease expires. A stale worker must fail any database state update after a newer claim has taken ownership.

Lease expiry is not proof that a remote payment failed. If submission may have started, the next worker enters reconciliation rather than creating a new refund. Keep the original execution and provider idempotency key. Reconciliation requires a saved refund identity; a missing identity remains blocked from replay. Separate investigation claims from payment claims so an intake retry can never cross Review.

Use database time for lease comparisons. Define bounds on attempts and payload sizes. After repeated failure, retain a visible error and require a reviewed recovery action. Do not delete failed work to make the queue appear healthy.

## Migration sequence

| Phase | Work | Required acceptance evidence |
| --- | --- | --- |
| Design and local contract | Define repository methods, state transitions, canonical hashing, tenant membership and transaction boundaries. Keep the existing SQLite implementation as the reference. | Contract tests agree on proposals, approval invalidation, duplicate prevention and uncertain payment behaviour. |
| Disposable synthetic database | Implement versioned migrations and restrictive grants in a separate project. Load only the explicitly marked staging datasets. | Migration applies cleanly; anonymous access fails; two tenants cannot read or mutate each other's records; invalid cross-tenant references fail. |
| Read and investigation path | Implement tenant-scoped reads and intake transactions. Replace process scheduling with bounded claims. Keep submission disabled. | Repeat events return one case; changed payload reuse fails; two workers claim once; lease expiry and crash recovery retain evidence and stop at Review. |
| Review and reservation | Attach authenticated reviewers to approval transactions. Add order-balance locking and immutable operation payloads. Keep submission disabled. | Stale, changed, cross-tenant or unauthorised approvals fail; competing approvals create one reservation; a worker credential cannot approve. |
| Provider contract tests | Exercise submission and reconciliation using injected provider responses. | Failures before/after reservation, before/after submission and before result commit preserve one operation/key. Old claims cannot overwrite a newer result. |
| Authorised Stripe test account | Enable only test mode in that separate project after account access and the preceding checks are verified. | Human approval precedes submission; independent readback matches amount/currency/identity; restart and lost-response tests create no duplicate refund. |
| Controlled cutover | Freeze writes, export and reconcile the source, validate the target, then switch one authoritative backend. | Counts, identities, amounts, fingerprints and unresolved operations match; old workers cannot submit; the operator can identify the active store. |

Do not load real customer data into the first project. The focused and busy datasets have executable imports for the new operational schema. Local PostgreSQL tests establish only the behaviours listed in the verification record; they do not establish a deployed Supabase service or a completed application cutover.

## Data mapping and reconciliation

Before any later cutover, inventory orders, lines, evidence, cases, policy versions, events, approvals, intake requests and operations from the source. Produce a migration manifest with source and destination identifiers, record counts and content hashes. Preserve original operation IDs, provider/account scope, retry keys, receipts, timestamps and unresolved statuses. Do not invent authenticated approvals for historical local receipts.

Rows that cannot be mapped safely stay quarantined for review. In particular, an unverified reviewer label, missing original payload, mismatched receipt or unconfirmed payment must not be converted into an executable approved operation. Currency and every monetary total must reconcile in minor units. Keep an audit record of transformation rules and exceptions.

Test export/import round trips on synthetic snapshots. Run the same deterministic policy and approval contract suite against both storage implementations. Add database-backed concurrency tests; a mocked Supabase client cannot establish transaction, row-level security or lease correctness.

## Cutover and rollback

Use one active writer and one payment executor per tenant throughout the transition. Do not run dual payment submission against SQLite and Supabase. Pause new intake and approval writes, stop workers, snapshot the source and reconcile uncertain operations before switching authority.

Retain the frozen source for recovery. Once the target has accepted new writes or submitted a payment, do not simply restart the old database. Stop the target workers, reconcile target-side operations, export its delta and review a reverse mapping or forward repair. Unknown provider results remain blocked from replacement. Prefer temporarily unavailable write paths over two backends both believing they may pay.

Acceptance includes a rehearsed rollback on a synthetic project, with no duplicated operation and no lost approval or event. The operator must be able to see which store and provider mode are active. Backups, retention, regional hosting, encryption, monitoring and incident ownership need explicit decisions before real records are accepted.

## What the handover contains

The earlier ten-sponsor handover remains a checked snapshot from before the runtime implementation. The separate Supabase migration add-on contains the new SQL, asynchronous client, imports, test tools and current guide. Both exclude credentials and working databases; private quarantined snapshots are excluded. Neither is a standalone app or a completed cloud migration. See [runtime preparation](SUPABASE-RUNTIME.md), [online setup preparation](ONLINE-SETUP.md) and the [existing sponsor setup guide](../integrations/SETUP.md).
