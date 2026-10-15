# Review queue, customer questions and investigation recovery

The PostgreSQL office prepares work for a person to decide. These additions make that handoff easier to use while preserving exact refund approval. The ordinary rehearsal uses local rules and keeps sponsor services disconnected.

## Find the work for your role

Open **All cases** or the workload count in the case footer. The review queue keeps the existing search and broad status filters and adds four work groups:

| Group | What it means | Next step |
| --- | --- | --- |
| Ready for decision | A supported exact proposal is waiting for approval and its saved checks passed. | A reviewer inspects the amount, evidence and policy before recording a decision. |
| Waiting for evidence | A saved review decision requested evidence. | Obtain the requested statement or record it through the existing clarification procedure. An investigator cannot reopen the hold. |
| Investigation recovery | An eligible investigation stopped without an approval or payment operation. | An investigator inspects the failure and gives an explicit reason before recovering it. |
| Other holds | Policy, evidence, unsupported requests or contradictory records need inspection. | Inspect the saved reason. Missing or inconsistent information does not become permission to act. |

Each row gives the saved reason and a next step for the signed-in role. **Next case for my role** follows saved case order and wraps once; it does not invent an urgency score. Opening a case cannot approve it or start its recovery. Financial results awaiting confirmation remain distinct from investigation recovery, and a claimed reservation without its saved operation is an inspection hold.

The original SQLite simulator also has the queue. If its manually driven investigation is still running, pause it before choosing a different case from this queue. The queue will not pause it as a side effect of navigation. The existing case tray retains its original switching behaviour.

## Prepare an unsent customer question

Select a held case such as **RF-2008**, where the original request does not identify which missing item is being claimed. In **Prepare a customer question**, choose **Prepare question**. The local template checks the saved order, packing, delivery and remedy records and asks the customer to identify the item or items and missing quantity.

The result names only items present in those saved records. It does not copy internal review notes, actor identities or source URLs into the customer text, and it makes no refund promise. Holds involving a delivery dispute, a conflicting statement, a policy issue, an earlier remedy or malformed evidence return an unavailable reason instead of a speculative reply. A completed, approved or reserved case is outside this template's scope.

The screen shows the case, saved revision and evidence references used. **Copy question** copies the customer wording. **Download unsent draft** creates an internal text artifact containing the wording, case revision and source references. Review and edit the copied wording in your support tool before sending it yourself. This application provides no send action and records no message delivery.

Both reviewer and investigator profiles can inspect a question. Copying and downloading first read the saved case again and require the same revision, wording and source binding. Changing case, session, run, role or revision clears the old result. A failed or different read blocks its reuse; a clipboard error still allows a verified draft to be selected or downloaded.

A customer's answer remains a separate event. Follow the [clarification procedure](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal) to request evidence, record the statement after it has been received, investigate again and return to a fresh human decision. The question itself is not supporting evidence or a refund approval.

## Continue after a safely recorded case failure

An automatic investigation can continue to unrelated requests after a bounded proposal validation or refusal error only when it has saved the failed case's hold and independently confirmed it. The confirmation checks the exact case, request, worker fence, revision, error and failure event, preserves the evidence, and confirms the absence of an approval or payment operation.

The failed case remains stopped. The worker does not retry or requeue it automatically, including after a restart. An investigator must inspect it and explicitly recover eligible work. Queue rows and case history retain the failure even after later cases complete successfully.

Unknown database writes, failed confirmation, access errors, ownership conflicts and other failures still stop the worker. A manually requested investigation retains its original error response. The worker's `failed` count and `lastFailure` describe attempts in the current process; they are not a lifetime total or payment permission. Traces record the actual failure, hold and confirmation operations. Recorder failure cannot replace the business result or authorise continuation.

## Verify locally

The repeatable real-database check is:

```sh
node scripts/test-review-workflow.mjs
```

It uses a new network-isolated local PostgreSQL database and synthetic tenant. It deliberately fails one proposal, confirms the hold, checks the other cases and restart behaviour, reads an unsent question from both roles, records a fictional clarification and stops at a fresh recommendation. It never approves or creates a new payment operation in that evaluated tenant. The underlying database harness separately tests approval fixtures in other disposable tenants.

See the [verification record](verification-review-workflow-2026-10-15.md) for the final test results, browser checks and artifact scope. Customer time savings and model quality still need separate real-world measurement.
