# Local PostgreSQL office

This rehearsal connects the office interface, intake worker and review actions to a separate working PostgreSQL database on this device. It uses synthetic records and local test profiles. No Supabase account, model provider or payment service is connected.

The original rehearsal below runs on 4273/4274 with migrations 001/002. A separate [customer clarification rehearsal](#customer-clarification-rehearsal) is checked offline on 4473/4474 with additive migration 007 and a new volume. It preserves the existing rehearsal and its decisions.

The original SQLite demonstration remains separate. Its simulated receipts are not imported as permission to make another payment. In the PostgreSQL rehearsal, approval saves a reservation and stops at **Approved — not submitted**. There is no payment submission or settlement route.

## Start or resume a rehearsal

Use the complete project with its installed dependencies, Node.js 26.10.0, a running local Docker daemon and the already-cached `postgres:16-alpine` image. The launcher will not download an image or use a remote Docker endpoint.

```sh
npm run demo:runtime
# Or start the separate 50-case dataset:
npm run demo:runtime:busy
```

The interface opens on <http://127.0.0.1:4273/> and its API listens on `127.0.0.1:4274`. The original demo uses 4173/4174. The launcher refuses to start if either new port is occupied; it never replaces a running preview.

Each fresh launch creates its own labelled Docker volume and saves a private marker under `.data/runtime-rehearsals/`. The terminal prints the exact command for resuming that rehearsal. Stop with Ctrl+C before resuming. Shutdown removes only the owned container and retains its data volume. An explicit `--reuse` checks the dataset, migration files, local profiles, image identity, volume ownership and saved database checkpoint before the application can use it.

The launcher refuses an interrupted owner marker or a changed checkpoint. It does not reset, repair or upgrade that database automatically. Retain the volume and inspect the interrupted run before deciding how to recover it. A new rehearsal is always a separate dataset.

## Local profiles and permissions

Choose **Local reviewer** to inspect evidence and record an approval, evidence hold, closure or reopening. Choose **Local investigator** to inspect investigations, process the next queued request or explicitly recover stopped work. Either profile can submit a synthetic request. The background worker has its own investigator identity and cannot approve.

These selectable profiles test application roles; they are not secure accounts or Supabase sign-in. Anyone with access to this local preview can choose either profile. Separate hosted sign-in, session and tenant-access code is now prepared, but no account has been connected. Membership provisioning and real account acceptance remain later work.

Sessions expire after 30 minutes. **End session** revokes the local session and clears the visible office. A new profile starts a new view. The server assigns the role and workspace; the browser cannot supply a different actor in an approval body. The database independently checks membership and the permitted role for each transaction.

## Rehearsal sequence

1. Enter as a reviewer. The background investigator checks the synthetic queue and stops at a recommendation, policy hold or labelled historical remedy.
2. Select a case and inspect **View evidence**, the Policy desk and its history. The investigation uses local rules, not an external AI model.
3. If you decide to approve, enter a reason and use the button showing the exact reservation amount. This records your local reviewer identity, the current facts and one disabled reservation together. It does not pay a refund.
4. In this original 001/002 rehearsal, record what is needed when evidence is insufficient. This creates an internal hold only: no customer message is sent and no new evidence is received. A reviewer must explicitly reopen the existing records before an investigator can recheck them.
5. Download the decision brief or packet. It contains the saved evidence, policy checks, human decision and payment boundary.

Do not describe a reserved amount as money refunded. Seeded historical receipts are labelled synthetic history and are separate from newly recorded approvals.

## Recovery and repeat actions

Intake uses a stable event identity. The same event and contents reuse the saved case; changed contents with that identity are rejected. The investigation worker claims one request with an expiring lease and an increasing claim version. A stale worker cannot overwrite a newer result.

When an investigation fails, the queue stops and the case retains the error for inspection. An investigator can recover eligible held or failed work with a reason and the current revision. The previous investigation and review remain in history. Recovery clears the active recommendation and returns the case to the queue; it cannot approve a refund. In the original rehearsal, a reviewer evidence hold must be reopened first.

Approval and review commands retain their exact payload and retry identity in browser session storage before being sent. An unconfirmed write keeps that identity. Refresh and inspect the saved case before retrying; do not create a replacement decision merely because the response was lost. The local database transport separately reads the saved case after a successful write.

## Customer clarification rehearsal

This extension is implemented and checked offline; the [current verification record](verification-evidence-loop-2026-10-14.md) records the application, database and browser evidence. It uses a separate interface on <http://127.0.0.1:4473/> and API on `127.0.0.1:4474`, with migrations 001/002/007 in a new owned volume. It remains offline, uses local rules and offers no payment submission. Do not apply 007 to the existing rehearsal database or reuse its marker for this variant.

The [lower-level launcher](../scripts/run-evidence-rehearsal.mjs) accepts either synthetic pack without reset controls. Use the [supervised launcher](#start-a-fresh-copy-of-the-current-pack) below when **Reset demo** is needed:

```sh
node scripts/run-evidence-rehearsal.mjs focused-12
# Or start the separate 50-case dataset:
node scripts/run-evidence-rehearsal.mjs busy-50
```

It refuses occupied ports, uses a separate session cookie, and saves private markers under `.data/evidence-runtime-rehearsals/`. It prints the exact `--reuse` command with the saved rehearsal ID at startup and retains the owned volume on shutdown. Reuse verifies the dataset, schema, profile and volume identities plus a checkpoint which includes the recorded statements. It does not upgrade or reset the original rehearsal.

Use the **Customer clarification** panel on an unapproved case at Review:

1. As **Local reviewer**, choose **Open review to request evidence** and record what is missing. A held case must be awaiting evidence before a new statement can be recorded.
2. Select the existing item identified by the customer. Enter the **Received customer statement** (10–4,000 characters), **Source reference** (10–200 characters) and **Reason for recording this clarification** (10–2,000 characters).
3. Confirm that the statement was received, identifies the selected item and leaves the original records unchanged. Choose **Save statement and reinvestigate**.
4. Inspect **Recorded statements**, the original request and the fresh investigation. Stop at the new review decision. Recording evidence does not approve a refund.

The source reference is retained as text; it is not fetched. The application does not contact the customer. Investigators cannot record a clarification, and unsupported rehearsals show **Unavailable in this rehearsal** without requesting this context.

The browser saves the exact command before sending it. If the reply is lost, use **Refresh saved evidence** or **Retry exact statement**. A changed submission stays blocked until the original statement, source, item, reason and reviewer are found in independently read saved history. The pending command is cleared only after that match, so a later distinct clarification remains possible. Do not enter the same statement again as a new request.

Saving records the clarification and prior investigation together, clears the active proposal, checks and fingerprint, and queues a fresh investigation. The original complaint and catalogue facts remain intact. A new recommendation still needs a fresh human decision. Selecting an item cannot override packing evidence, delivery disputes, policy, previous operations or the saved price.

The investigator considers the original complaint and every recorded statement. Selecting an item alone is insufficient; the statement must identify a supported missing-item claim. Conflicting statements remain a reason to hold the case.

The decision packet retains the structured clarification and recorded history. The downloaded Markdown report includes each statement's source reference, reviewer and recorded time alongside the original complaint and saved checks.

For the synthetic example `RF-2008`, the original complaint does not identify the missing item. A fictional statement that the sketchbook was missing can resolve that ambiguity and produce a £10 recommendation. It must stop awaiting approval. This example is a local test of recorded clarification, not a received real customer message or a payment result.

## Start a fresh copy of the current pack

**Reset demo** is implemented and checked offline for the clarification rehearsal on 4473/4474. A local reviewer can confirm a new run of the same synthetic pack. The existing run and its decisions remain saved in their previous volume; reset does not delete that history or carry its decisions into the fresh copy. Old sessions are invalidated, so the new run requires a local profile to be selected again.

A fresh copy includes any labelled historical fixtures supplied with that pack. Approvals and customer clarifications recorded during the previous run stay in the saved previous volume.

Use the [reset-enabled launcher](../scripts/run-evidence-demo.mjs) for the supervised rehearsal:

```sh
node scripts/run-evidence-demo.mjs focused-12
# Or use the current 50-case pack:
node scripts/run-evidence-demo.mjs busy-50
```

It uses the same dedicated 4473/4474 ports and refuses to replace a running preview. An explicit `--reuse` followed by a saved run ID resumes that retained run after its identity and checkpoint checks. The lower-level `run-evidence-rehearsal.mjs` command above remains available for deliberate manual restoration without reset controls.

The controller saves the original reset command and the fixed target run before switching. It blocks new workspace actions, invalidates sessions and waits for accepted work to stop before saving the previous run's checkpoint. The fresh run must match the original pack and dataset digest. If the switch fails or its reply is lost, the saved status and an exact retry remain available; they cannot create another target. The source volume and any partially created replacement are retained. An interrupted switching record requires inspection before either recorded run can be restarted through the supervisor.

The [verification record](verification-demo-reset-2026-10-14.md) documents the lifecycle and browser checks. In the reset-enabled rehearsal:

1. Enter as **Local reviewer** and choose **Reset demo** in the workspace controls. Investigators do not receive this control.
2. In **Reset this demo**, check the pack being copied and the explanation that cases, evidence, decisions and history will stay in the saved run. **Keep current run** closes the dialog without a reset.
3. Confirm that the same pack should start again and the current profiles should end, then choose **Save run and reset demo**.
4. The office closes while the switch runs. After a matching ready result confirms the previous checkpoint and new run, the profile chooser returns. Select a local profile to enter the fresh copy.

The browser saves the reset command before sending it. **Reset recovery** offers **Check saved reset** and **Retry same reset request** if the outcome is unknown. Reloading checks the saved status; status checks continue automatically while it is switching. The browser never posts another reset automatically. An exact retry can recover an acknowledgement, but a saved failed or unresolved switch still needs inspection rather than a second replacement run. A damaged browser recovery record also blocks a new reset.

Requests and case downloads retain the identity of the run that was displayed when they began. A stale tab or delayed response cannot silently act on the replacement run. The new volume has a different workspace identity, so earlier pending case commands are not carried into it.

This reset does not apply to the original 4273/4274 rehearsal, SQLite or the prepared hosted application. All sponsor services remain disconnected, and no refund is approved by resetting.

## Implementation

| Responsibility | Source |
| --- | --- |
| Local session and fixed test identities | [runtime-auth.mjs](../server/runtime-auth.mjs) |
| Loopback API, session checks and bounded requests | [runtime-api.mjs](../server/runtime-api.mjs) |
| Asynchronous investigation, review and saved outputs | [runtime-service.mjs](../server/runtime-service.mjs) |
| Local SQL transport with no cloud client or HTTP requests | [local-postgres-runtime.mjs](../server/local-postgres-runtime.mjs) |
| Base tenant, evidence, lease and approval transactions | [001_runtime.sql](../integrations/supabase/runtime/001_runtime.sql) |
| Recorded review and explicit investigation recovery | [002_office_workflow.sql](../integrations/supabase/runtime/002_office_workflow.sql) |
| Received statements and atomic fresh investigation | [007_evidence_clarification.sql](../integrations/supabase/runtime/007_evidence_clarification.sql) |
| Separate owned database and preview launcher | [run-runtime-rehearsal.mjs](../scripts/run-runtime-rehearsal.mjs) |
| Isolated clarification rehearsal launcher | [run-evidence-rehearsal.mjs](../scripts/run-evidence-rehearsal.mjs) |
| Access screen and role-aware controls | [RuntimeAccess.jsx](../src/RuntimeAccess.jsx) |

The PostgreSQL container has no network and publishes no ports. The Node process uses the local Docker socket to run allowlisted transactions. The launcher removes provider credentials from child-process environments, disables Vite environment-file loading and forces offline settings. The worker constructs its local analyser with an empty environment. This local test transport is deliberately separate from the prepared hosted Supabase client.

## Check the implementation

```sh
npm test
npm run test:runtime:local
npm run build
npm run test:sites
```

The original database test creates a disposable, network-disabled PostgreSQL instance, applies migrations 001/002 and exercises that workflow. It does not change any rehearsal database. Its evidence is written to `work/runtime-application/`; the earlier first-migration verification remains in `work/supabase-runtime/`. Clarification checks are recorded separately in the [current verification](verification-evidence-loop-2026-10-14.md).

`node scripts/test-evidence-loop.mjs` exercises migrations 001–007 together in a new disposable, network-disabled PostgreSQL instance. It records the exercised source hashes and results under `work/evidence-loop/database/`. The persistent clarification preview applies only 001/002/007; the full test database also checks coexistence with the prepared hosted and payment extensions.

`node scripts/test-demo-reset.mjs` exercises the supervisor against its own isolated test database runs. It checks checkpoint preservation, exact command replay, the fresh same-pack copy, stale sessions and requests, and explicit restoration of the saved source. Results and source hashes are written under `work/demo-reset/lifecycle/`. The test removes only its validated, stopped test volumes; **Reset demo** retains user-facing run volumes. The [reset verification](verification-demo-reset-2026-10-14.md) records the current test and browser scope.

The [14 October verification record](verification-local-office-2026-10-14.md) documents the automated checks, browser rehearsal, restart and preservation checks, and their limits.

## What remains before an online version

The application boundary is now coded for Supabase authentication, tenant membership and the hosted repository. Activate it only in a separately authorised synthetic project, using the [hosted setup guide](HOSTED-SETUP.md). Test the real gateway, session refresh, expiry, logout and access policies. The local profiles and test authentication functions cannot establish those behaviours.

A separate [Stripe test executor](../integrations/supabase/runtime/PAYMENT-EXECUTION.md) is now prepared, with saved submission intent, fenced execution and independent readback. It requires a new exact reviewer authorisation and a dedicated executor role; an existing reservation is not permission to submit it. The ordinary local PostgreSQL preview still has no payment route. Account acceptance and a separately authorised synthetic deployment remain required.

The shared **Stripe test payment review** panel shows **Unavailable in this rehearsal** and makes no authorisation request. The prepared hosted form and saved execution view require separate payment configuration and migrations, including read-only context migration 006. The original launcher applies only 001/002; the clarification variant adds 007 without payment execution. Reviewer authorisation never supplies executor permission.

The [migration plan](SUPABASE-MIGRATION.md) covers controlled cutover and rollback. The existing sponsor and first-migration archives remain historical preparation snapshots. The separate `refund-office-local-application-prep.zip` contains this stage's source and verification files as an add-on to the complete project; it excludes working databases, session data and credentials.

## Local workflow traces

The clarification launcher records metadata for operations that actually run: intake, investigation, review, clarification and recovery. Each start writes a new bounded segment under its saved rehearsal's `traces/` directory and retains earlier segments. It does not replay old decisions into a trace, contact Arize or change the original 4273/4274 rehearsal.

Runtime traces omit complaint and evidence text, source references, reviewer notes, internal case/order/actor UUIDs, credentials and error messages. They retain operation names, timing, status, revisions, amounts, check counts and allowlisted synthetic pack/case labels. Default retention is 512 spans or 1 MiB per segment; dropped-span and recorder-error counters identify incomplete capture. Tracing failure does not replace the workflow result or repeat a case action.

The separate `npm run evaluate:local` command evaluates fresh in-memory SQLite cases, rather than this PostgreSQL workspace. See the [Arize guide](../integrations/arize/README.md) for both scopes, the disabled exporter and later account acceptance.

## Saved-case tools

The runtime office now includes a separate saved-case tools panel. Its default sponsor status is disconnected, and its provider buttons cannot make external requests. **Run advisory analysis** runs the labelled local analyser on the exact saved revision and offers a downloadable result; it does not alter the case or approval.

The Miro card offers **Inspect prepared map** and **Download prepared map** while publication remains disconnected. The briefing also offers **Prepared Miro map**. Inspection groups the saved complaint and evidence, investigation and recommendation, policy checks, human decision and outputs. A received clarification appears with its recorded source, reviewer and time. A missing current decision remains pending; earlier review history does not become a new approval or payment.

The custom JSON describes the displayed case revision. Record links require the current application session and open the current saved revision, so compare that revision with the downloaded map. Available output links do not prove delivery, and the arrows do not represent current agent activity. No board is published, and direct Miro import is unverified. The [provenance verification](verification-miro-provenance-2026-10-14.md) records the completed offline checks and browser inspection.

Prepared ElevenLabs audio, Miro publication, Modal text processing and Port metadata use a separate sponsor-action ledger beside the rehearsal marker. That file is not the financial case database. The ordinary launcher passes an empty provider environment and never activates those services. Restarting keeps the ledger but invalidates old local sessions.
