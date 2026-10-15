# Operating Refund Office

Run the commands in this guide from the project root. For setup and a short introduction, see the [README](../README.md). The [architecture document](../ARCHITECTURE.md) describes the implementation.

Unless a section says otherwise, this guide describes the original SQLite office on ports 4173/4174. The separate [PostgreSQL rehearsal](LOCAL-POSTGRES-OFFICE.md) has role-aware sessions and stops at unpaid reservations. Its new clarification variant uses separate ports 4473/4474 and a new volume. The [prepared hosted application](HOSTED-SETUP.md) adds verified account sessions and sponsor actions; it remains disconnected. Do not apply one path's payment or sign-in instructions to another.

A local refund investigation demo presented as a dark pixel-art office. The service owns a saved workflow: retrieve evidence, propose a remedy, check policy, wait for human approval, submit the approved payment operation, and record its result. The intake worker handles investigation only and stops before any approval or payment.

The supplied orders and evidence are synthetic. The original SQLite demonstration uses a local rule-based analyser and payment simulator. Separate PostgreSQL rehearsals use local rules and stop at unpaid reservations after approval. Preparation now covers all ten sponsors. OpenAI, Anthropic, ElevenLabs and Stripe adapters, other outbound clients and cloud setup files remain disconnected and unverified. No real money moves in either supported payment mode.

## Run locally

Use a Node.js version with `node:sqlite`. This project has been exercised with Node 26.10.0.

```sh
npm ci
npm run dev
```

The development launcher starts the interface at <http://127.0.0.1:4173/> and the API at `127.0.0.1:4174`. Vite forwards `/api` requests to the local service. Both are needed for an investigation; a static interface alone cannot operate cases.

`npm run dev:ui -- --port 4173 --strictPort` and `npm run dev:api` start the components separately. External requests require `REFUND_OFFICE_NETWORK=enabled`; normal offline launches ignore ambient credentials and do not open optional secret files. The root environment example is a template and is not loaded automatically.

## Investigate a case

- Select a folder in the **Case tray**, or open **All cases** for the searchable **Case inbox**. Three prepared cases are included initially; new submissions remain in the saved case list.
- Choose **Run investigation**. Evidence and policy checks begin unchecked. Each desk transition follows an API operation; animation does not authorise a refund.
- Open **View evidence**, the **Policy** desk or **View history** to inspect the retrieved records, rule results and saved events.
- Use **Pause investigation** and **Resume investigation** to stop or continue the workflow. Switching cases pauses manual unfinished work; eligible intake investigations keep running on the local service. A provider request already in progress finishes before its result can be paused or switched.
- Select **New case**, choose a supplied order and describe the complaint. Missing-item claims can be investigated; conflicting, unsupported or ambiguous requests go to Review.
- Every new refund stops at **Awaiting approval**. Open **Review £X refund**, inspect the exact amount and supporting records, enter a reason and choose **Approve £X refund**. Investigation alone cannot issue a refund.
- Change **Refund policy limit** to constrain eligible refunds. The default limit is £25; the API accepts £0 to £1,000 in whole pence. Passing this limit check never replaces human approval.
- After completion, **Next case** moves to another case needing work; **Case inbox** appears when no next case is available. These actions select a case without starting an investigation.
- Open **View history → Investigate again** to repeat a completed or held investigation. The durable remedy register returns an existing result without creating another refund for that issue. A closed case must first be explicitly reopened.
- If a provider result is pending or uncertain, use **Check result**. This checks the saved operation rather than creating a replacement.
- Download a **Decision packet** to retain the complaint, evidence, proposal, policy checks, event history, operation identifier and receipt as JSON.
- Open **Brief me** for a saved text summary. Download **Decision brief** for the Markdown report or **Prepared Miro map** for the portable source map. These outputs do not approve or submit anything.

The connections panel distinguishes local analysis and payment simulation from prepared sponsor adapters. "Configured" means that an external adapter has explicit settings; it does not verify account access or a successful request. All ten sponsors have preparation code or setup files, and none is connected for the local demonstration.

## Use the local intake queue

Open **Intake queue**, choose a demo order and enter a customer request. **Use sample text** supplies a supported example. **Submit and investigate** saves a stable request reference before sending it, then adds the returned case to the local queue.

The worker gathers synthetic records and evaluates policy while the local API runs. You can inspect another case or close the browser. It stops for human review, a blocked claim or an existing remedy. It has no approval, payment-submission or reconciliation authority. This original SQLite intake queue uses local rules and refuses external model analysis. The prepared hosted PostgreSQL path separately supports an explicitly selected main-investigation model with independent checks; ordinary local launchers remain offline.

The form retains an unconfirmed request in this tab's session storage. **Retry same request** sends its original reference and payload. The API returns the existing saved case for an identical event and rejects reuse with different details. This is separate from the remedy register: intake idempotency prevents duplicate cases for one event, while operation uniqueness prevents duplicate refunds for one order, line and issue.

The queue lists saved request states and provides **Open case**. A paused or failed investigation offers **Resume investigation**; inspect the error and saved case first. Eligible unfinished queue work recovers after API restart. Work already awaiting review stays there. The worker never uses a restart to approve a refund or replay a payment.

The queue is application code, not a running n8n workflow. The [inactive n8n template](../integrations/n8n/refund-intake.workflow.json) prepares a future authenticated intake connection. It is not imported or activated.

## Read the briefing and decision report

**Brief me** reads the saved case revision. It shows the complaint, recommendation, evidence snapshot, saved policy checks, human decision, payment state and next action. Evidence and check text may predate the current receipt; the payment section states the current saved result. No new model assessment runs when the briefing opens.

The **Decision brief** download is Markdown for a reviewer handoff. It labels synthetic records and simulated payments and distinguishes a proposed refund, required approval, approved reservation and confirmed receipt. **Prepared Miro map** is custom JSON with `importReady: false`. It links saved sources, checks, recommendations, review history and outputs; it neither creates a Miro board nor claims native import support. Record links retrieve the current saved revision, not an archived snapshot.

ElevenLabs remains disconnected. This SQLite interface supplies text only. The separate PostgreSQL and prepared hosted interfaces have a guarded saved-case voice action, with no fallback voice. Reading, copying or downloading the local text outputs does not modify the case or contact a sponsor.

## Find work and read totals

The **Case inbox** searches case numbers, order numbers, titles and customer requests. Search works alongside the **All**, **Needs attention**, **Open** and **Resolved** filters. Needs attention includes Review, evidence requests, unresolved payment results and errors. Open includes ready, running and paused investigations. Resolved includes completed investigations and cases closed without a refund; each row retains its specific outcome.

Recorded refund totals count only successful receipts, deduplicate shared operation or receipt identifiers, and exclude the seeded historical remedy for `DEMO-106`. Reinvestigating a case or linking another case to the same receipt does not increase the recorded amount. Pending, failed and merely proposed amounts are excluded. Local simulation and Stripe sandbox amounts are labelled separately; these totals do not represent real money movement.

## Record a Review decision

Choose **Review case** or open the Review desk when an investigation stops. A local reviewer can record the following actions with a reason of 10 to 1,000 characters:

- **Approve £X refund** is available only for a supported, policy-compliant proposal awaiting approval. It approves the exact shown case and amount. The server validates the case revision, evidence/proposal fingerprint, current policy, provider and previous remedies before saving the decision and reserving an operation. The checks run again before first submission.
- **Request evidence** saves what is needed and shows **Awaiting evidence**. It records an internal follow-up only: no customer or courier message is sent, and no new evidence is received.
- **Close without refund** archives the case with the reason and a distinct no-refund outcome. Existing evidence and failed policy checks remain unchanged.

A closed case offers **Reopen review**. Supply a reason to return it to Review, then use **View history → Investigate again** to recheck the current records and policy. Reopening preserves the closure and earlier notes in the history; it does not authorise a refund. Reinvestigating an awaiting-evidence case also retains the recorded request, but it checks the same supplied records rather than pretending new evidence arrived.

Review decisions require the current case revision, so repeated or stale submissions cannot silently overwrite a newer decision. The server also checks for current payment operations, including operations recorded by another case for the same issue. When the affected line and issue cannot be established, it checks the whole order conservatively. An existing reservation, uncertain result or receipt must be inspected or reconciled; it cannot be hidden by a no-refund closure. An old closed case can still be explicitly reopened to discover a refund recorded later by another case.

Approval records the exact amount, scope, local reviewer, reason and timestamp in the case history and exported decision packet. Requesting evidence or closing a case invalidates any pending approval request. A changed proposal, evidence, policy or provider requires a new investigation and approval. "Local reviewer" is a label for the operator of this single-user demo, not a verified account identity. Approval does not override failed evidence, amount, policy-limit, balance or duplicate checks. External message delivery and evidence upload are not implemented.

## Supplied orders

| Order | Evidence | Initial case |
| --- | --- | --- |
| `DEMO-104` | £60 order; the £20 travel mug was not packed | `RF-104`, missing item |
| `DEMO-105` | £60 order; all items packed, delivery scan conflicts with the customer report | `RF-105`, delivery issue |
| `DEMO-106` | Its own £60 order and missing £20 travel mug, with its own seeded historical remedy | `RF-106`, repeat request |
| `DEMO-107` | £36 order; the £12 pencil case was not packed | Available through **New case** |
| `DEMO-108` | £54 order; the £18 desk mat was not packed | Available through **New case**; fresh approval demonstration |

`DEMO-106` does not share the order or seeded refund used by `DEMO-104`. Completing one does not manufacture history for the other.

## Hackathon demonstration

For an order with no previous refund:

1. Open **Intake queue**, choose **DEMO-108**, use its sample missing-desk-mat complaint and choose **Submit and investigate**. The local worker starts automatically. Open the saved case to follow it through the office.
2. The agent proposes **£18**, checks the records and policy, then stops at the Review desk with **Awaiting approval**. No new payment operation exists yet. Reloading preserves this state.
3. Open **Review £18 refund**, inspect the packing record and policy, then enter your approval reason. Only **Approve £18 refund** permits this specific refund to proceed.
4. The approved operation is saved before submission and produces a local £18 receipt. Read the briefing and download the decision report or packet to see the recorded local reviewer label, exact amount and reason. The label is not an authenticated identity.
5. Use **View history → Investigate again**. The existing remedy produces **£0 additional refund**; it neither creates a new operation nor asks for retrospective approval.
6. Investigate `RF-105` to show conflicting delivery evidence. It remains in Review without an approval action; approval cannot make unsupported evidence valid.

To demonstrate the separate policy constraint, set the limit below an unrefunded item's price. It stays blocked even though the operator wants to approve it. Restore an appropriate limit, investigate again and provide a fresh explicit approval. Changing the global limit never approves a refund.

Already exercised cases deliberately remain in the live local database. A refunded order stays resolved even if the limit is subsequently lowered; changing policy does not undo completed operations. There is no destructive reset endpoint.

For a separate practice run, stop the existing launcher and start it with a new, unused database path, for example:

```sh
DB_PATH=.data/practice-01.sqlite npm run dev
```

Keep the original database. Reusing a practice filename resumes its saved state. When Stripe is configured, a fresh local database does **not** erase remote test payments or refunds; use the existing saved ledger for repeated provider demonstrations rather than treating a new database as a reset of Stripe.

## What is saved and enforced

The default SQLite database is `.data/refund-office.sqlite`, with associated SQLite journal files. `DB_PATH` can select a different location. The database stores cases, policy versions, events, intake requests and payment operations. Reloading the browser preserves them. On API restart, eligible unfinished intake work resumes through the worker; other previously running cases recover paused. Unresolved provider operations remain unresolved until checked.

The analyser makes an advisory proposal. The server independently checks that:

- The order line exists and the packing record supports a missing quantity.
- The proposed amount exactly matches that missing quantity and its recorded unit price, using integer minor units.
- Evidence references belong to the retrieved records and include the relevant packing record.
- Delivery evidence does not conflict with the claim.
- The current refund policy limit and remaining unreserved order balance permit the amount.
- An explicit local human approval matches the exact case, amount, complaint, evidence, proposal, order, policy version and payment provider.
- The order, line and issue do not already have a refund operation.

Policy is checked during investigation, approval and immediately before first submission. A changed policy or changed approved facts invalidates approval and returns the case to Review. A retained unsubmitted reservation keeps its original retry key; a fresh investigation and explicit approval are required before it can proceed.

A database uniqueness constraint and atomic approval/reservation prevent competing approvals from creating multiple operations for one issue. The exact operation payload, provider and idempotency key are saved **before** submission. A timeout does not become an assumed success or failure: the operation stays pending and reconciliation uses its original key and payload. Explicit provider failure remains recorded for review.

Stripe responses are independently retrieved and compared with the saved amount, currency, payment and operation identity. Test mode is verified on the associated PaymentIntent. An uncertain Stripe operation without a saved receipt is not automatically resubmitted after the conservative 23-hour retry window; manual provider reconciliation is required. This avoids relying indefinitely on provider idempotency retention.

The service accepts only the specified localhost hosts and origins, requires JSON for mutations and bounds request bodies. It is a local single-user demonstration, not an authenticated multi-tenant or production service. Human Review decisions record exact refund approval, evidence needs, no-refund closure and explicit reopening. They cannot override policy, send messages or collect new evidence. Existing historical receipts retain their original history; no retrospective approvals are invented. Legacy uncertain operations without a known receipt or a valid original approval cannot trigger a new payment submission through reconciliation.

## Record a customer clarification in the separate rehearsal

The new local PostgreSQL variant on 4473/4474 is implemented and checked offline. Follow its [clarification procedure](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal), not the SQLite payment sequence above. The original SQLite evidence request still records an internal note only.

In the clarification variant, a reviewer first requests evidence on an unapproved held case. Once a statement has been received outside the application, the reviewer records its text, source reference, an existing order item and a reason for recording it. The application neither sends a customer message nor fetches the source. The statement is an attributed claim, not independently authenticated evidence.

Saving invalidates the active recommendation and queues a fresh local investigation. The original complaint, price, packing and delivery records remain unchanged. The result returns to Review; a clarification cannot approve a refund or override policy. `RF-2008` provides an ambiguous synthetic example: identifying the missing sketchbook can support a £10 recommendation, which must still wait for the user's decision.

The [clarification verification](verification-evidence-loop-2026-10-14.md) records this extension separately from the earlier SQLite and payment-review checks.

## Start the clarification demo again

Use the [review-workflow guide](REVIEW-WORKFLOW.md) for the role-specific queue and unsent customer questions. **Prepare question** reads the current held case; copy and download check it again. No customer message is sent. Safely confirmed proposal failures can leave unrelated automatic investigations running, while the failed case remains stopped for explicit investigator recovery. Unknown writes or ownership still stop the worker.

The reviewer-only **Reset demo** control is implemented and checked offline for 4473/4474. It starts a fresh copy of the current synthetic pack and retains the previous run and its decisions in the earlier volume. It requires a new local session. It does not erase an existing case or alter the original SQLite, 4273/4274 or hosted paths.

The implemented screen requires **Reset demo → Save run and reset demo**, with an explicit confirmation to keep the current run and copy the same pack. **Keep current run** cancels before submission. When the fresh run is confirmed, select a local profile again.

If the outcome is unknown, the office stays closed and **Reset recovery** offers **Check saved reset** or **Retry same reset request**. A saved failed switch needs inspection; retrying its command cannot create a second replacement. The [local rehearsal guide](LOCAL-POSTGRES-OFFICE.md#start-a-fresh-copy-of-the-current-pack) records these controls and the separate launcher. The [reset verification](verification-demo-reset-2026-10-14.md) records the tested lifecycle and browser sequence.

## Inspect provenance in the PostgreSQL office

The PostgreSQL and prepared hosted interfaces offer **Inspect prepared map** and **Download prepared map** in the Miro card, plus **Prepared Miro map** in the briefing. These controls read the saved revision. Inspect the original sources, investigation, recommendation, policy checks, human decision and output destinations together. The screen distinguishes saved records, waiting stages, locally available outputs and unverified results.

The map distinguishes the current review state from earlier review events and original approvals. An original reservation is not a completed payment. The hosted map does not load separate execution records; use the dedicated payment review panel for that saved result. Links open the current authenticated case, report or export, not a permanent snapshot of an earlier revision. The arrows show record relationships rather than live agent activity.

The download is custom JSON with `importReady: false`. Inspection and download do not create a board, contact Miro, send a report or make a review decision. The shared SQLite briefing offers the same **Prepared Miro map** download; the full inspector is in the runtime sponsor panel. See the [provenance verification](verification-miro-provenance-2026-10-14.md) for the current checks and limits.

## Optional external connections

The current demo needs no accounts or credits. Leave `REFUND_OFFICE_NETWORK` unset or `offline`, `REFUND_OFFICE_ANALYSER=local` and `REFUND_OFFICE_ENABLED_INTEGRATIONS` empty. The root [.env.example](../.env.example) and [integration environment template](../integrations/.env.example) contain blank provider settings. Neither file is automatically loaded by the application.

`scripts/dev.mjs` reads `~/.config/refund-office/model.env` and `~/.config/refund-office/sandbox.env` only after the process explicitly enables external requests. Existing non-empty process variables take precedence. Offline launches do not open those files and strip known provider credential variables from the API child. The UI child does not receive those credential variables in either mode. Never place a secret in browser code or a `VITE_` variable.

OpenAI and Anthropic are alternative analysers for the prepared main hosted investigation and its separate advisory comparison. Select one explicitly if connection is authorised later. The main hosted path requires global network opt-in, explicit analyser selection and that provider in the integration allowlist; keys alone cannot select it. Anthropic requires its model setting; the existing OpenAI adapter has a model default. Only the older SQLite provider selection can use an OpenAI key as its default in external mode; the new hosted investigation requires an explicit selection. Keep `REFUND_OFFICE_ANALYSER=local` for the current demonstration. Missing selected credentials, invalid output or a failed request cannot switch silently to another analyser.

The prepared ElevenLabs client requires an explicitly selected voice. The current interface supplies saved text only. Stripe accepts test credentials and rechecks returned payment and refund identities; a configured failure never becomes a local success. Changing configuration does not transfer old operations between providers.

The other outbound clients require their individual name in the integration allowlist as well as the global network opt-in. Prepared n8n, Supabase, Vercel, Miro, Modal and Port files do not create accounts, deploy resources or connect themselves. The earlier Supabase archive and static Vercel template remain separate from the new operational migrations, hosted sign-in and callable API. See [hosted setup](HOSTED-SETUP.md) for that prepared application; it has not been connected to an account.

Read [the sponsor integration guide](integrations.md) for runtime contracts and [the setup package](../integrations/SETUP.md) for provider-specific files, limits and future configuration. No live request, voice availability, test refund, database migration, workflow import or cloud deployment has been verified here.

The older `scripts/setup-sandbox.mjs` helper is separate provisioning code, not part of the offline runtime. It can import an explicitly supplied Stripe test key or use an explicitly supplied email address to request a temporary sandbox. It can contact Stripe and was not run during this work. No email or key should be inferred, and keeping the application offline is not authorisation to run that helper.

## Replay the saved run for judges

Download the selected case's saved brief to inspect readable evidence, saved check explanations and the exact identifiers cited by its current proposal. The original evidence bodies remain in the report appendix. A current recommendation can require approval even when history contains an earlier evidence request or reopening; the report and briefing keep those states separate.

The separate `npm run demo:judge` launcher uses ports 4673/4674 and its own saved rehearsal directory, with providers disconnected. Choose **Judge mode** in the selected case footer. Playback starts paused and reads the saved event order. Play, step, seek or change presentation speed; at 1×, each event stays on screen for 2.5 seconds. Its recorded timestamp remains visible. The loaded case context is separate from the selected historical event, so later sources or decisions are not presented as earlier knowledge.

After resetting the pack, use the latest successful restart command printed by the launcher. The port-specific file at `work/five-improvements/judge-previews/<UI>-<API>.json` follows the current run; the old single preview file is no longer updated. Failed or unresolved reset states suppress the restart command. The file is a saved status, not a liveness check. Follow the [rehearsal shutdown and recovery procedure](DEMO-REHEARSAL.md#check-the-result-and-stop-cleanly) if a switch or metadata write fails.

Evidence, checks and decision links open read-only panels. Downloads retain the current run guard. A changed case pauses playback until you explicitly load its latest history; changing case, run or profile closes it. Playback cannot start an investigation, retry a decision, approve or pay.

## Evaluate the current application

Run `node scripts/evaluate-runtime.mjs` for a fresh current-service PostgreSQL evaluation. Read `index.html` and `manifest.json` in the new `work/runtime-evaluations/run-*` directory. The runner imports both packs into isolated synthetic tenants, checks saved outcomes against committed expectations and links results to actual traces. It blocks external requests and makes no approval or payment request for the evaluated cases. The temporary database is removed, and existing demonstrations remain separate.

`npm run evaluate:local` still evaluates the original SQLite engine and writes to `work/arize-evaluations`. Keep those earlier results labelled by engine. Controlled provider and language tests do not establish real model accuracy. For hosted traces, an explicitly enabled authenticated machine response can return bounded metadata for the caller to save; no durable hosted collector is configured. See the [full procedure](FIVE-IMPROVEMENTS.md).

## Validate review effort with a retailer

The [business-validation kit](business-validation/README.md) provides interview questions, synthetic manual-review packets, an offline comparison tool and a result template. Record actual timings and corrections before quoting savings. No customer interviews or measured business results have been supplied.

## Office motion

The selected office artwork, bottom status panel and subtle staff activity remain intact. Desk actions and investigator travel follow real workflow stage changes. Selecting a saved completed case does not replay payment or archive effects. **Motion off** and the system's reduced-motion preference disable movement without disabling investigations.

The characters represent stages of one workflow. They are not separate autonomous agents. On smaller screens the tray sits below the office and the view follows the active workstation.

## Checks and packaging

```sh
npm run build
npm test
npm run test:sites
```

Backend tests cover persistence and restart, policy changes, supported and ambiguous claims, duplicate and concurrent requests, stale revisions, pending and failed payments, receipt validation, input bounds and local HTTP controls. Review and approval tests cover explicit decisions, stale revisions and changed facts, direct-call bypass attempts, restart recovery, legacy reservations and uncertain operations, concurrent duplicate approval, durable history/export and related operations from another case. Inbox tests cover searching, status filters and successful-receipt totals without duplicate or seeded amounts. Provider tests cover zero external calls offline, strict model proposals, test-only payment handling, independent refund readback, conservative retries and bounded voice responses. Intake tests cover replay, conflicting event reuse, pause/restart recovery and attempts to cross the review/payment boundary. Saved-output tests distinguish waiting, reservation, uncertainty and a receipt. Prepared integration tests exercise local contracts and disabled setup paths without connecting accounts. Earlier browser and visual checks are recorded separately in [design-qa.md](../design-qa.md).

The earlier SQLite verification recorded a passing build, 136 Node tests and four Sites checks on 14 October 2026. Its setup suite also executed four local Python tests. That [verification record](verification-2026-10-14.md) retains the isolated browser run and downloads. The [Miro provenance](verification-miro-provenance-2026-10-14.md) and [Arize preparation](verification-arize-ax-2026-10-14.md) records track the later checks and their current status.

The protected Sites build leaves `dist/client/index.html`, `dist/server/index.js` and `dist/.openai/hosting.json`. This packaging is a **static frontend handoff**: it does not deploy `server/index.mjs`, SQLite, provider credentials or the `/api` workflow. A separate backend and an appropriate authenticated deployment design are required before a hosted frontend can investigate cases. A passing Sites packaging check does not establish hosted API operation.

## Assets

`work/selected-reference.png` is the selected visual target. The office background, investigator, clerks and case-folder assets were generated for that direction. React implements the interface; Lucide supplies icons and Inter is bundled locally.
