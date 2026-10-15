# Sponsor integrations

Refund Office runs without sponsor accounts or credits. The original SQLite office uses local rules and simulated refunds. The separate PostgreSQL office uses local rules and stops at an unpaid reservation after a human decision. Both ordinary launchers keep external services disconnected.

The sponsor application code is prepared for later connection. It has local tests with injected responses; those tests do not establish credentials, credits, model availability, a deployed service or successful account access. The office log records actual saved workflow events, not invented model activity.

## What each sponsor does

| Sponsor | Implemented code | Current boundary |
| --- | --- | --- |
| OpenAI | Structured proposal adapter for the prepared main hosted investigation, plus a separate saved-case advisory action | Disconnected. Ordinary local launchers use rules. Main proposals face independent application/SQL checks; advisory output cannot alter a saved recommendation or approve payment. |
| Anthropic | Alternative main-investigation proposal adapter and a separate optional advisory second opinion compared with the primary result | Disconnected. Disagreement and unavailable responses are visible. Model agreement is not authority. |
| ElevenLabs | Saved briefing generation, bounded MP3 validation, durable command/result storage and playback controls | Disconnected. No audio has been generated in this work. An explicitly selected voice is required; no alternate speech provider is used. |
| n8n | Inactive local/hosted workflow examples and a protected hosted intake/investigation hook | No n8n execution. A fixed investigator identity and separate machine key are required. Intake cannot approve or execute refunds. |
| Supabase | Operational storage, async repository, verified sign-in/session code, tenant roles, shared sponsor ledger and separate historical archive preparation | Real PostgreSQL is exercised locally. No Supabase account, gateway or online session is connected. |
| Vercel | Root API entry point, request-scoped hosted runtime and separate hosted build/routing configuration | Not deployed. The older static template remains separate and deliberately has no functioning case API. |
| Miro | Inspectable source map, saved references, prepared cards/connectors and per-object publishing/readback records | Disconnected. Missing objects or lost responses without identities block completion and reposting. The downloaded map is custom JSON, not a verified native import. |
| Modal | Saved-evidence text action, guarded endpoint source and exact identity/hash/line validation | Disconnected. No uploads, OCR or authenticity claim; the original evidence and approval remain unchanged. |
| Stripe | Original test-only adapter plus a separate hosted reviewer form, saved execution lookup, dedicated executor, saved intent and independent receipt retrieval | Original receipts are simulations. Current PostgreSQL preview cannot submit. The prepared form records a new exact authorisation; only the executor can submit or reconcile. |
| Port | Service metadata publishing and independent catalogue readback | Disconnected. No case contents are uploaded by this action; readiness metadata grants no deployment or refund authority. |

## Controls before any connection

`REFUND_OFFICE_NETWORK` must be exactly `enabled`. Credentials alone do not permit requests. New sponsor actions also require the individual provider name in `REFUND_OFFICE_ENABLED_INTEGRATIONS`. The hosted application adds its own explicit switch and working-store selection. Optional payment execution has an additional test-only switch and dedicated machine identity.

The normal PostgreSQL rehearsal passes an empty provider environment, regardless of shell settings. Its local analyser and separate action ledger need no secrets. The original offline launcher does not open optional credential files. The interface has no toggle that silently enables paid services.

Keep filled configuration server-side and outside source archives. The [blank sponsor template](../integrations/.env.example) and [hosted template](../integrations/vercel/hosted.env.example) remain disabled. See [hosted setup](HOSTED-SETUP.md) for exact settings and later acceptance steps.

## Model and voice actions

The prepared main hosted investigation selects a model explicitly through [investigation-proposal.mjs](../server/investigation-proposal.mjs). It requires global network opt-in, explicit analyser selection and the selected provider in the integration allowlist. It does not infer selection from an ambient key. The application checks known evidence, clarification consistency and exact catalogue value; migration 008 independently enforces saved policy and review. Provider/model/mode provenance distinguishes local rules, controlled test responses and provider transport responses. Invalid or unavailable output stops for review and explicit recovery, with no silent fallback. See [hosted setup](HOSTED-SETUP.md#selected-investigation-and-request-tracing).


The [advisory service](../server/case-analysis.mjs) obtains an access-scoped saved packet and accepts only its expected revision. It compares the same evidence across configured providers, checks evidence IDs and the exact missing-item amount, and rereads the saved snapshot before returning. It has no case-writing or payment interface. Its download is an advisory result, not a decision or a replacement history entry.

`REFUND_OFFICE_ANALYSER` selects `local`, `openai` or `anthropic`. `REFUND_OFFICE_CHALLENGER` is `none` by default and may select `anthropic` alongside a different primary. Each external selection requires its individual allowlist entry and credentials. Unavailable results remain unavailable; another model is not selected silently.

ElevenLabs receives the saved briefing and the explicitly configured voice. The adapter checks MP3 type, header and size. The durable ledger retains the accepted bytes, and the user starts playback. Current offline operation supplies text only. Existing video narration is unchanged. Voice availability and listening quality still require a later authorised account check.

The existing provider request formats were checked against official documentation earlier in this work: [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and [ElevenLabs text to speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert). Local test responses are not live API acceptance.

## Intake and human review

A stable intake event contains `eventId`, `orderId` and `complaint`. Repeating the same identity and contents returns the saved case; conflicting reuse is rejected. The investigator gathers supplied records and checks eligibility. It stops for review, a hold or an existing remedy.

The PostgreSQL worker uses database claims and fences. Hosted scheduling runs one bounded call at a time. Reviewers make exact decisions; investigators cannot approve, submit, reconcile or replace a payment. In the original SQLite and 001/002 rehearsals, an evidence request records an internal note only. Reopening does not pretend that new evidence was received.

The separate [clarification rehearsal](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal) is implemented and checked offline on 4473/4474. A reviewer can record a received statement, source reference and existing order item after requesting evidence. The atomic save preserves the prior investigation and original catalogue, clears the old recommendation and queues fresh local analysis. It does not contact a customer, fetch a source, override packing/delivery/policy checks or grant approval. The prepared hosted variant requires migration 007 and explicit `REFUND_OFFICE_EVIDENCE_CLARIFICATION=enabled`; its investigator still runs through a bounded invocation.

The local API remains loopback-only. An external n8n instance must use the separately deployed, protected hosted contract. Importing an inactive workflow does not connect it or give it payment authority.

## Saved outputs and sponsor writes

Briefings, Markdown reports and decision packets read saved facts. The PostgreSQL and hosted Miro map links the original complaint and sources, investigation and recommendation, saved policy checks, human review and output destinations. **Inspect prepared map** and **Download prepared map** work without a provider connection. Missing current decisions stay pending without erasing earlier review history; an available report is not proof of delivery. Source references are quoted text, and arrows describe record relationships rather than live agents or private reasoning.

The custom JSON is bound to the displayed revision and is not a verified native Miro import format. Its current authenticated application links can open a newer saved revision; they are not immutable snapshot URLs. Reports distinguish recommendations, human decisions, original reservations and known receipts. The hosted map does not retrieve separate execution records, so their payment result must be inspected in the dedicated reviewer view.

The hosted payment review screen binds a new authorisation to the exact previous approval, current case revision, amount and test-account/payment mapping. It requires a new reason and confirmation. The browser keeps the original command while its result is unknown, and the case lookup returns any saved execution after a reload. Reviewing or authorising does not submit a refund; submission and reconciliation require the dedicated executor. The normal PostgreSQL rehearsal keeps this path unavailable.

New sponsor writes save a command and payload binding before the provider request. Miro records the complete expected card/connector set before the first write, then saves each object identity and checks it by retrieval. Connector checks include both verified endpoints and the caption. Every expected object must be confirmed before publication is marked complete. Readback cannot create missing objects; unknown writes without a remote identity stay blocked. Modal results retain the source text digest and cannot replace authoritative evidence. Port checks the original configured catalogue destination and metadata by readback.

The local action ledger is a separate SQLite file. The hosted ledger is shared PostgreSQL storage; a serverless function never treats an in-memory map or temporary file as durable external-write history. Its entries are member-attested: an authorised tenant member can submit a claimed provider result directly through the journal RPC. The facade performs readback, but SQL does not prove it happened. **Readback recorded** is a workflow status, not an independently authenticated provider receipt. The journal has no payment authority. Database owners retain administrative powers.

## Local verification and remaining limits

The [current PostgreSQL evaluator](../scripts/evaluate-runtime.mjs) drives the actual service in a separate temporary local database and links saved cases to real operation traces. Its report is separate from the earlier SQLite evaluator. The prepared hosted tracing option retains bounded request memory and can return it to an authorised caller; it has no durable collector or Arize upload. The [five-improvement guide](FIVE-IMPROVEMENTS.md) covers these distinctions, read-only Judge mode and the business-validation kit.


The [Miro provenance verification](verification-miro-provenance-2026-10-14.md) records the current source-map checks and their status. The completed [customer clarification verification](verification-evidence-loop-2026-10-14.md) records the earlier offline application, database and browser checks. The completed [payment review verification](verification-payment-review-2026-10-14.md) and earlier [sponsor wiring record](verification-sponsor-wiring-2026-10-14.md) retain their source checks, disposable PostgreSQL checks and browser observations. The [architecture](../ARCHITECTURE.md) and [setup package](../integrations/SETUP.md) locate each boundary.

Provider tests use synthetic keys and injected responses. They verify offline refusal, malformed output, role and revision checks, durable intent, readback and uncertain-write handling. They do not verify a sponsor account, entitlement, deployment, external availability, real money movement or production compliance.
