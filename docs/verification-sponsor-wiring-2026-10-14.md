# Sponsor application verification — 14 October 2026

Status: passed locally. Sponsor accounts remain disconnected.

This work connects the remaining sponsor preparation to the case workflow and a separate hosted API. Testing used local databases, synthetic identities and injected provider responses. No sponsor account was connected, no deployment was made, no speech was generated and no real money moved. The normal rehearsal remains offline.

## Results

| Check | Result | What it establishes |
| --- | --- | --- |
| Application suite | 330/330 passed | Workflow, sessions, roles, sponsor contracts, exports, uncertain writes, data preparation and packaging controls |
| Combined PostgreSQL run | 41/41 passed | All five migrations coexist; core store, application workflow, optional payment executor and hosted journal/session controls work in the exercised local database |
| Database execution | 607 SQL round trips; 142 expected rejections | Forbidden actions were rejected in the tested cases; 28 source/input files stayed unchanged during the run |
| Frontend builds | Passed | The shared client builds; a separate output copy also compiled. This is not a Vercel deployment test. |
| Explicit Sites check | 4/4 passed | Required static handoff files exist and missing API routes do not become the app shell. These four tests also belong to the application suite. |
| Architecture map | 9/9 validation checks; no errors or warnings | Diagram validation and four desktop layout checks passed; guided payment view, node search and theme controls were inspected in the local browser |
| Documentation links | All 16 current guide files checked | Relative links resolve in the complete workspace. Historical files and raw work evidence may be intentionally omitted from the source pack. |

The database run used a newly created, cached PostgreSQL 16 container with networking disabled, no published ports and no existing data mounts. It covered the 62 synthetic catalogue cases, tenant isolation, competing worker claims, stale decisions, immutable approvals, review/recovery, a separately authorised test execution, durable sessions and terminal sponsor records. Its owned container was removed successfully. Payment-provider responses were injected fixtures, including the submission/readback path; no Stripe request was sent.

The exercised migrations are [001](../integrations/supabase/runtime/001_runtime.sql), [002](../integrations/supabase/runtime/002_office_workflow.sql), [003](../integrations/supabase/runtime/003_hosted_access.sql), [004](../integrations/supabase/runtime/004_payment_execution.sql) and [005](../integrations/supabase/runtime/005_sponsor_actions.sql). The existing preview still uses only 001 and 002.

## Application checks

- Offline gates reject requests before reading provider credentials. Ambient keys cannot enable the normal launchers.
- Hosted sign-in verifies the returned identity and workspace membership. Session generation, expiry, rotation and revocation remain separate from the local test-profile chooser.
- Expired-token logout refreshes solely to revoke. A lost revocation acknowledgement retains a retry-only cookie; the interface immediately clears the office, blocks sign-in/refresh and preserves pending logout across reloads. Stale replies cannot reopen it.
- Advisory model analysis uses the saved case revision and evidence. It checks citations and amounts, rejects a changed snapshot, and cannot change a recommendation, approval or payment. Failed models remain unavailable.
- Saved-case voice generation and replay share a 3 MiB limit. No alternate voice provider is selected. Audio quality and a real voice remain untested.
- Miro and Port writes retain their original command and acknowledged identity. Miro completion requires all planned cards. Unknown writes cannot be hidden by a fresh command; terminal records accept only exact replay.
- Optional Stripe execution uses a separate machine identity and database role. It requires a new reviewer authorisation for the exact original approval, amount and test-payment mapping. Submission intent is saved before POST, and readback is independent. A lost response without a refund identity blocks reposting. Malformed write acknowledgements remain uncertain.
- Intake workers cannot approve, submit or reconcile refunds. The hosted worker runs one bounded invocation; it does not depend on a background timer surviving a serverless response.

The hosted sponsor journal is **member-attested**. An authorised tenant member can call its RPC directly and supply a claimed provider result. The facade performs readback, while SQL enforces scope and record preservation; the database does not prove the provider action occurred. The interface says **Readback recorded**. This journal has no payment authority. The payment executor has its own trusted execution boundary.

## Browser rehearsal and preservation

The resumed local PostgreSQL office was inspected at port 4273. An investigator could inspect a recommendation and run the local advisory action but had no approval control. All external action buttons were disabled. The downloaded JSON recorded a £20 local-rules proposal, exact revision, evidence checks and `advisoryOnly: true`; it did not claim a model call or a second opinion.

Ending the session cleared the office. Re-entry as a reviewer restored the saved case awaiting a decision. No new approval was made during browser checks. The prior session cookie was rejected after restart.

All twelve saved case objects match the before-check snapshot, including their revisions, evidence, events, approvals and receipts: six await approval, five are held and one refers to a historical remedy. No new reservation or payment was created. All fifteen original data files and all three earlier handover archives retain their recorded hashes, including the original approved £20 simulated refund.

The local service stopped during the voice-session interruption. Its stopped container and stale process marker were identified by exact ownership. Only that stopped container was removed; its volume was retained. The normal launcher checked the saved catalogue, schema and full database checkpoint before resuming it. The original SQLite demo was not restarted or changed during this recovery.

[Case-tools screenshot](diagrams/sponsor-case-tools.png) · [Checked map screenshot](diagrams/sponsor-runtime-browser.png) · [Interactive architecture](diagrams/sponsor-runtime.html) · [Map review record](diagrams/sponsor-runtime.review.json)

## Reproduce locally

Use the installed dependencies and a local cached PostgreSQL image. These commands do not activate a sponsor:

```sh
npm run build
npm test
npm run test:sites
node scripts/test-sponsor-application.mjs
```

The combined runner creates a fresh owned container and removes it after verification. It refuses remote Docker endpoints and does not mount a preview database. Its raw evidence stays under `work/sponsor-wiring/database`; the source pack includes a sanitised summary and exact checked source hashes instead. Application logs, browser observations and preservation checks are retained under `work/sponsor-wiring` and are excluded from the shared archive. A fresh dependency installation was not repeated.

## Remaining acceptance

Real Supabase login, JWT verification, API permissions and gateway behaviour still need an authorised synthetic project. Vercel bundling, routing and function limits need deployment acceptance. n8n import and invocation, model/voice availability and credits, Miro rendering and HTML normalisation, Modal deployment, Port permissions and actual Stripe test receipts remain unverified.

The prepared payment executor has API routes and local tests. The current office preview has no Stripe execution-authorisation form or submission control. A future operator interface must obtain the separate exact reviewer decision; it must not reuse an old disabled reservation as permission.

See [hosted setup](HOSTED-SETUP.md), [the ten-sponsor guide](integrations.md) and [the architecture](../ARCHITECTURE.md). These results establish the tested offline implementation, not live account acceptance or production readiness.
