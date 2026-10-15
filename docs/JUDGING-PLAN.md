# Refund Office judging plan

This is the current five-minute plan for the supplied judging rubric. The original [demo guide](hackathon-demo.md) retains its separate SQLite payment simulation and PostgreSQL clarification sequences.

Refund Office prepares a missing-item refund decision for a small online retailer. Its useful output is a saved brief containing the supplied evidence, cited records, exact proposed amount, policy results and review state. A person decides whether to approve it.

All demonstration cases are synthetic. Real Claude investigation has been authorised for at most three short synthetic investigations. Its connection, execution receipts and the private Vercel/Supabase deployment are still unverified. A prepared adapter, a controlled response and a real provider response are different evidence. Update this status only after independent readback of the actual run.

The [Claude run-proof guide](CLAUDE-RUN-PROOF.md) describes the implemented tool mode, private key configuration and isolated three-case runner. The [verification record](verification-judging-2026-10-15.md) separates the local checks from outstanding provider acceptance.

## Rubric, evidence and gaps

The supplied weights total 100%. This is an evidence plan, not a predicted score.

| Criterion | Weight | Evidence to put in front of judges | Gap or limit to state |
| --- | ---: | --- | --- |
| Output | 20% | Open a saved decision brief and its machine-readable packet. Match the case, revision, amount, citations, checks and pending decision to saved records. | Synthetic output is useful for inspection; it does not establish a real customer's outcome or payment. Use a newly verified artifact when presenting new code. |
| Agent design and architecture | 15% | Show one bounded Claude investigator's actual read-tool sequence, proposal and saved result; then the deterministic validation and human handoff. Show durable case history and explicit recovery. | Real Claude receipts are pending. Local rules and controlled responses do not prove model use. There is no demonstrated team of Claude agents, inter-model delegation or long-running Claude process. |
| Business viability | 20% | Name the proposed buyer and the repeated decision. Explain the [interview and comparison kit](business-validation/README.md), including errors and holds as well as time. | No interviews, buying commitment, accepted price, measured savings or unit economics have been established. |
| Demo and pitch | 15% | Tell one case's story: complaint, investigation, supported output, stop for review. Include an ambiguous case and a recovery proof. Finish within five minutes. | Replays are saved history. A failed live connection must be described as a failure and the fallback labelled local. |
| Clarity and presentation | 15% | Keep the amount, evidence, policy result and next human action readable. Use the office to locate stages, the case canvas to inspect provenance and the brief to retain the result. | Motion and extra integrations do not establish capability. Explain each view's purpose before switching. |
| Responsible AI and controls | 15% | Show an evidence hold, a blocked invalid proposal, a pending human decision and a duplicate/recovery readback. Show that the investigator cannot approve or submit a refund. | Synthetic tests establish only their recorded cases and source version. Hosted identity, model behaviour and account acceptance require separate checks. |
| Total | 100% | | |

The two presentation criteria total 30%, but need different proof. The pitch gives the audience a coherent problem and outcome; clarity lets them read and verify that outcome on screen.

## Claims and proof to prepare

| Claim | Minimum proof | Evidence available before the new run |
| --- | --- | --- |
| The workflow produces a usable brief. | Download it and independently read back the same case revision and review state. | [Saved local example](demo/decision-brief-example-2026-10-14.md) and its [verification scope](verification-demo-reliability-2026-10-14.md). The example awaits human approval; it is not a fresh provider result. |
| Claude performed the investigation. | Retain the actual provider/model identity, request ID, token usage when returned, allowed tool calls and results, bounded step count, case revision and saved final status. | Prepared model path and controlled tests described in [five improvements](FIVE-IMPROVEMENTS.md). Real provider receipts remain pending. Missing metadata must say unavailable. |
| Amounts and authority remain constrained. | Read back a rejected wrong-amount or unsupported-citation proposal and confirm no approval or new payment operation. | [Proposal validation](../server/investigation-proposal.mjs), [review workflow](REVIEW-WORKFLOW.md) and their linked local verification records. Recheck the settled new code. |
| Recovery preserves the case and prevents duplicates. | Repeat the same intake identity and compare case/operation IDs; show a saved investigation failure, explicit recovery and the resulting history. | [Recovery contract](REVIEW-WORKFLOW.md#continue-after-a-safely-recorded-case-failure). Controlled failures must remain labelled controlled. |
| The current model handles customer language. | Independently inspect real responses on the selected synthetic cases, including a hold. | Language fixtures and injected responses test the contract only. Three short runs cannot establish general accuracy. |
| A retailer would use or buy it. | Interview notes, observed comparison results and a recorded buying step. | [Pitch evidence worksheet](business-validation/pitch-evidence.md) is blank; no customer validation result exists. |

Do not display hidden chain of thought. Display the actual tools used, their saved results, the supported conclusion and the recorded handoff. Persisted case evidence and history are workflow memory; they are not evidence of a model learning across customers. Desk labels describe responsibilities, not a team of running Claude agents.

## Five-minute demonstration

Use one fresh synthetic workspace and one known source version. Keep payment execution disabled. Rehearse the route and prepare the saved records before presenting. If a live model run cannot be verified, use the local route, say so and leave the Claude criterion gap visible.

| Time | Show | Say and establish |
| --- | --- | --- |
| 0:00-0:35 | The office, one missing-item case and its synthetic/provider labels. | "We are testing whether preparing the evidence helps a small retailer review a missing-item refund. The person keeps the decision." State whether this run is local or an actual Claude response. |
| 0:35-1:25 | Start or open the verified investigation. Show its actual allowed tools and saved events. | Explain that Claude may inspect supplied case records and propose an outcome within a step bound. The service checks the proposal. Mention the actual request receipt only if it exists. |
| 1:25-2:15 | Open the supported recommendation, cited evidence and saved brief. | Point to the exact amount and current case revision. Download the brief/packet and show that the case is awaiting human approval. No payment is submitted in this route. |
| 2:15-2:55 | Open an ambiguous or conflicting case. | Show the recorded reason for the hold and what evidence a reviewer needs next. A hold is a useful output when the facts do not support a refund. |
| 2:55-3:35 | Open the recovery proof and compare saved IDs/history. | Show an intake replay returning the same case, or a recorded failed investigation followed by explicit recovery. State whether failure injection was controlled. An uncertain financial result must be inspected through its existing operation; it cannot justify another submission. |
| 3:35-4:15 | Show the architecture or case canvas, then return to the pending decision. | Identify the real handoffs: investigator, deterministic checks, human. Explain persistent records, role boundaries and recovery. Each stage must map to a recorded operation or saved state. |
| 4:15-5:00 | Show the brief beside the business-validation plan. | State the customer hypothesis, the measurement plan and the present limits. Finish with the proposed next evidence: observed retailer review work without more incorrect decisions. |

The committed [facilitator key](business-validation/facilitator-answer-key.csv) provides rehearsal candidates: `RF-2001` expects a £20 recommendation awaiting approval, and `RF-2008` expects an ambiguity hold before clarification. These are synthetic expected outcomes, not claims about a new model run. Use the actual observed outcome in the demonstration, including any failure. The original SQLite simulator's approval and receipt belong to its separate sequence.

## Spoken pitch to rehearse with the demonstration

"A missing-item refund asks a support person to compare a complaint, an order, a packing record and the retailer's policy. Refund Office prepares those records and saves a decision brief with a supported amount. Our proposed customer is a small online retailer whose staff do this repeatedly. We have not yet measured how common or costly that work is for them.

"This case is synthetic. The label here tells you whether its investigation used local rules or a verified Claude response. In the Claude path, one investigator can read the supplied case records through bounded tools and propose an outcome. You can inspect the actual tool events and saved result. The service independently checks the evidence references, catalogue amount and policy before the proposal reaches review.

"Here is the output a reviewer can keep. It identifies the case and revision, distinguishes gathered evidence from the records cited by the proposal, and shows the exact amount and current decision state. This case is waiting for a person. The investigator has no approval or payment authority.

"This second case does not identify a supported item clearly enough. It stops with a recorded hold. The reviewer can request evidence; recording a received clarification creates a new investigation and requires a fresh decision. The original complaint and records remain visible.

"Recovery also has a record. A repeated intake event returns its existing case. A failed investigation stays stopped until an authorised person explicitly recovers eligible work. We label controlled failure tests and saved replay separately from a new provider run. An unknown payment result requires inspection of the existing operation before any further action.

"The office makes the stages visible, and the case canvas lets the reviewer follow the records behind the recommendation. There is one investigator, deterministic checks and a human handoff. Saved events are the evidence for those stages.

"The business question is whether this preparation reduces review work without increasing mistakes. We have an interview guide and a balanced manual-versus-assisted exercise ready. We will record active review time, corrections, holds and unfinished tasks, then investigate buying responsibility and willingness to trial. We have no customer results or savings claim yet. This demonstration establishes an inspectable synthetic workflow; real customer value and broader model quality remain to be tested."

Replace the provider sentence with the verified run's exact status. Do not read a statement about actual Claude tools unless the retained record supports it.

## Questions judges may ask

| Question | Answer supported by the present evidence |
| --- | --- |
| "Did Claude actually do this, and where is the agent team?" | "Real Claude execution is still pending verification. We will show its actual request and tool receipts when available. The design uses one investigator with deterministic checks and a human handoff. We do not claim a team of Claude agents or long-running model work." After verification, replace only the first sentence with the measured run facts. |
| "Why use an agent when rules already check the refund?" | "The intended model role is interpreting the complaint and choosing which permitted case records to inspect. Rules retain the exact amount, evidence and approval constraints. The live comparison still needs to show where the model helps beyond the local interpreter." |
| "Who pays, and what benefit have you measured?" | "The buyer hypothesis is a small retailer's owner or support lead. We have not validated the buyer, price or savings. The prepared study compares manual and assisted review, including mistakes and holds. A trial commitment would be recorded separately from revenue." |
| "What happens if the model is wrong or the connection fails?" | "Invalid or contradictory proposals stop for review. A saved investigation failure needs explicit recovery. A repeated intake event keeps its identity. No agent can approve a refund, and the judging route keeps payment execution disabled. The local tests cover specific fixtures; real provider and hosted acceptance must be shown separately." |

## Activation and evidence order

1. Complete local checks of the bounded read tools, proposal validation, saved failure/recovery and read-only demo brief against settled code. Preserve existing rehearsals and historical receipts.
2. Add `ANTHROPIC_API_KEY` through Vercel's server-side secret environment-variable settings. Do not upload a local `.env` file or put the key in the browser, docs, traces or reports. Explicitly select Anthropic and its model using the application's independent network/integration gates. Keep payments, other sponsor actions and Arize uploads disabled.
3. Verify private sign-in, membership restrictions, API routing and persistence in a fresh synthetic workspace. Configuration alone does not confirm deployment acceptance.
4. Run no more than the three authorised short synthetic investigations. Keep the cases and budget bounded; do not spend extra calls to manufacture a demonstration. Independently read back the saved result and retained provider metadata. Do not silently fall back to another provider.
5. Attach the verified source version, run evidence and final status here before claiming a completed Claude demonstration. Keep local/controlled/live scopes visible. If a connection remains blocked, state the blocker and present the prepared local evidence with its gap.

Prioritise these proofs over sponsor breadth. An integration belongs in the pitch when its actual use helps explain the demonstrated outcome and has its own receipt. Prepared exports and disconnected adapters remain preparation.
