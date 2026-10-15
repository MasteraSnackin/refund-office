# Operational PostgreSQL contract, migration stage one

This schema is separate from the decision-packet archive and the existing SQLite interface. It supports synthetic GBP catalogues, durable intake claims, deterministic investigation checks and authenticated approval/reservation. **Payment submission and settlement are disabled.** There is no submission or settlement RPC, provider key, deployment step or automatic connection in this migration.

The migration must run as the intended PostgreSQL/Supabase administrative owner. The private schema is `refund_runtime`; browser roles have no direct write grants. Public RPCs are security-definer functions with an empty search path. Actor identity is always `auth.uid()`, never a request-body actor. Membership is tenant-scoped with role `investigator` or `reviewer`. Anonymous database roles and authenticated sessions whose JWT says `is_anonymous:true` are denied. Membership user IDs must refer to `auth.users`; membership provisioning remains an administrative operation. An offline test stub for `auth.uid()` does not establish real JWT authentication or Supabase gateway behaviour.

## Import

Administrative RPC, granted only to `service_role` (and available to the migration owner):

```sql
public.refund_runtime_import_dataset(
  p_tenant_id uuid,
  p_dataset jsonb,
  p_digest text,
  p_members jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
```

`p_dataset` is the validated version-one `focused-12` or `busy-50` dataset. `p_digest` is the canonical SHA-256 returned by `demoDatasetDigest`; the database checks it against canonical JSON. Members have shape `[{"userId":"uuid","role":"reviewer"}]` or `investigator`. Production member provisioning is a separate administrative operation. Importing with an empty list makes the tenant inaccessible to ordinary callers until membership is deliberately provisioned.

The transaction creates fresh ready cases and queued intake events. Historical seed operations remain explicitly `seeded`, successful local fixtures with `DEMO-` receipts and no submission permission. Imported cases have no approval or payment receipt. Importing the exact same catalogue and digest returns `replayed: true` without adding members, rewriting state or duplicating cases. A changed catalogue at the same tenant is rejected. A live SQLite snapshot is not accepted; archive it separately as quarantined evidence.

Result: `{tenantId, datasetId, digest, caseCount, orderCount, replayed}`.

## Read and intake RPCs

All functions below are granted to `authenticated`; the caller must also have the required tenant membership.

| Function | Parameters | Role | Result |
| --- | --- | --- | --- |
| `refund_runtime_read_workspace` | `p_tenant_id uuid` | Either | `{tenantId, mode:'synthetic-only', paymentsEnabled:false, orders, policy, cases, intakeRequests}` |
| `refund_runtime_read_case` | `p_tenant_id uuid, p_case_id text` | Either | Saved case object |
| `refund_runtime_enqueue_intake` | `p_tenant_id uuid, p_event_id text, p_order_id text, p_complaint text` | Either | `{request, case, replayed}` |
| `refund_runtime_claim_intake` | `p_tenant_id uuid, p_lease_seconds integer DEFAULT 30` | Investigator | `null`, or `{requestId, caseId, fence, leaseUntil, case, order, evidence, policy}` |
| `refund_runtime_finish_intake` | `p_tenant_id uuid, p_request_id text, p_fence bigint, p_proposal jsonb` | Investigator | `{request, case}` |

Event IDs follow the existing local contract. Identical retries return the same case; changed payloads under the same event ID fail. Dataset events use `demo-${dataset.id}-${case.id}`.

The SQL lease bound is 1–300 seconds; the JavaScript client deliberately narrows it to 5–120 seconds. Claims have a durable actor-bound lease and monotonically increasing fence. A claim can be reclaimed only after expiry, with at most eight attempts. A stale actor, fence, lease, case revision or facts snapshot cannot finish work. The claim result carries the saved evidence and order required by the local analyser. Database checks, rather than its proposed amount, decide whether a request is eligible. Proposal shape is `{amountMinor, lineId, issue, reason, evidenceIds, source:'local'}`. Unknown and delivery-dispute proposals stop for review. A valid missing-item proposal requires exact arithmetic and the packing evidence reference. No proposal authorises payment.

Finishing the same claim with the same proposal is idempotent; a changed repeat is rejected. Outcomes are `awaiting-approval`, `held` or `already-resolved`. The first two leave the case at Review. A seeded historical remedy remains a historical receipt, never a new refund.

## Human approval and reservation

```sql
public.refund_runtime_approve_and_reserve(
  p_tenant_id uuid,
  p_case_id text,
  p_expected_revision bigint,
  p_expected_fingerprint text,
  p_expected_amount_minor bigint,
  p_note text,
  p_command_id uuid
) RETURNS jsonb
```

Only a reviewer can call this function. The recorded note must contain at least ten characters after trimming outer whitespace and at most 2,000 characters. The function locks the tenant's mutation boundary, rechecks the current case revision, saved evidence/proposal, catalogue, policy, existing remedies and remaining order balance, and atomically records approval plus one immutable reserved operation. The uniqueness boundary is tenant, order, line and issue. The stable command ID binds the full request and reviewer; an exact retry returns the original result, while changed reuse is rejected.

Result: `{case, operation, replayed}`. The case is `status:'paused'`, `stage:'payments'`, `outcome:'approved-not-submitted'`. The operation is `status:'reserved'`, `submissionEnabled:false`. Its original payload, retry key and approval snapshot are persisted together. There is no way to progress this reservation to a submitted or successful payment in this migration stage.

A saved case exposes `revision`, `fingerprint`, `fingerprintScheme` and `proposedAmountMinor`. A recorded approval includes `state:"approved"`. New fingerprints use the explicit database-owned scheme `postgres-jsonb-v1`. They are SHA-256 of PostgreSQL's JSONB text representation of the locked approval facts. They must never be compared with or substituted for the original SQLite/Node fingerprint scheme. Legacy approvals are not executable imports.

## Concurrency and permissions

Mutations take a tenant-row lock. This deliberately serialises short database transitions within one bounded demonstration workspace, including approvals across different cases. No lock is held during model or provider work. Claims survive process restarts; there is no blanket startup rewrite of other workers' active jobs. Composite foreign keys prevent cross-tenant references. Row-level policies permit members to read only their own tenant data. Direct insert, update and delete privileges are withheld from browser roles and `service_role`.

The claim/finish path cannot create approvals or new operations. The reviewer path cannot claim or finish investigations. Only administrative dataset import can create explicitly seeded history. Provider execution remains absent.

SQLSTATE `42501` denotes denied access; `22023` invalid input; `23505` conflicting replay or existing remedy; `40001` stale revision/fingerprint/lease/fence or changed investigation context; `55000` an unavailable transition. The adapter should show these as explicit states and must not automatically replay a write with a new identity.

## Verification boundary

The offline PostgreSQL harness must exercise both packs, tenant isolation, role separation, direct-write denial, payload replay/conflicts, lease fencing, stale approval facts, concurrent reservations and atomic rollback. These database tests do not verify Supabase JWT issuance, gateway grants, accounts, deployed endpoints or live providers. The existing SQLite application remains the active interface until an asynchronous runtime facade and its authenticated boundary are separately integrated and checked.
