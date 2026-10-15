# Review workflow verification

Checked locally on 15 October 2026. The authorised scope was an actionable review queue, unsent customer clarification drafts and safe continuation of unrelated investigations after a confirmed case failure. These features are implemented. Sponsor services and Arize uploads remain disconnected, and every new refund still requires explicit approval.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Application build | Passed | `work/review-flow-2026-10-15/build.log` |
| Complete application suite | 670 passed, 0 failed | `work/review-flow-2026-10-15/application-tests-final.log` |
| Independent review | No blocking findings remained | Queue contradictions and accessible labels were corrected; 69 focused tests passed during review |
| Real PostgreSQL workflow | 28 checks passed | `work/review-workflow/run-RCaeVq/manifest.json` and `verification.json` |
| Exercised database source | Unchanged across the run | 28 tracked files; digest `30ad96d2207ecd808b57ef465783f1e9a7229b223b772dc135705658e22bdce4` |
| Protected files | All 71 checks unchanged | `work/review-flow-2026-10-15/preservation-final.json` |
| Fresh preview after resumption | Twelve cases; six awaiting approval, five held, one historical remedy | `work/review-flow-2026-10-15/resumed-preview.json` |

The first complete test run exposed a privacy assertion that matched an identifier prefix inside a timestamp. The corrected test inspects recorded names and attributes against exact sensitive fixture values. It still rejects customer text, internal identities, request/order/evidence identifiers and the diagnostic private marker. Only the test changed; the final full suite above passed after that correction.

## Review queue

The inbox now separates decision-ready cases, evidence waits, investigation recovery and other holds. Rows use saved reasons and next steps for the current role. The next-case control follows saved order and selects a case; it cannot approve or recover one.

Tests cover state transitions, role changes, malformed or conflicting proposals, missing operations, historical remedies, search, counts and accessible labels. An approved-looking record without its operation remains an inspection hold. A financial result awaiting confirmation is not classified as investigation recovery. The original manually driven SQLite investigation must be explicitly paused before switching through this queue; navigation does not pause it automatically.

The browser check showed six decision-ready cases and five other holds in the fresh pack and verified filtering and case selection. The [saved queue screenshot](../ARTIFACTS.md#excluded-8081081cdcc7eb61) records that check.

## Unsent customer question

The builder and authenticated GET routes read the current saved packet. They verify matching order, packing, delivery and remedy records and bind the result to the case, revision and consulted evidence digest. Policy, delivery, duplicate, contradiction and malformed-source holds return an unavailable reason. The customer wording contains no refund promise, internal review note, actor identity or source URL.

In the browser, the RF-2008 question named the saved sketchbook and marker set and asked which items and quantities had not arrived. Downloading produced a text file labelled as an unsent draft with its saved revision. Its actual bytes were checked. Copying displayed the application's success message, but the browser automation clipboard reader returned an empty string, so system clipboard contents were not independently verified. Interaction tests verify the exact text passed to the clipboard API and failure handling; this limitation does not affect the checked download.

The [customer-draft screenshot](../ARTIFACTS.md#excluded-44c2a16a1bf28f61) records the prepared question. The [example unsent question](demo/unsent-customer-question-2026-10-15.txt) was generated from a fresh saved case after resumption. Reading that draft left all twelve cases unchanged.

Tests also cover revision and workspace changes, stale handlers and replies, source mismatches, unavailable templates, clipboard refusal and revalidation before copy/download. A customer's answer still requires a separately recorded clarification. No sending route, message delivery or provider call was added. A future configured hosted request uses Supabase authentication and database reads; the draft adds no model or messaging-provider request.

## Confirmed failure recovery

The real database test deliberately rejected one proposal in a new disposable synthetic tenant. It confirmed the saved error, case, worker fence and failure event through an independent read. The automatic worker then completed the other eleven cases. Restarting did not retry the failed case or modify saved decisions.

The observed queue contained five decision-ready cases, one investigation-recovery case and five other holds. Both roles could read the same unsent RF-2008 question without changing its case or report. Recording an evidence request made that draft revision stale. A fictional clarification then produced a £10 recommendation awaiting approval; the current case no longer qualified for an item question. The other eleven cases were unchanged.

There were 55 recorded local spans. The failed investigation remained an error, with separate actual hold and confirmation operations. The evaluated tenant created zero approvals, new operations or payment executions and made zero external requests. The underlying schema harness separately uses approval/reservation fixtures in unrelated disposable tenants; those fixtures are outside the evaluated office cases. The owned network-isolated database was removed after the checks.

Unit tests verify that unknown writes, failed readback, access errors, ownership conflicts and recorder failures cannot authorise continuation. Manual investigation preserves its original error. Failed cases require explicit investigator recovery and are not automatically retried.

## Current files and preview

The [workflow guide](REVIEW-WORKFLOW.md), [README](../README.md), [architecture](../ARCHITECTURE.md), [operating guide](OPERATIONS.md) and [hosted setup](HOSTED-SETUP.md) describe the new behaviour and limits.

The interruption ended the earlier preview process without a clean shutdown checkpoint. Its saved run and volume were preserved for deliberate recovery rather than bypassing the owner marker. After restoring the installed local Docker runtime, a fresh copy of the same pack was started on ports 5273/5274. The running preview is a local synthetic rehearsal with payment submission disabled. Earlier source archives, videos and reports retain their original version scope and were not relabelled or overwritten.

This verification establishes the exercised local workflow and controlled hosted contracts. It does not establish real model quality, provider acceptance, live customer messaging, deployment or retailer time savings.
