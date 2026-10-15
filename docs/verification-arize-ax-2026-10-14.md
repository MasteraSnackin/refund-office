# Arize AX preparation verification — 14 October 2026

Status: offline preparation implemented and checked. No Arize account has been connected and no trace has been uploaded.

The scope is a local recorder for actual operations, deterministic evaluation of the two committed synthetic packs, and a separately disabled Arize AX exporter. Refund decisions and payment permissions remain outside the recorder.

## What was checked

| Check | Result and scope |
|---|---|
| Full application suite | 481 tests passed |
| Build and Sites preparation | Build and four Sites checks passed |
| Recorder and prepared exporter | 18 focused tests passed using local responses only |
| Scorecard and evaluation preparation | 13 focused tests passed, including tampered explanations, amounts, case versions and trace bindings |
| Actual engine evaluation | All 62 committed synthetic cases matched their initial expectations; 508 checks passed and 372 spans were recorded |
| Actual PostgreSQL instrumentation | 25 checks passed: 20 existing database checks plus five new instrumentation checks; all 32 source inputs stayed unchanged |
| Local browser | Report opened and per-case checks expanded; Miro inspection and download also passed |
| Architecture maps | Both maps passed nine showcase checks and four viewport checks each, with no warnings or errors; 235 local documentation links resolved |

The evaluation runner uses fresh in-memory SQLite stores and the actual original engine. It checks exact amounts, item quantities, references, policy holds, approval stops, historical receipts, repeated intake and zero new payment operations. It makes no approvals and denies all provider and payment attempts. It does not claim to retest concurrent payment execution or live services. Those behaviours have separate workflow tests.

The separate PostgreSQL run measured twelve actual investigations: 48 nested spans. A fictional review/evidence clarification and reinvestigation added six spans. Saved revisions, RF labels, amounts, outcomes and check counts matched the recorded operations. Empty queue polls added no spans. A faulty recorder did not repeat intake or change its result. The traced tenant ended with zero approvals and zero new operations. The base database checks used separate disabled-reservation fixtures. The disposable database was removed.

After the generated map receipts were saved, the new observability map received two browser interaction spot checks: selecting the prepared-upload chapter focused its three components, and selecting the Arize story beat displayed the disabled HTTPS relationship and required destination settings. This supplements the generation receipts; it is not a full manual test of every viewer control.

Tracing records metadata from operations when they happen. It does not reconstruct earlier activity or label local rules as model calls. Raw complaint text, evidence bodies, customer statements, notes, source references, account identities and credentials are excluded. Capture and file errors are visible; they cannot change the business operation's result. Each rehearsal start retains a separate bounded trace segment.

## Saved evidence

- [Readable evaluation report](../ARTIFACTS.md#excluded-587b7ff4d0f06cda), [scorecards](../ARTIFACTS.md#excluded-c3928300bfac8548) and [browser screenshot](diagrams/arize-local-scorecard.png).
- [Focused trace bundle](../ARTIFACTS.md#excluded-1f849d6f9da7ae9d), [busy-office trace bundle](../ARTIFACTS.md#excluded-7a2fcd1d85605a39) and [prepared evaluation rows](../ARTIFACTS.md#excluded-3b47e56796d07cb7).
- [Actual PostgreSQL verification](../ARTIFACTS.md#excluded-e56bd786f0f3f3d0) and [runtime traces](../ARTIFACTS.md#excluded-e732fe46a4a222b5).
- [Full application tests](../ARTIFACTS.md#excluded-f700c7983f8a0660), [build](../ARTIFACTS.md#excluded-f6abffd73882261b), [Sites checks](../ARTIFACTS.md#excluded-843ac5e4d58f0e3c), [scorecard tests](../ARTIFACTS.md#excluded-29c0f5e7a78857b1) and [export preparation checks](../ARTIFACTS.md#excluded-649c5befe9cf1372).

Both saved synthetic bundles were prepared locally for each documented regional endpoint. All four attempted calls through the disabled exporter returned disabled, with zero transport calls. Enabled-path response tests used injected full, partial, malformed, failed and delayed replies. A collector acknowledgement is not treated as proof that traces appear in the intended workspace.

## Preservation

The local office resumed the same pack and retained all twelve cases exactly, including six waiting for approval, five held and one labelled historical remedy. The old session was revoked; the saved reset receipt still identifies the same fresh run. Startup created no retrospective spans. The original PostgreSQL demonstration's twelve cases, fifteen original data files and four earlier archives also remained unchanged. [Preservation evidence](../ARTIFACTS.md#excluded-1b818b142cac2c64).

## Still requires account acceptance

Tomorrow's activation needs the API key, intended Space ID, project name and the region of that space, followed by explicit selection and authorisation of a small synthetic trace upload. Credentials alone cannot enable the exporter. No Arize SDK, account permissions, subscription entitlement, collector acceptance or deployment was tested.

The exporter has independent network and upload opt-ins and checks the exact prepared selection digest. It does not automatically retry uncertain responses. Its repeated-attempt protection is confined to one exporter instance; there is no durable upload ledger. The normal application never calls it.

Evaluation rows are prepared in the documented dataframe-column shape and bound to the actual trace's case, revision, amount and outcome. Fixed explanations prevent arbitrary customer text being substituted. Attaching evaluations through the Arize SDK remains a separately authorised account step; no automatic evaluation uploader or LLM judge is implemented.

See the [setup guide](../integrations/arize/README.md). Primary references: [Arize tracing setup](https://arize.com/docs/ax/integrations/opentelemetry/opentelemetry-arize-otel), [evaluation attachment](https://arize.com/docs/ax/evaluate/run-evals-on-traces) and [official HTTP exporter source](https://github.com/Arize-ai/arize-otel-python/blob/main/src/arize/otel/otel.py).
