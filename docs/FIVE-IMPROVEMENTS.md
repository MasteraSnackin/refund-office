# Investigation, evaluation and demonstration improvements

This guide covers the five improvements requested after the product videos: model-assisted investigation, broader customer language checks, evaluation of the current PostgreSQL application, saved-history replay and a business-validation kit. Application providers remain disconnected. Human approval is still required for every new refund.

## What each improvement provides

| Improvement | Available code or artifact | What remains unverified |
| --- | --- | --- |
| Model-assisted investigation | The prepared hosted service selects local rules, OpenAI or Anthropic for its main investigation. The application validates the proposal and PostgreSQL repeats evidence, amount, policy and approval checks. | Real model behaviour, account access, model availability and deployed request limits |
| Customer language | The local interpreter handles the recorded sketchbook phrasing and bounded variants. Fixtures cover negation, ambiguity, contradictions, delivery disputes and provider failures. | General language understanding or accuracy on a retailer's real requests |
| Current workflow evaluation | A fresh local PostgreSQL runner investigates both committed packs, independently reads the saved cases and links each result to its actual trace. Prepared hosted tracing has an explicit, bounded memory mode. | Supabase account behaviour, durable hosted collection and Arize ingestion |
| Judge mode | The office replays saved events with pause, step, seek and speed controls, plus links to evidence, checks, decisions and reports. | A replay does not establish a new investigation or a live provider response |
| Business validation | A retailer interview guide, controlled comparison exercise, case packets, timing tool and results template are ready. | No interviews, savings, willingness to pay or customer adoption have been measured |

The completed current-workflow evaluation is available in the [local report](../ARTIFACTS.md#excluded-6ecf96668cf173b1) and [manifest](../ARTIFACTS.md#excluded-a0dd67f53ade5d7a). It covers 62 synthetic cases, 634 checks and 310 actual spans, with no provider requests and unchanged evaluated source files. The [combined verification record](verification-five-improvements-2026-10-14.md) records the final tested source version and remaining acceptance work. Earlier verification documents and source archives remain historical records of their own code versions; they do not prove these later changes.

## Prepare the selected analyser

The ordinary local launchers continue to supply local rules and disabled external services. Keys in the shell do not select a hosted investigation model. The prepared hosted construction requires both `REFUND_OFFICE_NETWORK=enabled` and an explicit `REFUND_OFFICE_ANALYSER=openai` or `anthropic`, with that provider named in `REFUND_OFFICE_ENABLED_INTEGRATIONS` and its credentials and model settings. Anthropic requires a model setting. Leave the network setting disabled during this offline work.

[Investigation proposal validation](../server/investigation-proposal.mjs) binds provider identity from server configuration. A model cannot supply approval, alter catalogue prices or set policy. A positive proposal must match an existing missing order line, its exact integer-pence value and known order/packing citations. Clarifications must agree with the proposed line. Where several order lines are missing, the received text must identify one full catalogue item name or item ID; the model cannot choose an arbitrary missing line. PostgreSQL independently checks the saved proposal before it can become a recommendation.

Migration [008_model_investigation.sql](../integrations/supabase/runtime/008_model_investigation.sql) adds recorded model provenance to the prepared database contract. Apply it only in a new reviewed setup or disposable local test, following [hosted setup](HOSTED-SETUP.md). Existing demonstrations are not upgraded in place.

The saved modes distinguish `local-rules`, `controlled-test` and `provider-response`. The latter records how the response was obtained; it is not proof of account acceptance or model accuracy. Controlled responses are injected by tests, not selected by a browser or an environment switch. Invalid, unavailable or contradictory results stop for review. There is no silent fallback to another model. An investigator can explicitly recover eligible work after inspecting the saved failure.

The separate saved-case advisory comparison remains available. It can compare model opinions against the saved case, but does not replace the investigation or alter its decision.

## Check customer language

The local interpreter is deliberately bounded. It supports known ways of naming an existing missing item and holds requests whose meaning or evidence conflicts. The earlier filming phrase, "The sketchbook is the missing item I am claiming. Please refund the sketchbook.", now has a regression fixture. Earlier recorded attempts remain history; the new code does not rewrite them.

Review [the language fixtures](../tests/fixtures/claim-language.mjs) and [model investigation tests](../tests/model-investigation.test.mjs). Positive paraphrases are not sufficient: test "not missing", multiple possible items, contradictory clarification, a delivery dispute and a provider that returns the wrong amount or an invented evidence reference. A safe hold is a correct result when the evidence does not support a refund.

These tests use synthetic examples and controlled provider responses. They cannot establish how an actual model will handle new customer requests.

## Evaluate the current PostgreSQL application

Run the local current-workflow evaluator from the application folder:

```sh
node scripts/evaluate-runtime.mjs
```

The runner uses the cached local PostgreSQL image and creates its own network-isolated temporary database. It applies the prepared migrations, imports the committed 12-case and 50-case packs into fresh synthetic tenants, replays their intake identities and calls the current application service. It reads each saved result independently before scoring it. The evaluated tenants request no approvals, new reservations or payments. The underlying database harness also exercises separate labelled fixtures; those fixture operations are not actions on the demonstration cases.

Each invocation writes a fresh directory under `work/runtime-evaluations/run-*`. Open its `index.html` for the report. Its companions include:

- `observed-cases.json`: expected and observed outcomes, amounts, evidence references, revisions and trace references.
- `scorecards.json`: case checks and run-level controls.
- `traces.json` and per-pack trace bundles: actual recorded operations.
- `arize-evaluations.json`: prepared rows bound to matching investigation spans; nothing is uploaded.
- `manifest.json`, `verification.json` and source snapshots: the run result, database checks and exact inspected source state.

A successful run must cover every expected case, retain the required traces, observe no external requests and finish with unchanged evaluated source files. A failing source-stability check needs a fresh run against settled code; a partial report is not a pass. The temporary database is removed after the checks. The original SQLite and PostgreSQL demonstrations are not inputs to the evaluator.

The earlier `npm run evaluate:local` command remains useful for the original SQLite engine. It writes to `work/arize-evaluations/run-*`. Keep the two reports labelled by engine and source version; do not present the SQLite report as evidence about the current PostgreSQL application.

## Prepare hosted tracing

`REFUND_OFFICE_HOSTED_TRACING=enabled` prepares metadata recording inside one hosted request. It retains at most 128 spans or 256 KiB in memory and performs no upload. It is disabled by default and has no durable hosted store. A function restart discards its memory. The existing authenticated `POST /api/machine/investigate` response can include `recordedTrace` for the caller to save; there is no separate trace endpoint or production monitoring service.

The same recorder rules keep customer statements, source references, internal identities, credentials and exception messages out of traces. A recorder failure must not repeat an investigation or replace its result. The local clarification launcher retains bounded trace segments separately. See the [observability map](diagrams/local-observability.html) and its [source notes](diagrams/local-observability.sources.md).

Arize AX remains a separate prepared exporter. Later activation requires selected synthetic data, destination space/project/region, credentials and explicit upload permission, followed by an account acceptance check.

## Use Judge mode

The dedicated offline launcher is `npm run demo:judge`. It opens a separate rehearsal on ports 4673/4674, with its own data under `.data/judge-runtime-rehearsals`; it does not replace an earlier demonstration. It accepts `focused-12` or `busy-50` and explicit saved-ID reuse through its underlying launcher.

Open a saved case and choose **Judge mode** in the case footer. Playback starts paused. Use **Play history**, the previous/next buttons, the event slider or an event in the list. Speeds range from 0.5× to 4×. At 1×, each event is displayed for 2.5 seconds; this is presentation speed rather than the original time taken.

The selected event shows its saved timestamp, label, detail and available recorded fields. The order is the API's stored event order, including tied timestamps. The separate case context shows the loaded revision and may include later evidence or decisions. It must not be used to claim that an earlier event cited all of today's sources.

**View saved evidence**, **View saved checks** and **View saved decisions** open read-only inspection panels. The report download uses the current session and run guard. These links retrieve current saved records, not historical revision URLs. Playback cannot start work, retry a decision, approve a refund or submit a payment.

If the case changes, playback pauses and asks you to load the latest history. A case, run or profile change closes the replay. Keyboard controls work on the playback area; buttons, selects and the slider retain their normal keyboard behaviour. The view has no automatic motion.

## Validate the customer problem

Use the [business-validation kit](business-validation/README.md) to interview a small retailer and run a manual-versus-assisted review exercise. The kit contains synthetic case packets, a facilitator answer key, an offline timing page, a results template and guidance for making evidence-based pitch claims.

Complete actual observations before quoting time saved or accuracy. Keep reviewer corrections, safe holds and incorrect approvals in the comparison, and distinguish active review time from waiting time. The kit prepares a study; it does not supply customer results.
