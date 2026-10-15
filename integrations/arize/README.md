# Arize AX preparation

The local recorder, deterministic evaluator and disabled Arize AX exporter are implemented and checked offline. Arize is additional observability for Refund Office, separate from its ten sponsor integrations. No trace has been uploaded and no account configuration has been accepted. The [verification record](../../docs/verification-arize-ax-2026-10-14.md) records the completed checks and their limits.

The [observability component map](../../docs/diagrams/local-observability.html) separates the recorder, evaluator, local files and disabled upload path. Its [source notes](../../docs/diagrams/local-observability.sources.md) identify the inspected implementation.

## What is recorded locally

[observability.mjs](../../server/observability.mjs) records the duration, parent/child relationship, status and selected metadata of operations that actually run. It uses `CHAIN` and `TOOL` spans. The analyser remains deterministic local rules; no model instrumentation or LLM judge is active. Reading an old case or exporting its report does not reconstruct a trace of its history.

The PostgreSQL [runtime hooks](../../server/runtime-service.mjs) cover intake, investigation and its claim/propose/finish steps, reviewer decisions, received clarification and recovery. Empty claim polls are omitted. These hooks send fixed operation names, revisions, amounts, outcomes, check counts and allowlisted synthetic pack/case labels. Internal case, order and actor UUIDs are excluded. Tracing cannot approve a refund, change policy or submit a payment. A recorder failure must not repeat an operation, replace its result or hide its original error; redacted status counters report degraded recording separately.

The observer accepts only controlled metadata. Raw complaints, customer statements, source text and references, reviewer notes, prompts, model responses, keys, tokens and exception messages are excluded. Synthetic runtime and evaluation traces may include an allowlisted pack name and synthetic case label. This is a metadata trace, not a transcript or private reasoning log.

The observer is memory-only unless its caller provides a local file. It retains at most 512 spans and 1 MiB by default, dropping older spans when either bound is reached. The supported maxima are 2,048 spans and 4 MiB. Its status reports dropped records and write failures; a bounded file is not a complete audit archive.

The clarification launcher writes a separate segment at `.data/evidence-runtime-rehearsals/<run-id>/traces/<start-id>.jsonl`. Each start uses a new filename, preserving earlier segments. The reset supervisor uses that launcher for each retained or fresh run. This does not add tracing to the original SQLite server, the 4273/4274 launcher or a hosted deployment. No earlier case history is replayed as new activity, and no segment is uploaded automatically.

## Run the deterministic synthetic evaluation

From the complete project, run:

```sh
npm run evaluate:local
```

The [evaluation runner](../../scripts/evaluate-arize.mjs) investigates the 12 focused and 50 busy-pack cases through the original application engine in fresh in-memory SQLite stores. It does not use or change the saved demonstration databases. Expected results come from the committed synthetic scenarios, separately from the observed investigation.

The completed local run covered 62 cases, 508 checks and 372 recorded spans. Its report is linked from the verification record. The scorecard checks case identity, expected outcome and amount, the selected missing item's quantity and value, evidence references, policy holds, the human approval boundary and exact labelled historical receipts. Run controls check complete coverage, replay of each intake event, no new operations, no payment attempts, no external provider requests and complete trace capture. Missing trace records or recorder errors prevent a passing overall report.

Each run creates a unique directory under `work/arize-evaluations/run-*` containing:

- `index.html` and `scorecards.json`: the readable report and detailed expected/observed results.
- `traces.json`, per-pack `.traces.jsonl` files and `.bundle.json` snapshots: the recorded metadata and trace identities.
- `arize-evaluations.json`: prepared evaluation rows linked to the actual investigation span IDs.
- `manifest.json`: dataset digests, recorder status and overall result.

Evaluation rows must match the recorded investigation's case, pack, revision, amount and outcome; explanations come from fixed definitions. The rows use `context.span_id` plus `eval.<name>.score`, `eval.<name>.label` and `eval.<name>.explanation` columns for the documented `ArizeClient.spans.update_evaluations` interface. Run-level controls stay in the local report rather than being attributed to one case span. There is no automatic evaluation upload.

These checks cover initial synthetic investigations and intake replay. They do not establish evidence authenticity, real-world decision quality, duplicate-payment retry, concurrent PostgreSQL workers or live provider behaviour. The separate PostgreSQL instrumentation tests and earlier workflow checks retain their own scope. A score is a comparison with an expected example, not financial authority.

## Prepared trace export

[arize-ax.mjs](../../server/arize-ax.mjs) prepares a bounded selection of synthetic spans as OTLP HTTP protobuf. It is a small explicit encoder, not the Arize SDK or automatic instrumentation. Preparation takes the exact selected span IDs, project name and `us` or `eu` region. It validates the metadata again, limits one export to 512 spans and 2 MiB, and returns a payload hash. A subset may omit parent spans; the export reports that count rather than claiming a complete trace.

The separate exporter defaults to disabled. It does not read the environment automatically or run from the observer. An upload requires both explicit boolean opt-ins, the chosen account settings, confirmation of the exact selection and its expected payload hash. The [blank environment example](.env.example) documents these inputs; it does not activate them.

| Input | Purpose |
| --- | --- |
| `ARIZE_NETWORK_ENABLED` | Independent network opt-in; defaults to `false` |
| `ARIZE_TRACE_UPLOAD_ENABLED` | Independent trace-upload opt-in; defaults to `false` |
| `ARIZE_API_KEY` | Server-side API key for the intended Arize AX space |
| `ARIZE_SPACE_ID` | The intended space identity |
| `ARIZE_PROJECT_NAME` | The intended synthetic project name |
| `ARIZE_REGION` | Explicit `us` or `eu`, matching that space |

The destination is selected from fixed regional endpoints. An API key alone is insufficient. The exporter has no automatic retry. It blocks a repeated payload within the same exporter instance, but there is no durable upload ledger across processes. After an uncertain response, retain the original selection and result and inspect the destination; restarting is not permission to resend it.

A collector result may be accepted, partial, rejected or unconfirmed. Even an accepted response is only a collector acknowledgement. It does not establish that the intended workspace displays every trace, that evaluation rows attach correctly or that an account has passed acceptance. Account validation remains unverified in the prepared result.

## Later account acceptance

Choose the intended API key, Space ID, project name and correct space region. Inspect and select the synthetic traces, explicitly authorise their upload, and verify the destination, recorded identities and contents in the intended space and project. Only then consider separately authorising attachment of the matching evaluation rows. Ordinary local rehearsals keep uploads disabled.

Official setup references supplied for this preparation: [manual tracing instrumentation](https://arize.com/docs/ax/observe/tracing/setup/manual-instrumentation), [Arize OpenTelemetry](https://arize.com/docs/ax/integrations/opentelemetry/opentelemetry-arize-otel) and [evaluations on traces](https://arize.com/docs/ax/evaluate/run-evals-on-traces). These references do not establish account access or successful ingestion. Existing archives and earlier verification records remain separate.
