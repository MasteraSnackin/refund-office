# Prepare the sponsor setup session

Everything here is preparation for a later authorised connection. No upload, account login, provider request or deployment is performed by generating the handover. The original office remains local with simulated payments; the separate PostgreSQL rehearsal records unpaid reservations. Both require human approval. The [prepared hosted application](HOSTED-SETUP.md) now has its own API and sign-in code, without a connected account.

Run the preparation script from the complete project when the synthetic datasets are present:

```sh
node scripts/prepare-sponsor-handover.mjs
```

It writes `handover/`, a small sponsor-specific pack rather than a standalone copy of the application. The full app still needs the project described in [README.md](../README.md). The pack includes only named source/configuration/documentation files and generated synthetic examples. It excludes the working database, filled environment files, work folders, logs, videos, dependencies and customer records.

The new [customer clarification rehearsal](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal) belongs to the complete application, not this legacy small pack. Its separate local volume, additive migration and received-statement screen do not connect an inbox, fetch a source or enable a payment. Current checks are recorded in the [clarification verification](verification-evidence-loop-2026-10-14.md).

The complete application also prepares an inspectable Miro provenance map from saved sources, checks, recommendations, human decisions and output destinations. Its JSON is not a native Miro import file, and its current-session record links are not permanent revision snapshots. Freshly generated small packs include the shared export builder and a synthetic example, but not the complete application or inspector. Existing archives retain their earlier contents. See the [current Miro setup](../integrations/SETUP.md#miro-saved-provenance-and-independent-readback) and [provenance verification](verification-miro-provenance-2026-10-14.md); no board has been published.

The script refuses symbolic links, oversized inputs and nonblank credential fields in templates. On regeneration it checks the previous manifest and refuses to overwrite a file that has changed since generation. It never scans for credentials or reads a saved private configuration file.

## Readiness language

| State | Meaning |
| --- | --- |
| `prepared` | Code, configuration or an example is present. Account and service behaviour remain unverified. |
| `local-verified` | A named local check ran against a pure function or injected response. Its scope is recorded in the manifest. It does not prove a remote integration. |
| `configured-unverified` | Reserved for later explicit account configuration whose access and behaviour have not yet been tested. No sponsor receives this state merely because its template exists. |

Every sponsor entry in the generated manifest has `connected: false` and `liveVerified: false`. Request examples are not sent requests. There are no invented remote payment, board, deployment or account identifiers.

## Materials to have ready later

Use the [complete setup guide](../integrations/SETUP.md) for each prepared file and its current limitations. Keep secrets outside the shared pack. Choose provider accounts, permitted models, the approved ElevenLabs voice, reviewer identities and the intended synthetic-only test project before enabling any connection. Check actual access and credit availability at that later point; this work establishes neither.

| Sponsor | Prepared material | First authorised check later |
| --- | --- | --- |
| OpenAI | Exact structured proposal request body, saved synthetic input and provider source. | Select an available model and verify one advisory proposal against the saved evidence. Deterministic policy and human approval remain mandatory. |
| Anthropic | Messages request with constrained JSON output and the same input. | Select an available model and verify proposal format, refusal handling and evidence references. It can provide an alternative primary analysis or an independent advisory challenge; neither grants approval. |
| ElevenLabs | Text briefing and a request template with an unfilled voice placeholder. | Confirm the approved voice exists, review the text and generate one briefing only after credits and permission are available. No default voice or fallback provider is supplied. |
| n8n | Inactive local and hosted intake workflows with stable demo events. | Choose the intended workflow, bind its separate intake credentials, inspect target endpoints, then verify duplicate events and bounded investigation without approval or payment authority. |
| Supabase | Separate archive and operational SQL, hosted sign-in, asynchronous repository, shared action ledger and synthetic imports. See [hosted setup](HOSTED-SETUP.md). | Verify real authentication, role isolation, refresh/revocation and RPC permissions. Preserve the separate local stores and rehearse cutover. Ordinary approvals remain unpaid reservations. |
| Vercel | Separate static template and prepared hosted API configuration. | Select the hosted configuration deliberately; verify its build, API routing, signed-in workflow and function limits. The older static template still returns API-unavailable responses. |
| Miro | Custom provenance JSON, shared export builder and prepared note bodies without a board identity. The full application adds inspection and durable card/connector publication. | Choose an authorised test board and public application origin; check reviewed notes and connector endpoints/captions independently. Retain the complete expected object set and saved identities before any retry. |
| Modal | Pure extractor, guarded deployment source, synthetic input and expected local result. | Confirm dependencies, account limits, secret binding and endpoint authentication before deployment; compare the first result with the supplied hash and lines. |
| Stripe | Legacy test adapter plus a prepared hosted authorisation/results screen, read-only case lookup and separate execution module. | Use an exact test-account/payment mapping, a new human execution authorisation and a dedicated executor. Refresh saved results after a lost reply and retain the original command for an exact retry. A lost submission without a refund identity remains blocked from reposting. |
| Port | Readiness blueprint and service metadata example. | Import or select the intended blueprint, then write and independently read one non-sensitive catalogue entry. This grants no deployment or payment authority. |

## Suggested connection order

Start with the working local rehearsal: submit intake, observe investigation and inspect the saved briefing. In the PostgreSQL office, an explicit approval records an unpaid reservation. The original SQLite demo separately offers a simulated receipt. Keep the report from the chosen path as its reference result.

When connection is later authorised, verify one external analyser first while payments stay local. Then verify the chosen voice and the intake workflow independently. Stripe test payments come only after the approval and recovery tests still pass. Treat shared storage and complete hosted execution as a separate deployment phase; neither a Vercel preview nor the Supabase archive makes the local workflow cloud-ready.

Miro, Modal and Port can be checked against synthetic examples without granting them financial authority. Keep evidence-processing outputs untrusted until the refund engine validates the facts that matter for a recommendation.

## Controls that must remain in place

Leave `REFUND_OFFICE_NETWORK=offline`, `REFUND_OFFICE_ANALYSER=local` and the integration allowlist empty for current testing. Templates do not load themselves. A future operator must deliberately provide server-side configuration and restart or construct the intended adapter. The five outbound sponsor clients also require their names in `REFUND_OFFICE_ENABLED_INTEGRATIONS`.

Do not use an external workflow or model response to approve a refund. Keep amount/evidence/policy checks in the service, bind human approval to the exact facts and preserve original operation identity before submission. An uncertain write is a reconciliation task, not permission to repeat it with a new identity.

The original n8n template targets loopback and the original static Vercel template returns an unavailable API response. Separate hosted templates now use the prepared authenticated receiving endpoints and Supabase store. They do not activate or replace the original templates. Follow [hosted setup](HOSTED-SETUP.md) for that deployment path and its remaining account, routing and recovery checks.

## Evidence to retain during later checks

Record the synthetic case/input, adapter version, selected provider/model, exact request identity, response or redacted error, independent readback and the next allowed action. Keep account credentials and bearer tokens out of reports. A setup step is complete only when its stated acceptance check passes; adding a key or receiving a write acknowledgement is not enough.

After any uncertain external write, pause the affected path and inspect its original identity before retrying. Keep unrelated integrations disconnected. Do not change the app's readiness display to connected or verified until there is evidence for that specific integration and scope.
