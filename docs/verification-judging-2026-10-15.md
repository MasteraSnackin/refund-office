# Judging improvements: verification, 15 October 2026

The six supplied judging weights total 100%: output 20%, agent design and architecture 15%, business viability 20%, demo and pitch 15%, demo clarity 15%, responsible design 15%. The implementation and pitch were checked against that rubric without assigning a predicted score.

## Delivered

- A read-only **Demo brief** for the selected saved case, alongside Judge mode. It presents the customer problem, exact saved output, citations and checks, recorded analyser provenance, authority boundaries, proof navigation and unmeasured business hypothesis.
- An explicitly selected bounded Claude tool investigator using `read_order`, `read_evidence` and `submit_recommendation`. These operate on an immutable snapshot. Existing proposal validation and deterministic policy checks remain outside model authority.
- A separate three-case proof runner with its own synthetic SQLite database, saved packet and readable brief, source hashes, bounded execution receipts and independent persisted readback. It cannot approve, reserve, submit a payment or modify an existing rehearsal.
- A [five-minute judging plan](JUDGING-PLAN.md), [Claude setup and proof guide](CLAUDE-RUN-PROOF.md), and updated README, architecture text and project instructions.

## Final local checks

| Check | Result and scope |
| --- | --- |
| Final production build | Passed. Vite produced the application and the existing Sites build files. This does not establish deployment. |
| Complete application suite after the final UI change | 813 passed, zero failed, skipped or cancelled. |
| Investigator and existing model-path checks | Controlled responses exercise read tools, correct values, citation validation, conflicts, wrong amounts, injected payment/source tools, duplicate tool IDs, incomplete responses, HTTP failures, deadlines, usage limits, receipts and offline refusal. |
| Isolated runner integration | Controlled responses produced £20 awaiting approval, £25.01 held by policy and an ambiguous claim held. Cases survived a close/reopen readback. No new approvals, operations or payment attempts occurred. These tests do not constitute a real Claude run. |
| Demo brief interactions | Snapshot changes, scope switches, stale callbacks, explicit reload, focus return, read-only navigation and guarded report downloads are covered. |
| Protected original files | All 71 original data, media and archive hashes still match the retained baseline. |

Evidence: [final build log](../ARTIFACTS.md#excluded-ed173fc4ecf82a4b), [complete test log](../ARTIFACTS.md#excluded-a4a2e20d004b3ab4) and [preservation check](../ARTIFACTS.md#excluded-6e2777de0c93b78a).

An earlier full run found a missing dependency in the migration preparation allowlist. The new module was added to the source list, and the final suite passed. Existing migration packs and historical release archives were not regenerated or altered. A later deployment must use the current source, rather than assuming an earlier staged copy includes these additions.

Independent review found two reporting issues: a standalone controlled-response brief lacked an explicit transport label, and the HTML counted an authentication failure as a completed case. The standalone brief now carries its controlled/live scope, case, receipt reference and input hash; the page counts observed cases and does not claim a completed real investigation from configuration alone. Regression checks cover the correction.

## Browser observations

The current PostgreSQL rehearsal at `http://localhost:5273/` displayed RF-2001 revision 3. The new brief showed the £20 recommendation, five gathered records, two cited references and seven saved checks passed. It correctly said **Local rules**, awaiting human approval and payment submission disabled. No configured provider was presented as having run.

Expanding the evidence details exposed the actual order and packing citations and saved check explanations. **Saved evidence** opened the existing read-only inspector without approval controls. **Download saved decision brief** produced a 6,329-character Markdown report with the expected case and amount; a copy is retained as [downloaded output](../ARTIFACTS.md#excluded-adc3f8a025c673ce).

RF-2004 revision 3 showed a £25.01 proposal on hold, six of seven saved checks passed and no current approval. A visual check caught that its hold reason was initially hidden in details. The final brief now displays the saved policy-limit explanation prominently. The original RF-2001 selection was restored, and its brief was left open. No investigation, customer contact, review decision, approval or payment action was performed during these browser checks.

The actual screenshots show a 962 × 1030 viewport. Smaller phone-width rendering was not checked in this change. The brief scrolls to its remaining sections; the header and footer stay visible. See the [final recommendation screenshot](../ARTIFACTS.md#excluded-b443516d5c968331) and [policy-hold screenshot](../ARTIFACTS.md#excluded-854ea412ec214203).

## What remains unverified

The user confirmed that a real Claude run is required and authorised up to three short synthetic investigations. They have an API key and chose **Vercel only** for storage and the first real test, after hosted setup is ready. The guide specifies a server-side Secret environment variable. No key was requested in chat, inspected, copied locally or written into project source. The local runner remains controlled-response test coverage, not the selected live route.

No real Anthropic request was made during this work. Actual account access, available model, latency, cost, returned quality and provider acceptance remain unverified. The tool investigator's receipts are bounded request-local memory; durable hosted receipt collection is separate. Vercel/Supabase deployment and authenticated hosted acceptance remain unfinished setup work. Other sponsors, Arize uploads and payment execution remain disconnected.

Customer interviews, willingness to pay and measured time savings also remain absent. The existing business-validation kit is a procedure for collecting that evidence, not evidence that customers have completed it. Neither test counts nor the judging plan guarantee a judging score.
