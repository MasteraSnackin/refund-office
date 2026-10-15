# Demonstration scenarios

Use **focused-12** for a short presentation. Use **busy-50** when the audience needs to see queued work at a larger scale. Both show actual local engine transitions, saved evidence and recorded human decisions. Their orders and historical receipts are fictional.

## Three-minute demonstration

| Time | Show | Point to make |
| --- | --- | --- |
| 0:00 to 0:25 | The synthetic pack label, local mode and Intake queue. Let the saved requests advance. | The service investigates while the reviewer looks elsewhere. Queue activity comes from real saved transitions. |
| 0:25 to 1:15 | **RF-2001**, its packing evidence, policy checks and exact £20 proposal. Enter a review reason and approve it. Then inspect the local receipt and history. | Investigation prepares a decision. The human authorises the exact refund; the simulator records it afterwards. |
| 1:15 to 1:55 | **RF-2004**, the supported £25.01 omission above the £25 policy. Briefly compare **RF-2005**, whose delivery evidence is disputed. | Evidence and policy can each stop an action. Human approval does not override the policy limit. |
| 1:55 to 2:25 | **RF-2009**, labelled historical local remedy. | The same issue is already covered, so no additional refund is created. This history was seeded for the demonstration. |
| 2:25 to 3:00 | Open **Brief me**, download the decision brief and inspect Office connections. | The useful output is an inspectable case and audit record. Sponsor code is prepared, with external services still disconnected. |

If the queue has already finished, say that investigation is complete and show the saved history. Do not present a completed case as live processing. Keep the policy at £25 for this script; changing it changes the expected boundary-case result. A fresh isolated rehearsal starts with the expected counts below.

## Focused cases

| Case | Scenario | Proposed amount after investigation | Expected initial result |
| --- | --- | ---: | --- |
| RF-2001 | Travel mug omitted | £20.00 | Wait for human approval |
| RF-2002 | Three pencil packs ordered, one packed | £15.00 for two missing units | Wait for human approval |
| RF-2003 | Drawing board exactly at the policy limit | £25.00 | Wait for human approval |
| RF-2004 | Desk lamp one penny above the limit | £25.01 | Held by policy |
| RF-2005 | Courier says delivered; request disputes receipt | No supported amount | Held for delivery evidence |
| RF-2006 | Cable pouch claimed missing, packing says included | No supported amount | Held for conflicting evidence |
| RF-2007 | Desk organiser damage claim | No supported amount | Held; missing-item rules do not assess damage |
| RF-2008 | Two different omitted lines, generic complaint | No supported amount | Held; the request does not identify one line |
| RF-2009 | Travel pouch has a historical local remedy | £12.00 original item value | Already resolved; £0 additional refund |
| RF-2010 | Original desk mat request | £18.00 | Wait for human approval |
| RF-2011 | Follow-up about the same desk mat and order | £18.00 | Wait for human approval until the original is acted on |
| RF-2012 | Pen set omitted | £8.50 | Wait for human approval |

RF-2010 and RF-2011 deliberately share one order. Before approval, neither has created a refund operation, so both can initially reach the approval queue. A matching claim is not by itself proof that a refund has already been made.

## Optional repeat-claim demonstration

1. Investigate **RF-2010** and **RF-2011**. Both should wait for approval.
2. Inspect and explicitly approve **RF-2010** for £18. Allow its local simulated payment to complete.
3. Open the history of **RF-2011** and choose **Investigate again**.
4. The follow-up should become **Already resolved**, reference the original receipt and create no additional operation or refund.

This is a conditional follow-up, not the expected initial result in the CSV. The test suite checks that the pair has exactly one local refund operation after this sequence. If a case is changed or a different order is used, do not assume the same outcome.

## Busy office

The 50-case pack has four complete groups following the same 12-case pattern, plus one extra single-item omission and one extra two-unit omission. Prices vary within policy for the routine cases. Exact-limit cases remain £25 and over-limit cases remain £25.01.

| Group | Case labels | Historical case | Duplicate original and follow-up |
| --- | --- | --- | --- |
| 1 | RF-2101 to RF-2112 | RF-2109 | RF-2110 and RF-2111 |
| 2 | RF-2113 to RF-2124 | RF-2121 | RF-2122 and RF-2123 |
| 3 | RF-2125 to RF-2136 | RF-2133 | RF-2134 and RF-2135 |
| 4 | RF-2137 to RF-2148 | RF-2145 | RF-2146 and RF-2147 |
| Extra routine cases | RF-2149 and RF-2150 | None | None |

Before any new approval, the expected total is **26 awaiting approval, 20 held and 4 already resolved from historical fixtures**. There are 46 orders because each follow-up shares its original order. The queue is serial and bounded; 50 cases are a visible backlog, not 50 independent model agents.

The [CSV](expected-outcomes.csv) contains every exact price and case reference. Historical fixtures remain distinct from new simulated refunds in the application totals. No seed contains a human approval or a live Stripe receipt.
