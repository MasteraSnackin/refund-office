# Local observability map: source notes

This map describes inspected working code on 14 October 2026. It now separates evaluation of the current PostgreSQL service from the earlier SQLite engine, preserves their original node identities, and shows the shared metadata recorder and disabled Arize AX exporter. The accompanying cards explain prepared model selection, request-memory tracing, read-only Judge mode and the business-validation kit. No application account has been connected and no trace or evaluation has been uploaded.

The folder has no Git revision suitable for commit-pinned source links. These are ordinary working-file references. The preserved source, output and receipts from the preceding map are in `work/five-improvements/map-before`; the earlier sponsor and original architecture maps remain unchanged.

| Component or flow | Inspected source | What the relationship means |
| --- | --- | --- |
| Synthetic packs to original evaluator | `demo-data/focused-12.json`, `demo-data/busy-50.json`, `scripts/evaluate-arize.mjs` | Committed inputs are loaded into fresh in-memory SQLite stores. |
| Original evaluator to original engine | `scripts/evaluate-arize.mjs`, `server/engine.mjs` | The earlier evaluator invokes actual local engine operations; its report retains that scope. |
| Synthetic packs to current evaluator | `scripts/evaluate-runtime.mjs` | Both packs enter fresh synthetic tenants in a new network-isolated local PostgreSQL container. Existing demonstration databases are not used. |
| Current evaluator to PostgreSQL workflow | `scripts/evaluate-runtime.mjs`, `server/runtime-service.mjs`, `server/local-postgres-runtime.mjs` | The runner calls the current service, replays stable intake identities and independently reads saved results through the repository. |
| Engine results to separate scorecards | `server/evaluation-scorecard.mjs`, `server/runtime-evaluation-scorecard.mjs` | Each engine has its own expected-versus-observed checks. The diagram groups the two scorecard modules but does not merge their reports or verification claims. |
| Packs to scorecards | The same committed datasets and scorecard modules | Expectations are separate from observations and do not choose the investigation result. |
| PostgreSQL workflow to metadata recorder | `server/runtime-service.mjs`, `scripts/run-evidence-rehearsal.mjs` | Invoked intake, investigation, review, clarification and recovery operations create metadata. Empty polls, exports and history playback do not invent spans. |
| Hosted workflow recording | `server/hosted-runtime.mjs`, `server/hosted-observability.mjs`, `server/hosted-api.mjs` | Explicit `REFUND_OFFICE_HOSTED_TRACING=enabled` installs a bounded request-memory observer. The authenticated machine investigation response can include `recordedTrace` for its caller to retain. No durable store or collector is configured. |
| Recorder to retained records | `server/observability.mjs` | The recorder exposes a bounded memory snapshot and can save local JSONL segments. The hosted instance has no file sink. Loss and recording errors are visible. |
| Trace references to scorecards and evaluation rows | Both scorecards, `server/arize-evaluations.mjs`, `server/runtime-evaluation-scorecard.mjs` | Case identity, revision, amount and outcome must agree with an actual completed investigation span. Prepared rows are not uploaded. |
| Selected records to prepared exporter | `server/arize-ax.mjs` | Explicit selection produces a bounded payload and hash; recording does not trigger an upload. |
| Prepared exporter to Arize AX | `server/arize-ax.mjs`, `integrations/arize/.env.example` | The dashed edge is disabled. Later use needs network/upload opt-ins, account/space/project/region settings and confirmation of the exact synthetic payload. |

## Prepared investigation and display boundaries

[Investigation proposal validation](../../server/investigation-proposal.mjs) adds explicit main-workflow selection to the prepared hosted service. It requires global network permission, the selected analyser and its provider allowlist entry. Ordinary local launchers continue to use rules. The application validates exact catalogue values, known citations and clarification consistency; migration [008](../../integrations/supabase/runtime/008_model_investigation.sql) independently enforces saved evidence, policy and review. Controlled model responses are labelled separately from provider transport responses. Neither grants refund authority or proves model accuracy.

[Judge mode](../../src/JudgeReplay.jsx) reads saved events and labels the separate loaded case revision. Playback cannot invoke the recorder, rerun an investigation, approve or pay. The [business-validation kit](../business-validation/README.md) prepares interviews and a timed review comparison; it contains no measured customer results. These presentation and research artifacts are explained in cards rather than drawn as tracing dependencies.

## Storage, privacy and verification

The recorder admits fixed operation names, `CHAIN`/`TOOL` kinds and `LLM` only for a selected model proposal, timing, status, revisions, amounts, counts and allowlisted synthetic labels, plus configured analyser provenance. It excludes raw complaints, customer statements, source references, notes, internal case/order/actor UUIDs, credentials and exception messages. Local rules are not labelled as LLM activity. Recording failure cannot replace the workflow result or repeat its action.

The local clarification recorder defaults to 512 spans or 1 MiB per segment and keeps earlier segments. Hosted recording retains at most 128 spans or 256 KiB in one request's memory. The evaluator explicitly allows larger local capture for its synthetic run and fails its capture check if required records are lost. These traces are not a complete financial audit archive; case history remains the decision record.

The [current PostgreSQL report](../../ARTIFACTS.md#excluded-6ecf96668cf173b1) and [manifest](../../ARTIFACTS.md#excluded-a0dd67f53ade5d7a) record 62 cases, 634 checks and 310 spans against unchanged evaluated source files. Its tenants create no approvals, new operations or payment executions. Separate database harness fixtures exercise their own controls. The earlier [Arize verification](../verification-arize-ax-2026-10-14.md) retains the original SQLite report's scope.

The prepared exporter uses fixed US/EU OTLP destinations. A future collector acknowledgement would not establish workspace visibility or account acceptance. It has no automatic retry or durable cross-process upload ledger. No evaluation-upload edge is drawn because that operation is not implemented.

The viewer supplies search, focus, guided views and route tracing. Reachability describes this authored map, not live traffic. Automatic animation is disabled. The adjacent validation, delivery, browser and visual-review receipts identify exactly what was checked.
