# Prepared sponsor integrations

All ten sponsor integrations have local code or configuration in this project. None has been connected, deployed or tested against an account in this work. The original office uses local analysis and simulated payments. The separate PostgreSQL office uses local profiles and stops at unpaid reservations. A prepared hosted API now wires the remaining sponsor actions; see [hosted setup](../docs/HOSTED-SETUP.md). Every new refund requires a human decision.

Start with [the environment template](.env.example). Its network setting is `offline`, its integration allowlist is empty and its analyser is `local`. It contains no credentials and is not loaded automatically. Keep filled configuration server-side and outside source control. Do not put keys in variables prefixed with `VITE_`, which can be included in browser assets.

The universal outbound gate is `REFUND_OFFICE_NETWORK=enabled`. The five clients in [sponsor-clients.mjs](../server/sponsor-clients.mjs) also require their name in `REFUND_OFFICE_ENABLED_INTEGRATIONS`: `n8n`, `supabase`, `miro`, `modal` or `port`. The legacy OpenAI, Anthropic, ElevenLabs and Stripe adapters use the universal gate plus their own explicit configuration. The new saved-case action and advisory services additionally require an individual allowlist entry for each selected external provider. Hosted storage requires `supabase-runtime`; the separate payment executor requires `stripe-runtime` and its own test-only switch. A key left in a shell does not enable a provider while the network gate is offline. Changing these settings is a future connection step, not part of the local setup delivered here.

## What is prepared

The [ten-sponsor guide](../docs/integrations.md) describes the current implementation and connection boundary for each provider. The [hosted setup guide](../docs/HOSTED-SETUP.md) gives the additive migrations, sign-in, durable sponsor ledger, Vercel entry point and protected machine routes. Those files supersede the earlier setup-only descriptions below where explicitly noted.

The customer clarification extension is implemented and checked offline in a separate local rehearsal on 4473/4474. Migration 007 adds received statements to held, unapproved cases without changing the original complaint or catalogue. Reviewers record the item, statement, source and reason; fresh local investigation still stops at Review. Later hosted use requires `REFUND_OFFICE_EVIDENCE_CLARIFICATION=enabled` as well as the migration. No customer contact, source fetching or provider access is added. See the [clarification procedure](../docs/LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal) and [verification record](../docs/verification-evidence-loop-2026-10-14.md).

| Area | Current source | Account acceptance still required |
| --- | --- | --- |
| OpenAI and Anthropic | Structured adapters plus [independent advisory comparison](../server/case-analysis.mjs) | Selected models, credits, request/output compatibility |
| ElevenLabs | [Saved-case action](../server/sponsor-actions.mjs), MP3 validation and playback | Approved voice, generation and listening quality |
| n8n | Inactive local and [hosted intake workflow](n8n/hosted-intake.workflow.json) | Import, credential binding and one protected invocation |
| Supabase | Operational migrations, sign-in, async repository and shared action journal | Real user/tenant isolation, refresh, revocation and RPC gateway |
| Vercel | [Hosted configuration](vercel/hosted.vercel.json) and root API entry point | Build, routing, function limits and deployment |
| Miro | Inspectable provenance map and per-card/per-connector publishing ledger with independent readback | Board access, layout, connector behaviour and exact content normalisation |
| Modal | Guarded text endpoint and saved-evidence action | Deployment and exact result validation |
| Stripe | Hosted reviewer authorisation/results screen and [separate test executor contract](supabase/runtime/PAYMENT-EXECUTION.md) | New exact human decision, matching test payment, dedicated executor and receipt readback |
| Port | Metadata upsert and independent retrieval | Blueprint, regional API and catalogue permissions |

## n8n: intake without approval authority

The following paragraph describes the original loopback workflow. The additive [hosted workflow](n8n/hosted-intake.workflow.json) instead uses the protected hosted intake and bounded investigation routes with a verified investigator and a separate machine key. Both stay inactive; neither contains approval or payment actions.

The JSON contains four nodes: an authenticated POST webhook, input validation, a call to the local intake API, and an acknowledgement. Importing it must leave it inactive. No credentials are embedded or bound.

If connection is approved later, create an n8n Header Auth credential with header name `X-Refund-Intake-Token`. Bind that credential to **Authenticated intake** and use the same secret as the server-side `N8N_INTAKE_TOKEN`. The webhook has to be configured before it can execute successfully.

Input contains `eventId`, `orderId` and `complaint`. A sender must retain the same event ID and payload when a response is lost. The workflow forwards that identity to `/api/intake`; a successful save produces `{ "accepted": true, "eventId": "the-original-reference" }`. That acknowledges intake only. It does not claim that investigation or payment succeeded.

The HTTP node deliberately targets `http://127.0.0.1:4174/api/intake`. It assumes n8n runs on the same host and network namespace as Refund Office. Inside a container, loopback points at that container. n8n Cloud cannot reach this local endpoint. Do not expose the local case API to solve that limitation. Use the separately prepared, authenticated hosted intake boundary after deployment and account testing are authorised.

The workflow disables saved execution bodies in its settings. It has no approval, advance, reconciliation, payment or customer-message node. The local worker stops at review. Static checks exercise its validation code and inspect its node configuration; no n8n import or execution has been performed.

References: [n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/) and [HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).

## Supabase: a private immutable archive

The migration creates `public.refund_decision_packets` with a composite key of owner, case and revision. Row-level security permits an authenticated reviewer to read only their own archive. Browser roles have no direct insert, update or delete grant. A trigger rejects updates and deletes.

`archive_refund_decision(p_case_id, p_revision, p_packet)` obtains ownership from `auth.uid()`, rather than trusting an owner supplied in the request. It rejects missing identity, mismatched packet identity/revision, invalid bounds and an oversized packet. Repeating the same packet returns the saved archive metadata. A different packet for the same owner, case and revision is rejected. The security-definer function uses an empty search path, qualified references and restricted execute grants.

The prepared client first calls `/auth/v1/user` with the current reviewer's access token, then calls the RPC. It checks the returned owner, case and revision. Keep reviewer tokens request-scoped. No service-role key is required by this client.

When database setup is authorised later, the migration must be applied by the intended privileged Supabase migration owner, with `BYPASSRLS` or equivalent administrator privileges. That owner becomes the security-definer function owner: forced RLS would otherwise block the RPC insert because no direct insert policy exists. Do not grant these privileges to a reviewer or browser role. Confirm the owner and exercise anonymous, two-user, conflicting-revision and concurrent-write cases in a disposable database before enabling this archive.

This is an archive, not a replacement for the live SQLite case database. It does not authenticate the current application's `local-reviewer` label, move its transaction/operation store to PostgreSQL, synchronise policy or make refund approvals multi-user safe. A separate [operational migration](../docs/SUPABASE-RUNTIME.md) now prepares those database responsibilities, while a separate local PostgreSQL rehearsal already uses the operational store and the hosted application is prepared but disconnected. This earlier archive SQL has been inspected and statically checked but has not been applied to PostgreSQL or Supabase; the new runtime tests do not verify this archive. Archive RLS, role and concurrent-write behaviour still need separate database tests before use. Database administrators retain administrative powers, so this is not a tamper-proof ledger.

References: [Supabase database functions](https://supabase.com/docs/guides/database/functions) and [row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Miro: saved provenance and independent readback

In the PostgreSQL and prepared hosted interfaces, use **Inspect prepared map** or **Download prepared map** in the Miro card; **Prepared Miro map** is also available in the briefing. [case-provenance.mjs](../server/case-provenance.mjs) builds the map from a saved case packet: original complaint and evidence, investigation, recommendation, policy checks, human review and outputs. Received clarifications retain their recorded attribution. Missing current decisions stay pending without erasing earlier review history, and available output links do not claim delivery. The shared SQLite briefing also offers **Prepared Miro map**, using the same export builder. The full inspector belongs to the runtime sponsor panel.

The export identifies the exact case revision. Its application links return the current saved case, report or export, not a permanent copy of that revision. PostgreSQL and hosted links require a session; the original SQLite path remains a local single-user demo. Source references are text, never fetched. The hosted map does not retrieve the separate execution record and cannot establish its payment result. `importReady: false` remains accurate: this is custom preparation, not a verified native import format. Inspection and download do not publish anything.

The prepared case action calls `planMiroNotes` and `planMiroConnectors`, and records the complete expected object set before any provider write. Each note has a durable local identity and saved acknowledgement before its content is independently retrieved. Each connector is then bound to two verified remote note identities; retrieval checks its endpoints and caption. The parent result records expected note/connector counts and is complete only when every expected object is confirmed. The interface otherwise says **Map publication is not fully confirmed**.

Readback only retrieves known identities. It cannot create missing planned objects, and an unknown write without a remote identity remains blocked from reposting. Generating a new command does not resolve that uncertainty. These results are still member-attested action records; the hosted database alone does not prove a provider was contacted.

A later authorised publication needs a chosen board, `MIRO_ACCESS_TOKEN`, `MIRO_BOARD_ID` and explicit network/provider opt-ins. A valid `REFUND_OFFICE_PUBLIC_ORIGIN` produces clickable HTTPS application links; without it the cards retain app-relative paths as text. Links open the current revision and retain the application's access controls. Source references remain text and are never followed. No online board was created in this work.

Reference: [Miro sticky-note retrieval](https://developers.miro.com/reference/get-sticky-note-item). The [provenance verification](../docs/verification-miro-provenance-2026-10-14.md) records the current offline checks. Live content normalisation, connector behaviour and board rendering remain unverified.

## Modal: bounded document text, without an authority claim

`extract_document({"id": "packing-104", "text": "Two mugs packed."})` returns a document reference, SHA-256 of the exact UTF-8 text, numbered lines and `authoritative: false`. It accepts at most 200,000 text bytes and 2,000 lines. It does not access files or networks, parse PDFs or establish whether the content is true.

The prepared Modal source refuses import before loading the Modal package unless the network gate is enabled and `modal` is allowlisted. Only after that local gate passes does its image recipe include the same settings for a future container to import the module. Its eventual endpoint requires a bearer token from the Modal secret named `refund-office-evidence`, containing `MODAL_EVIDENCE_TOKEN`. It checks authentication before reading the body, limits the request body and calls the same pure extractor. The client checks the returned document ID, text hash and every numbered line against the submitted text.

Only the pure extractor and the offline import guard were executed locally. Modal and FastAPI were not installed or loaded. The remote image recipe is preparation, not a deployed or dependency-locked service; dependency versions and account limits must be checked before any later deployment. Extracted lines are untrusted evidence and cannot approve or submit a refund.

Reference: [Modal web endpoints](https://modal.com/docs/guide/webhooks).

## Port: service metadata only

The blueprint accepts the readiness states `offline`, `prepared` and `configured-unverified`. It requires `humanApprovalRequired: true` and `liveVerified: false`. The sample service file matches the input to `upsertPortService`; the client builds the Port entity and enforces those two flags itself.

Configure an existing blueprint and the correct regional API origin only after connection is approved. The client accepts the official EU or US API origin. It writes service identity, title and readiness metadata. Do not add case complaints, customer details, payment references or credentials to this catalog. The low-level write acknowledgement alone is unverified. The prepared case action independently retrieves the entity and checks its readiness metadata before recording verification. Port is not an approval control or proof that deployment has happened.

References: [Port API](https://docs.port.io/api-reference/port-api/) and [context lake](https://docs.port.io/context-lake/overview/).

## Vercel: separate static and hosted configurations

The new [hosted configuration](vercel/hosted.vercel.json) selects the callable root API, verified sessions and durable Supabase store. Follow [hosted setup](../docs/HOSTED-SETUP.md) for that path. The following description applies only to the preserved older static template.

This is a configuration template, not an active deployment. If deployment is approved later, use the `refund-office` application directory as the Vercel project root. Copy `integrations/vercel/vercel.json` to that root and copy `integrations/vercel/api/offline.mjs` to `api/offline.mjs`. The build command runs there and produces `dist/client`.

Every `/api` path is directed to the prepared handler, which returns HTTP 503 for every method. It performs no proxying, database access, provider request or authentication bypass. The interface will therefore show its unavailable-service screen rather than a working hosted refund office. This deliberate limitation avoids presenting the local SQLite backend as a cloud service.

The prepared hosted implementation supplies the API, transactional store connection, sign-in and protected intake boundary. Deployment-specific integration tests still require a later authorised account setup. The Supabase archive above does not supply that runtime store. Nothing here opens a local service to the internet or publishes a site.

References: [Vercel Vite](https://vercel.com/docs/frameworks/frontend/vite) and [SQLite on Vercel](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel).

## OpenAI, Anthropic, ElevenLabs and Stripe configuration

Choose an analyser explicitly with `REFUND_OFFICE_ANALYSER`. The original engine selects one provider. The new saved-case advisory action can also compare a primary proposal with an independent Anthropic second opinion; it does not change the saved case or grant approval. Their proposed amount, issue, order line and evidence references are validated by the service; neither may approve a refund. Set the selected model explicitly after checking the account's available models. There is no current account verification.

ElevenLabs additionally requires an approved `ELEVENLABS_VOICE_ID` and model. The client only accepts a bounded audio response with an MP3 content type and header. No voice was selected, no narration was generated and no fallback provider was used in this integration work. Existing video narration is unchanged.

Stripe accepts test keys only. A key alone does not create the matching test PaymentIntent or prove that a sandbox refund works. The original simulator path and the PostgreSQL test executor are separate. The hosted reviewer form binds a new reason and confirmation to the exact saved approval, revision, amount and test mapping. Its read-only case lookup can recover an existing execution after a reload or lost response. An unknown authorisation keeps its original command; changed retries are blocked. Only the dedicated executor can submit or reconcile, leaving the original disabled reservation immutable. A timeout must be inspected against the original execution; it must not create another refund request with a new identity.

The environment template leaves all provider values blank. Preparation is not permission to connect: the present application remains offline.

## Offline checks

Run the setup checks from the application directory:

```sh
node --test tests/integration-setup.test.mjs
python3 -m unittest discover -s integrations/modal -p 'test_extract.py' -v
```

These checks validate prepared file contracts, execute the workflow's local validation code, test the Python extractor and import guard, and exercise the Vercel disabled handler. Those setup-file checks do not run n8n, apply SQL, import a Port blueprint, create a Miro note, deploy Modal/Vercel or call a provider. The separate `node scripts/test-payment-review.mjs` harness exercises migrations 001–006 together in disposable PostgreSQL, including the read-only reviewer context; see the completed [payment review verification](../docs/verification-payment-review-2026-10-14.md). The [clarification verification](../docs/verification-evidence-loop-2026-10-14.md) separately tracks migration 007. The earlier [sponsor wiring record](../docs/verification-sponsor-wiring-2026-10-14.md) remains unchanged. Account access, credits, live authentication, hosted routing and real service behaviour remain unverified.

`node scripts/test-evidence-loop.mjs` checks all seven operational migrations together in another disposable, network-disabled PostgreSQL instance. Its source-bound results are retained under `work/evidence-loop/database/`; it does not migrate an existing rehearsal or contact a provider.
