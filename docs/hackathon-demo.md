# Refund Office: demonstration and judging evidence

Use the [current judging plan](JUDGING-PLAN.md) for the supplied 100% rubric, five-minute demonstration and spoken pitch. It records the authorised real Claude run as pending verification and keeps local, controlled and provider evidence distinct. The sequences below retain their original SQLite and PostgreSQL scopes.

## Customer and problem

The proposed customer is a small online retailer whose support staff repeatedly compare refund requests with order and packing records. The product hypothesis is that preparing an evidence-linked recommendation saves review time while keeping the exact refund under human control. Customer demand, willingness to pay and time savings have not yet been measured.

The current demo covers one narrow problem: a missing item in a supplied synthetic order. It is not a general customer-support or fraud-detection system.

## Three-minute demonstration of the original SQLite path

Use a separate practice database so repeated demonstrations do not change existing cases. Start with the local analyser, local payment simulator and no external connections.

| Time | Action | Evidence the audience can inspect |
| --- | --- | --- |
| 0:00–0:20 | State the customer problem and show the office. | The local/synthetic labels and approval requirement are visible. |
| 0:20–0:50 | Open Intake queue, choose a supplied order with a missing item and submit the sample request. | A saved request creates a real local case. The worker progresses without browser-driven investigation. |
| 0:50–1:20 | Open the case, inspect Evidence and History, then Brief me. | Saved evidence references, policy results and actual stage events support the recommendation. The briefing is text because ElevenLabs is disconnected. |
| 1:20–1:45 | Show the case waiting at Review. | No new payment operation exists before human approval. The exact item, amount and evidence can be inspected. |
| 1:45–2:10 | In this synthetic practice case, enter a review reason and explicitly approve the displayed refund. | The service saves the decision, then creates one simulated refund and records its receipt. No real money moves. |
| 2:10–2:35 | Download the decision brief and decision packet. | Usable Markdown and JSON contain the evidence, checks, decision, result and execution history. |
| 2:35–3:00 | Show the saved intake request and Office connections. | Delivery retries retain the same case; sponsor features are labelled prepared and disconnected. |

Use an unrefunded practice order for the approval path. A second claim against an already remedied order should show the existing result and create no additional refund. That is expected behaviour, not a broken demo.

## Separate customer clarification demonstration

The new local PostgreSQL rehearsal on 4473/4474 is implemented and checked offline. It uses its own volume and leaves the earlier rehearsals and decisions intact. It runs local rules with every external service disconnected. Follow the [local clarification guide](LOCAL-POSTGRES-OFFICE.md#customer-clarification-rehearsal); the [verification record](verification-evidence-loop-2026-10-14.md) records the completed checks and their limits.

Start with the synthetic case `RF-2008`. Its original complaint does not name the missing item. Inspect the hold, record an evidence request as the reviewer, then demonstrate a received statement using explicitly fictional text such as: “The sketchbook was missing from the parcel; the other items arrived.” Select the existing sketchbook line, supply a clearly fictional source reference and explain why the clarification is being recorded.

Show that the original complaint and packing records remain visible alongside the appended statement. Saving clears the old recommendation and queues another local investigation. If the recorded facts support it, the new recommendation is £10 for the sketchbook and stops awaiting approval. End this demonstration at that fresh decision; recording the clarification does not authorise a refund. Packing conflicts, delivery disputes and failed policy checks still hold a case.

No customer was contacted and no source was fetched. This sequence does not submit or simulate a payment. The three-minute SQLite sequence above remains the separate demonstration of a simulated receipt after explicit approval.

### Repeat the clarification demonstration

A reviewer-only **Reset demo** control is implemented and checked offline for the supervised 4473/4474 rehearsal. It makes a fresh copy of the current synthetic pack while retaining the previous run and decisions in their existing volume. Review the confirmation, select **Save run and reset demo**, then choose a local profile when the fresh run is confirmed. Earlier decisions are not copied into that run. The [reset procedure](LOCAL-POSTGRES-OFFICE.md#start-a-fresh-copy-of-the-current-pack) describes recovery from a lost response; the [verification record](verification-demo-reset-2026-10-14.md) records the completed offline checks. This control is separate from the original SQLite simulated-payment demonstration.

The fresh copy still contains the pack's labelled synthetic historical fixtures. They are part of the supplied example, not a new approval or payment caused by reset.

## Inspect the prepared provenance map

In the PostgreSQL demonstration, open the Miro card and choose **Inspect prepared map**. Follow the original complaint and saved sources through the investigation, recommendation, policy checks and human decision to the output destinations. After the fictional clarification, the source card retains its source reference, recorded reviewer and time. The fresh human decision remains pending until it is actually saved; an earlier evidence request remains history.

Use **Download prepared map** to retain the custom JSON for the displayed revision. Explain that arrows show relationships between records, not live agents or hidden model reasoning. Record links open the current authenticated application records, not permanent snapshots; the report's availability does not establish that it was sent. This demonstration does not publish a board or verify direct Miro import. The [provenance verification](verification-miro-provenance-2026-10-14.md) records the completed offline checks and browser inspection.

## What each criterion can establish

| Criterion | What this build can show | What remains unproven |
| --- | --- | --- |
| Real output | Persistent investigations, a reviewer-ready decision brief, machine-readable decision packet and a local simulated receipt after approval. | Real payment movement or live external provider results. |
| Agent design and architecture | Explicit intake, investigation, policy, human review and payment boundaries; durable intake identity, safe retries and recorded recovery. | Live model planning or inter-model delegation. The offline analyser is deterministic. |
| Business viability | A specific retailer workflow and an inspectable result a reviewer can act on. | Customer interviews, pricing acceptance and measured operational benefit. |
| Demo and pitch | Saved event history and a repeatable live workflow with visible holds and outcomes. | An older recording does not prove that newly added integrations executed. |

## Recovery and duplicate-delivery demonstration

The intake event identity belongs to the submitted order and complaint. Replaying the same event with the same contents must return the same case. Reusing that identity with changed contents must be rejected. A process restart must retain the request and recover only its own eligible investigation. A manual pause must remain paused until explicitly resumed.

These checks belong in the isolated acceptance suite. During a live pitch, use the saved verification record or a separately recorded run rather than changing the audience's active case to manufacture an error.

## Proposed pitch

Refund Office prepares missing-item refund decisions for small online retailers. It gathers the supplied evidence, proposes an exact amount and checks policy, then waits for a person to decide. The result is a saved decision brief with supporting records and a traceable payment outcome. This demonstration runs locally with synthetic orders and simulated payments; the external integrations are prepared and remain disconnected.

## Next evidence to collect

- Ask support staff to review several anonymised historical missing-item cases and identify which evidence they need before deciding.
- Compare review time, correction rate and missing-evidence rate with their existing process. Measure results before claiming savings.
- When provider access is authorised, test each external connection separately and retain a provider-specific verification record. Preserve human approval and duplicate prevention throughout.
