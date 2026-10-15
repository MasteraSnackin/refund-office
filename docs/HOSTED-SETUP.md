# Prepared hosted application

The customer clarification extension is implemented and checked offline in a separate local rehearsal; its [verification record](verification-evidence-loop-2026-10-14.md) records the exercised paths and limits. The hosted reviewer authorisation screen and saved execution lookup are complete, with exercised paths and remaining account checks in the earlier [payment review verification](verification-payment-review-2026-10-14.md).

The hosted application code is written for later use. No sponsor account has been connected, no deployment has been made and no real payment has moved. The ordinary local launchers remain offline. This guide describes a future activation sequence, not a record of completed online setup.

## What is now implemented

The prepared Vercel handler serves the case API through a request-scoped Supabase repository. Sign-in verifies the user and their tenant membership. Session refresh, expiry, rotation and revocation are represented in the application and database. Reviewer and investigator permissions remain separate. A protected machine hook can accept stable intake events and process one investigation per invocation.

Saved-case tools support advisory model comparison, ElevenLabs briefing audio, Miro publishing/readback, Modal text processing and Port catalogue publishing/readback. A shared Supabase action ledger preserves commands and unresolved writes across function restarts. The optional Stripe test path has a reviewer authorisation screen and saved execution view, with submission and reconciliation restricted to a separate executor. The normal case workflow still creates unpaid reservations only.

Read the [architecture](../ARCHITECTURE.md), [sponsor guide](integrations.md), [payment execution contract](../integrations/supabase/runtime/PAYMENT-EXECUTION.md) and [verification record](verification-payment-review-2026-10-14.md) before activation.

The main investigation now accepts an explicitly selected OpenAI or Anthropic analyser with independent application and SQL checks. Local rehearsals remain on local rules. The separate advisory action still has no case-writing authority. Optional hosted tracing returns bounded request metadata for the caller to save; it does not upload to Arize. See the [five-improvement guide](FIVE-IMPROVEMENTS.md).

The prepared hosted UI also has the [role-specific review queue and unsent item-clarification question](REVIEW-WORKFLOW.md). Its authenticated customer-draft route reads the current saved packet and returns a revision/evidence binding. A configured hosted request uses Supabase for authentication and saved records; the draft adds no model or messaging-provider request. The hosted application continues to use bounded machine invocations rather than a background timer; the local automatic-worker continuation described in that guide does not create an unattended hosted worker.

## Keep current rehearsals unchanged

The original PostgreSQL preview on 4273/4274 uses only migrations 001 and 002. The clarification variant uses 4473/4474 and a separate volume with 001/002/007. Do not apply hosted or payment migrations to either running database, or upgrade the earlier rehearsal in place. The original SQLite cases, historical receipts and private snapshots are separate. The new source does not make an old approval executable against Stripe.

Prepare a new synthetic project when connection is authorised. Import a synthetic catalogue with the operational importer, then provision actual account memberships deliberately. Local test identity stubs and fixture user IDs are not a Supabase sign-in or a production membership plan. Do not upload `.data`, private snapshots, session files, test logs containing case details or filled environment files.

## Configuration

The blank [hosted environment template](../integrations/vercel/hosted.env.example) is not loaded automatically. Keep filled values server-side. No secret belongs in a `VITE_` variable, browser storage, source archive or log.

| Setting | Later purpose |
| --- | --- |
| `REFUND_OFFICE_NETWORK=enabled` | Explicit global permission for application provider requests |
| `REFUND_OFFICE_HOSTED=enabled` | Select the prepared hosted boundary |
| `REFUND_OFFICE_WORKING_STORE=supabase` | Select operational cloud storage |
| `REFUND_OFFICE_ENABLED_INTEGRATIONS` | Requires `supabase-runtime`; add only deliberately enabled provider names |
| `REFUND_OFFICE_PUBLIC_ORIGIN` | Exact HTTPS application origin, without a path, credentials or non-default port |
| `REFUND_OFFICE_HOSTED_TENANT_ID` | Intended synthetic workspace UUID |
| `SUPABASE_URL` | Standard HTTPS Supabase project origin |
| `SUPABASE_PUBLISHABLE_KEY` | Modern `sb_publishable_` key; no privileged service key |
| `REFUND_OFFICE_SESSION_SECRET` | Separate 32 random bytes encoded as 43-character base64url |
| `REFUND_OFFICE_MACHINE_KEY` | Separate 32–128 character URL-safe intake secret |
| `REFUND_OFFICE_MACHINE_USER_ID` | Actual investigator account permitted to invoke intake work |
| `REFUND_OFFICE_ANALYSER` | Explicit `local`, `openai` or `anthropic` selection for the prepared main investigation |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Selected OpenAI provider settings; never browser variables |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Selected Anthropic provider settings; the model must be supplied |
| `REFUND_OFFICE_HOSTED_TRACING` | `enabled` permits bounded request-memory traces; default is disabled, with no upload |

The hosted gate is checked before reading request credentials or touching a provider. The normal rehearsal launcher passes an empty provider environment and cannot be activated through these settings. A missing service or unavailable provider remains an error; there is no fallback that pretends a remote write succeeded.

## Database preparation

Use a new synthetic project and a reviewed migration owner when online setup is authorised. The runtime migrations are additive:

| File | Purpose |
| --- | --- |
| [001_runtime.sql](../integrations/supabase/runtime/001_runtime.sql) | Operational tenant, order, evidence, intake, approval and disabled reservation store |
| [002_office_workflow.sql](../integrations/supabase/runtime/002_office_workflow.sql) | Recorded review and explicit investigation recovery |
| [003_hosted_access.sql](../integrations/supabase/runtime/003_hosted_access.sql) | Verified membership lookup and durable session metadata |
| [004_payment_execution.sql](../integrations/supabase/runtime/004_payment_execution.sql) | Optional separate Stripe test authorisation and executor role |
| [005_sponsor_actions.sql](../integrations/supabase/runtime/005_sponsor_actions.sql) | Shared case-bound sponsor-action journal |
| [006_payment_review.sql](../integrations/supabase/runtime/006_payment_review.sql) | Read-only reviewer context: exact original approval binding and any existing execution |
| [007_evidence_clarification.sql](../integrations/supabase/runtime/007_evidence_clarification.sql) | Received customer statements, preserved prior investigation and atomic requeue; requires 001/002 |
| [008_model_investigation.sql](../integrations/supabase/runtime/008_model_investigation.sql) | Main investigation model provenance, checked proposal shape and independent SQL validation |

The private decision-packet archive migration is an older, separate capability. Applying it does not create the operational store. The local test bootstrap that defines an `auth.uid()` stub must never be applied to Supabase.

Database migrations and privileged membership administration are not browser operations. Ordinary authenticated callers use scoped RPCs. Verify actual Supabase roles, grants, row access and API exposure in a new test project before importing any non-synthetic records.

## Vercel and browser access

Use the full application folder as the eventual Vercel project root. Select [hosted.vercel.json](../integrations/vercel/hosted.vercel.json) as the reviewed deployment configuration. It runs the normal build, emits `dist/client`, and directs `/api` traffic to the root [runtime entry point](../api/runtime.mjs). The shared client selects its access screen from the API's session mode; no browser build flag enables a provider. The old [static configuration](../integrations/vercel/vercel.json) intentionally retains its unavailable API.

The runtime bridge has bounded request bodies and does not open a local database. Account credentials are exchanged only by the server after activation. The browser receives an encrypted HttpOnly, Secure, same-site cookie rather than raw Supabase tokens. Database session generation and revocation prevent reuse of an earlier application cookie after a confirmed rotation or logout. Logout may refresh an expired provider token solely to revoke the session. If durable revocation is unconfirmed, a retry-only encrypted cookie keeps the original revocation available while denying workspace access, refresh and sign-in. The interface clears cases and reports the unresolved logout.

Actual function bundling, Node compatibility, request/response limits, custom domain routing and account limits still need a deployment test. Saved-case audio generation and replay are capped at 3 MiB in both application paths. Long provider requests may end unresolved if a function is interrupted; durable records must be inspected before retrying.

## n8n intake

The [hosted workflow](../integrations/n8n/hosted-intake.workflow.json) stays inactive, uses an invalid placeholder host and contains no credentials. It targets the protected hosted contract rather than trying to reach the local loopback API.

| Method and route | Authority |
| --- | --- |
| `POST /api/machine/intake` | Save or replay one stable `eventId`, `orderId` and `complaint` |
| `POST /api/machine/investigate` | Process at most one investigation; empty object body |

A caller supplies a current investigator user JWT as the bearer token and the separate `x-refund-machine-key` header. Supabase verifies the user, and the database checks the selected tenant's investigator membership. The machine identity must match server configuration. This path cannot approve or execute a payment. A scheduler must invoke it deliberately; a function does not keep a reliable timer after its response.

## Selected investigation and request tracing

The main investigator defaults to local rules even if model keys exist. A later authorised hosted model request requires `REFUND_OFFICE_NETWORK=enabled`, explicit `REFUND_OFFICE_ANALYSER=openai` or `anthropic`, that provider in `REFUND_OFFICE_ENABLED_INTEGRATIONS`, selected provider credentials and migration 008. The proposal must identify known evidence and match the saved catalogue amount. SQL independently enforces policy and review. An invalid or unavailable response stops for explicit recovery; no replacement provider is selected. Tests inject controlled responses and label them accordingly. They do not establish real account behaviour.

When `REFUND_OFFICE_HOSTED_TRACING=enabled`, the existing authenticated `POST /api/machine/investigate` response includes `recordedTrace`. It describes actual operations from that request only, bounded to 128 spans or 256 KiB. The caller must save the response to retain it. No new trace endpoint, durable hosted store or collector is configured; empty work has no invented historical spans. Recording failure cannot repeat work or turn a failure into success. Keep uploads disabled.

## Received customer clarification

The extension is checked offline; hosted account acceptance remains unverified. Later hosted use additionally requires migration 007 and `REFUND_OFFICE_EVIDENCE_CLARIFICATION=enabled`; the service advertises `evidenceClarification` only when enabled. Applying the migration alone does not enable the screen. This setting does not permit provider requests or payment execution.

| Method and route | Reviewer action |
| --- | --- |
| `GET /api/cases/:id/evidence-request` | Read eligibility, the original complaint, existing order lines, requested evidence and recorded statements |
| `POST /api/cases/:id/evidence-request` | Save the exact received statement and queue a fresh investigation |

POST accepts only `expectedRevision`, `lineId`, `customerStatement`, `sourceReference`, `note` and `commandId`. The server sets the kind to `customer-clarification`. The line must already belong to the case's order; the original complaint and catalogue remain unchanged. The case must be held awaiting evidence, with no approval, operation, receipt or active worker lease. Each case can retain up to ten clarifications.

Saving appends the statement with its source, reviewer and previous investigation, clears the active proposal/checks/fingerprint and invalidates the previous claim before requeueing. The local rehearsal runs its worker automatically. The prepared hosted path retains bounded investigation: its configured investigator must invoke the next work item. Neither path approves a refund. Packing, delivery and policy checks still apply.

The browser retains the exact command before POST. **Refresh saved evidence** can recover a lost reply from recorded history; **Retry exact statement** uses the same body and identity. A matching stored statement confirms persistence, not authenticity. No source reference is fetched and no customer is contacted. See the [local procedure](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal) and [verification record](verification-evidence-loop-2026-10-14.md).

## Saved-case sponsor actions

All routes require an authenticated case access check. Writes use `expectedRevision` and a stable UUID `commandId`. The browser retains that exact command before sending it. Readback requests use only `expectedRevision`.

`GET /api/cases/:id/board-export` prepares a provenance map from the saved packet without contacting Miro. The interface can inspect or download it for the displayed revision. It distinguishes saved sources and decisions from waiting stages and available outputs; it does not retrieve separate payment executions. Links point to current authenticated application records, not immutable revision snapshots. The custom JSON is not a verified native Miro import format.

| Route suffix after `/api/cases/:id` | Action |
| --- | --- |
| `GET /sponsor-actions/status` | Read configuration and saved action records; no sponsor call |
| `POST /analysis` | Advisory analysis of the saved revision; no case or approval changes |
| `POST /sponsor-actions/voice` | Generate/replay the saved briefing as validated MP3 |
| `POST /sponsor-actions/miro` | Publish prepared cards and connectors, then independently retrieve every object |
| `POST /sponsor-actions/miro/readback` | Recheck known card/connector identities without creating missing objects or reposting |
| `POST /sponsor-actions/modal` | Process the saved `evidenceId`; result remains non-authoritative |
| `POST /sponsor-actions/port` | Publish/read back service readiness metadata only |
| `POST /sponsor-actions/port/readback` | Check the saved catalogue result |

The separate advisory comparison uses `REFUND_OFFICE_ANALYSER` and optional `REFUND_OFFICE_CHALLENGER=anthropic`; its external providers must also be allowlisted. The main hosted investigation uses the explicit analyser contract above and does not use the challenger. Ordinary local background investigation remains on local rules. Sponsor actions require their individual names and settings from the [sponsor template](../integrations/.env.example). ElevenLabs requires an explicitly selected voice; no replacement provider is used.

Miro publication records the complete expected note/connector set before the first provider write. A connector uses verified note identities; readback checks both endpoints and the caption. The parent result is complete only when every planned object is confirmed. Missing planned objects or a lost response without a remote identity remain blocked. Readback cannot create them, and reusing another command ID is not a safe workaround.

`REFUND_OFFICE_PUBLIC_ORIGIN` supplies the public HTTPS origin for clickable application links. They still need a session and return current records, not archived revision URLs; source references are never followed. Exact content comparison is intentionally conservative and needs a real-account check for provider HTML normalisation, connector behaviour and rendering. The [provenance verification](verification-miro-provenance-2026-10-14.md) records the current offline scope. Port metadata is not proof of deployment or financial authority.

The shared sponsor journal is member-attested. Authorised tenant members can call its RPC directly and supply claimed results; the database does not independently prove provider readback. The application facade performs the check and the interface labels the saved outcome **Readback recorded**. Treat those entries as workflow records for trusted workspace operators, and verify the actual provider result during later acceptance. They cannot authorise or execute a refund.

## Optional Stripe test execution

Leave this module disabled until a separate sandbox test is authorised. It additionally requires `REFUND_OFFICE_PAYMENT_EXECUTION=stripe-test` and the `stripe-runtime` allowlist entry. Use only a test secret key. The browser review route requires a new explicit authorisation bound to the original reservation and a pre-existing, exact test-account/PaymentIntent mapping.

| Method and route | Required authority |
| --- | --- |
| `GET /api/cases/:id/payment-authorisation` | Verified reviewer; read eligibility, exact approval binding and any saved execution |
| `POST /api/payment-executions` | Verified reviewer; exact new execution authorisation |
| `GET /api/payment-executions/:id` | Verified reviewer; inspect saved execution |
| `POST /api/machine/payments/:id/execute` | Dedicated executor; empty object body |
| `POST /api/machine/payments/:id/reconcile` | Dedicated executor; retrieve known refund only |

The executor uses `REFUND_OFFICE_PAYMENT_MACHINE_KEY`, `REFUND_OFFICE_PAYMENT_MACHINE_USER_ID`, a current user JWT and `x-refund-payment-key`. Its key and user must differ from the intake configuration. Supabase verifies the identity; execution RPCs require actual `payment-executor` membership. A browser reviewer and an intake investigator cannot perform execution or reconciliation.

The test PaymentIntent must already identify the exact order and tenant in metadata. The module does not create a payment, add metadata to an unrelated payment or support connected-account routing. Its key's account must match the authorised account. A lost submission with no saved refund identity remains unresolved and cannot be posted again.

The prepared reviewer screen reads its eligibility and immutable approval binding from the case lookup route. It requires the test account ID, existing PaymentIntent ID, a new reason and explicit confirmation. The original amount, order, currency, approval identity and fingerprint come from the saved records. Changing the test mapping does not rewrite the original reservation.

Before sending the authorisation, the browser saves the exact command and payload under the current workspace, reviewer and case. An unknown response keeps that command and blocks a changed decision. Lookup can recover an existing execution after a reload; an original retry must retain its exact identity and contents. A saved authorisation means permission for the separate executor, not a submitted refund.

The result view reads the separate execution record. It distinguishes an unsubmitted authorisation, executor preparation, saved submission intent, unresolved outcome, saved refund reference, pending readback, pending refund, failure and success. Successful status depends on the trusted executor's recorded matching provider retrieval; SQL and this screen do not independently contact Stripe or prove provider authenticity. The reviewer screen has no execute or reconcile control.

The ordinary PostgreSQL launcher remains offline, applies only migrations 001/002 and does not enable this form or its lookup route. Later hosted activation requires the optional payment settings, migration 006 and actual reviewer membership. Offline fixtures exercise the screen and contract without authorising a user-facing case or contacting a provider.

## Acceptance after connection is authorised

For the first private deployment, enable only `supabase-runtime`, retain the local analyser and leave payment execution, other sponsor actions and Arize uploads disabled. Use a fresh synthetic workspace and preserve the local rehearsals. Deploy from a source snapshot that includes the current canvas, record-based chat and prepared voice route; the older pre-assistant snapshot does not contain those later files. Preparing the voice route does not enable transcription.

The owner signs in with reviewer membership. Investigation needs a separate investigator identity: a tenant membership has one role, so reviewer access does not permit processing the queue. Either an authenticated investigator uses **Process next request**, or a separately configured protected machine caller invokes the bounded investigation hook. Configure and test this path before calling the hosted intake workflow complete. The hosted intake screen describes requests as queued when automatic background investigation is unavailable. **Reset demo** remains a local rehearsal feature.

Verify one synthetic request from intake to a saved recommendation through that investigation path, then stop before a new human decision. Check the saved report and canvas after reloading, and confirm a user without membership cannot read the workspace. A deployment URL or successful build alone does not establish this workflow.

First verify sign-in, membership isolation, refresh, logout and expiry with two synthetic users. Then inspect one intake event and saved recommendation, with no payment permission. Exercise one sponsor at a time, recording the exact provider result and independent readback where applicable. Run Stripe separately with a new exact human decision and matching test fixture.

Local tests establish the exercised source paths and SQL behaviour. They do not establish credentials, credits, selected model/voice availability, hosted routing, provider behaviour or production suitability. The [payment review record](verification-payment-review-2026-10-14.md) and preceding [sponsor wiring record](verification-sponsor-wiring-2026-10-14.md) preserve that distinction.
