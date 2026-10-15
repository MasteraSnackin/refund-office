# Five improvements: offline verification

Verified on 14 October 2026. All five requested implementation tasks are complete within the offline scope. This record covers the current source and the named outputs below. Earlier verification records and preparation archives remain unchanged and describe their own versions.

## Delivered work

| Task | Delivered result | Evidence and limits |
| --- | --- | --- |
| Model-assisted investigation | OpenAI and Anthropic can be explicitly selected for the main prepared runtime investigation. Proposal validation and additive migration 008 independently check saved facts before creating a recommendation. | Both adapters ran through the actual service and PostgreSQL using injected responses. No provider account was contacted. Every refund still requires human approval. |
| Customer language and recovery | The bounded local interpreter supports the phrasing that failed during filming and other missing-item paraphrases. Negated, ambiguous and contradictory claims remain held. Provider outages and invalid proposals leave recoverable failures. | 33 committed language scenarios and 55 model/language unit tests pass. This is finite synthetic coverage, not a claim of general language understanding. |
| Current-workflow evaluation and tracing | A fresh PostgreSQL runner evaluates both synthetic packs, independently reads back saved results and links them to actual workflow spans. Prepared hosted tracing is explicitly enabled, bounded request memory with an authenticated response export. | 62 cases, 634 checks and 310 spans pass. No Arize upload occurred. Hosted trace collection is not durable and does not establish live account acceptance. |
| Judge mode | Read-only saved-event playback with pause, step, seek, speed, evidence/check/decision inspection and report download. | Fourteen focused replay tests plus local browser checks pass. Playback order follows saved event order; presentation speed is labelled separately from elapsed workflow time. |
| Business-validation kit | Retailer interview guide, notes template, balanced manual-versus-assisted exercise, raw synthetic case packets, separate answer key, offline timing/CSV tool and pitch evidence worksheet. | Four focused tests and browser persistence/export checks pass. No retailer interviews or customer savings have been measured. |

## Final checks

- `npm test`: **573 passed, zero failed or skipped**. [Full log](../ARTIFACTS.md#excluded-1a76b24c9e61f4a9).
- `npm run build`: passed, including the prepared Sites build output. [Build log](../ARTIFACTS.md#excluded-d9aa68c050634b30).
- `npm run test:sites`: **4 passed**. These are also included in the full application suite; do not add them to 573. [Log](../ARTIFACTS.md#excluded-93e1ab65b719bcb3).
- Main model/database verification: **26 check groups passed**, including controlled OpenAI and Anthropic responses, exact amount/citation enforcement, role and retry checks, invalid input, unavailable providers and direct SQL rejection of ambiguous item selection. [Final record](../ARTIFACTS.md#excluded-fed7d29a5c952f31).
- Current-workflow evaluation: **22 database check groups passed**, with **62 cases, 634 checks and 310 spans**. [Report](../ARTIFACTS.md#excluded-6ecf96668cf173b1), [manifest](../ARTIFACTS.md#excluded-a0dd67f53ade5d7a), [database record](../ARTIFACTS.md#excluded-e47249461d31cac0).
- Updated architecture map: **9/9 checks**, zero errors or warnings; browser containment and light/dark visual inspection passed. [Map](diagrams/local-observability.html), [delivery receipt](diagrams/local-observability.delivery.json), [visual check](diagrams/local-observability.visual-check.json).

The database suites overlap in their base checks and should not be added together as unique coverage. Both used new network-isolated local PostgreSQL containers with no existing data mounts, then removed those containers. Local identity uses test profiles rather than real Supabase JWT verification. Separate disposable harness fixtures exercise disabled approvals and reservations; the model and 62-case evaluation tenants created no approvals, new payment operations or executions.

## Review findings resolved before completion

Independent review reproduced an unsupported model selection: a complaint saying several items were missing could let a model choose one of two omitted lines. The application and database now require exactly one explicitly identified catalogue item when several lines are omitted. Direct SQL tests reject generic and multiple-item claims; an explicit unfamiliar paraphrase still produces a recommendation awaiting review.

The review also tightened individual provider allowlisting, kept database actions labelled as local rather than model calls, retained recognised LLM span types while preserving redaction, and made incomplete trace recording visible without replacing or repeating the original operation.

The final model verification source digest is `67569cf15917160424939eff57e79f2a822c63c0e205dd84fa59d9adb89b81b9`. The final current-workflow evaluation digest is `e46490b9bc6dd6d70274053c483222adb87623300db164a831e04fc10b1bbcfc`. Each run records its own source list and confirms those sources remained unchanged during execution; the two digests cover different lists.

## Local browser rehearsal

A fresh focused pack runs separately at `http://127.0.0.1:4673/`, with API port 4674 and its own directory under `.data/judge-runtime-rehearsals`. Its run ID is `8a25b496-c5a6-4d26-9a4d-ef6185d63155`. It uses local rules and disconnected providers. The original demonstrations were not replaced.

The browser checked play/pause, next, speed and keyboard seek, then opened all three read-only inspection links. The downloaded RF-2001 brief matches revision 3, the £20 recommendation, seven policy checks and no human decision. The final authenticated readback has six cases awaiting approval, five held and one labelled historical remedy. No new refund was approved or submitted. [Browser record](../ARTIFACTS.md#excluded-934dcc9c2250ab41), [downloaded brief](../ARTIFACTS.md#excluded-d8f047f3d01ec2ec), [replay screenshot](../ARTIFACTS.md#excluded-6828e4973628eb21).

The current PostgreSQL report was opened in the browser. RF-2001's expected/observed £20 result links to its actual recorded investigation, saved revision and citations. [Trace screenshot](../ARTIFACTS.md#excluded-481a66ef68853daa).

The business tool was checked with an explicitly labelled `QA_ONLY` software-test observation. Its stopwatch, save, next-case allocation, CSV export and restoration after reload worked. After exporting that test observation, the form was cleared and returned to zero observations with “Not measured” summaries. This is software verification, not a participant result. [Browser record](../ARTIFACTS.md#excluded-79c5d7475031cba9).

## Preservation and documentation

All **30 protected files** match their before-work hashes, including the original saved data files and earlier preparation archives. [Before](../ARTIFACTS.md#excluded-96679155496dec26) and [after](../ARTIFACTS.md#excluded-800e837e4fbeb0f6). The earlier 14 observability map files and receipts were preserved under `work/five-improvements/map-before` before the new map was written. The earlier videos remain unchanged.

README, ARCHITECTURE, hosted setup, operations, integration guidance and the [five-improvement guide](FIVE-IMPROVEMENTS.md) describe the completed scope. Preparation scripts now include their new local module dependencies; existing archives were not regenerated.

The final documentation audit checked 14 Markdown files and 230 local file links with zero missing targets. Its receipt is `work/five-improvements/docs-check.json`; external URLs and fragment anchors were outside that audit. Package tests now import the copied provider and repository modules from their temporary generated packs, checking that their local dependencies are included.

## Remaining acceptance work

Real model quality, sponsor account permissions, hosted deployment, Supabase authentication and Arize ingestion still require separately authorised account tests. Real customer usefulness requires running the supplied study with participants. Those activities were outside this offline build. Keys alone cannot enable an application provider, and no inspection, trace, report or replay can approve a refund.
