# Refund Office design QA

## Current: human approval for every refund, 12 October 2026

Every new refund now stops at Review before an operation is reserved. This section supersedes earlier descriptions of automatic successful refunds or missing approval controls. The selected dark office, subtle staff activity and existing case-management features remain.

### Implemented behaviour

- A supported proposal shows **Awaiting approval** at the Review desk and **Review £X refund** in the header. The approval form shows the exact order, item, amount, policy version and payment mode, with links to the evidence and policy checks.
- Approval requires an explicit action and a reason of 10–1,000 characters. The server binds it to the case, amount, complaint, evidence, proposal, order, policy and provider. Changed facts invalidate it. Passing the refund policy limit never replaces approval, and approval cannot override failed checks.
- The approval reason survives visits to Evidence and Policy and a rejected stale request. The history and exported packet retain the approved amount, local reviewer, reason and timestamp alongside the operation.
- Evidence requests and closure without a refund remain available as alternatives. Previous receipts remain historical; no retrospective approvals are fabricated. Legacy uncertain operations cannot trigger an unauthorised new submission.
- Added synthetic order DEMO-108, a £54 order with a missing £18 desk mat, for a fresh approval demonstration. It is available through New case and is not an additional seeded case.

### Fresh verification

- **81 tests passed, zero failures**, including 52 backend, Review and approval tests. Production build passed. Logs: `work/human-approval/tests.log` and `work/human-approval/build.log`.
- Used a separate database for browser execution tests. A supported £20 claim reached Awaiting approval with no operation; a direct advance attempt was rejected. A policy change invalidated the old request without submitting a payment. Reinvestigation produced a fresh request; explicit approval then produced one local £20 receipt.
- Inspected the saved approval event in History and downloaded its decision packet using the browser link. Parsed the downloaded JSON and confirmed that case and operation approval records match and that their amount matches the receipt. Evidence: `work/human-approval/qa-approved-packet.json`.
- Visually inspected the approval screen at 1488 × 1059 and 390 × 844. The phone screen exposes the exact amount, evidence links, reason field and approval button. Review alternatives expand within the scrolling dialog; document width remains 390px. This is a scoped visual and interaction check, not a full accessibility audit.
- Restored the original database and independently compared all four pre-existing cases and all three payment operations with the before snapshot: unchanged. The existing £25 policy, version 3, and local connection modes remain unchanged.
- Created RF-108 through the browser for DEMO-108 and investigated it to **£18 Awaiting approval**. Reloaded the page and confirmed the state persists. It has no operation or receipt and is left for the user to decide. Five cases now exist; the three original operations and £32 non-seeded simulated total are unchanged.
- Final browser warning/error read returned an empty list. An independent focused source review found no remaining concrete P0–P2 finding in the approval boundary.
- Consolidated verification: `work/human-approval/verification.json`. Final pending decision packet: `work/human-approval/final-pending-packet.json`.

### Screenshots and scope

- `work/human-approval/final-office.png`: office stopped at the user's approval step.
- `work/human-approval/final-approval.png`: final RF-108 approval form, with the reason left empty.
- `work/human-approval/qa-mobile-approval.png` and `qa-mobile-alternatives.png`: isolated phone checks.

The analyser and payments remain local simulations using synthetic records. No real money moved, no external provider was enabled and no deployment occurred. Local reviewer identifies the operator of this single-user demo; it is not an authenticated account. No background batch processing was added.

## Previous: recorded Review decisions and case inbox, 12 October 2026

This historical section records the earlier case-management improvements. It superseded statements that Review only explained an outcome; the current approval behaviour is documented above.

### Implemented improvements

- Review now records an internal evidence request, closure without a refund, or explicit reopening. Each action needs a reason; the latest decision is shown in Review and all previous decisions remain in History and the exported packet. No action sends a message, receives evidence or overrides payment policy.
- The case inbox supports request/order/case search, All/Needs attention/Open/Resolved filters, counts and deduplicated successful receipt totals. Seeded historical remedies are excluded from the totals.
- Completed cases offer Next case; held cases offer Review case; closed cases offer Reopen review. Investigate again remains in History. The office footer opens the attention queue and shows the current workload.
- Closed cases show a neutral Reviewed step, skipped payment and archived history. Review warnings identify the reason clearly. The selected dark office, staff and motion controls are preserved.

### Fresh verification

- **62 tests passed, zero failures**, including 14 Review tests and five inbox helper tests. Production build passed. Logs: `work/test-case-management.log`, `work/build-case-management.log`.
- Browser RF-105 path: recorded missing delivery evidence, closed without a refund, reloaded to confirm persisted closure, explicitly reopened with a reason, then recorded the evidence request again. Final RF-105 state is Awaiting evidence. Verification actions are labelled Demo review in its retained history.
- Simulated a second reviewer updating the same case while the browser held a draft. The stale save was rejected, current state refreshed, and both the draft and error survived. An explicit second save succeeded.
- Browser search for pencil returned only RF-107; an unmatched search showed a useful empty state. Needs attention returned only RF-105. Next case on completed RF-107 selected ready RF-106 without starting it.
- Downloaded RF-105's decision packet using the browser link. Parsed the downloaded file, confirmed its latest review matches SQLite, and found both closure and reopening history. RF-105 has no payment operation or receipt.
- Read back the running API and SQLite independently: four cases; one needs attention; one open; two resolved; two unique local receipts totalling £32. Existing operations remain exactly three including DEMO-106's separate seeded history. No new payment was created by Review. Evidence: `work/case-management-verification.json`.
- Visually inspected desktop at 1488 × 1059 and phone at 390 × 844. Desktop Review displays the choices, reason field and save control together. Mobile Review scrolls within its dialog with the save button reachable; document width remains 390px. The inbox filters and attention view fit. This is a scoped visual/interaction check, not a full accessibility audit.
- Two retained Vite hot-reload errors occurred while files were being created at 14:52 UTC. No later warning/error appeared in the final browser log read after full reload; the production build passed.
- Independent source review found no remaining concrete P1/P2 issue after fixes for cross-case payment guards, stale drafts, historical review-note wording and closed-case progress. Review rejects closure or evidence-request decisions when a related payment operation exists, including one created by another case.

### Screenshots and scope

- `work/case-management/01-office-before.png`, `02-cases-before.png`, `03-review-before.png`: original screens inspected before changes.
- `work/case-management/06-review-final.png`: final desktop Review form.
- `work/case-management/07-inbox-final.png`: desktop inbox.
- `work/case-management/08-mobile-inbox.png`, `09-mobile-review.png`: final phone views.
- `work/case-management/10-office-final.png`: final saved Awaiting evidence office.

Local reviewer is a single-user demo label, not an authenticated identity. Evidence intake, external messaging and payment approval are not implemented. OpenAI and Stripe remain unconfigured as requested. No deployment or real financial transaction was performed.

## Previous: durable local investigation workflow, 12 October 2026

This section supersedes earlier claims below about scripted outcomes, page-only state and reset controls. The historical sections remain as records of earlier versions.

Current result: passed for the local API-driven demo. The running modes are **local analyser** and **local payment simulation**. OpenAI and Stripe sandbox adapters are implemented and tested with controlled responses, but no external model response or Stripe test operation has been verified.

### Current browser checks

- At 1488 × 1059, preserved the selected dark office, desk locations, staff, case tray, bottom summary and progress line. Added a compact control strip for New case, refund limit, All cases and connections. Final screenshot: `work/connected-office-final.png`.
- Before starting RF-104, all policy checks showed Not checked. Setting the limit to £10 held the supported £20 claim and explained the policy failure. Raising it to £25 and rerunning produced a local £20 receipt.
- Paused RF-104, reloaded, observed the saved Paused status and resumed successfully. Repeating the completed investigation returned Already resolved and £0 additional refund, with the original receipt retained.
- Created RF-107 from typed customer text on DEMO-107. The notebook and pens had arrived; the pencil case was missing. After correcting the local analyser's matching, the browser showed a £12 proposal supported by the order and packing record, then a saved £12 receipt. Evidence screenshot: `work/connected-evidence.png`.
- Reran RF-105 with the final engine: it stopped for delivery review with one concise explanation. Inapplicable financial checks no longer falsely claim an excessive amount or insufficient balance.
- Opened New case while RF-105 ran. The typed draft stayed intact, enabled and focused through the investigation; only submission is gated during another request. The 390 × 844 form fit within the viewport. Screenshots: `work/connected-mobile-form.png`, `work/connected-mobile-review.png`. Document width remained 390px.
- Reloaded the completed RF-107: its £12 receipt persisted, the desk used the restored state, and no old case-handoff element replayed.
- Emulated reduced motion: the app selected Motion off, hid steam and had no handoff element. Cleared emulation and restored motion. Temporary viewport override is reset at handoff.
- Downloaded RF-107's decision packet through its actual browser link. Parsed the downloaded JSON and confirmed the local proposal, succeeded receipt and 1,200-pence amount.
- Independently read the running API and SQLite database after the browser checks. Four cases persisted. Exactly one operation existed for DEMO-104 and one for DEMO-107, plus DEMO-106's distinct seeded historical operation. Record: `work/connected-verification.json`.
- One React development warning arose while hot-reloading an edited effect dependency list. A later full reload had no new warnings or errors; the retained warning predates that reload.

### Checks and fixes

- **43 automated tests passed**, including 20 backend/integration tests and 14 provider tests. The production build passed. Sites packaging remains intact, but does not deploy the new local backend.
- Independent source review found two provider/UI issues: unrelated missing-item words could trigger a local proposal, and uncertain payment results could claim no refund existed. Both were fixed. Further UI review separated confirmed failure from uncertainty and prevented background work from disabling new-case typing.
- An additional review conflict retry prevents a competing in-flight advance from leaving the selected case stalled. The server remains authoritative; browser beats only pace the returned stages.
- Provider pending/failure, model refusal, stale revisions, concurrent duplicates, policy changes after reservation and restart recovery were checked with controlled tests. Those tests do not establish external provider availability.
- Cases, evidence and payment operations now persist in SQLite. Completed operation payloads and retry keys are preserved. No destructive reset endpoint exists. Review explains why action stopped; human approval and evidence collection are not implemented.

## Historical prototype checks

Date: 12 October 2026

Final result: passed for the local interactive prototype scope.

## Additional office animation, 12 October 2026

Current screenshot: `work/desktop-activity-final.png`; phone review state: `work/activity-mobile-final.png`. This section records the latest update.

- Added a fourth seated clerk at Policy, two small steaming cups, occasional paper feed from the illustrated Evidence printer and moving monitor text. Desk-specific effects show intake stamping, evidence scanning, rule reading, receipt preparation, archive filing and review clipping. All additions are decorative and cannot alter decisions or records.
- Compared the previous `work/desktop-tray-final.png` and the final screenshot together at 1488 × 1059, both in Ready state. Layout, type, colours, controls and case tray remain in place. New props fit on the existing furniture; the Policy clerk matches the other staff. No new interface copy or large overlays were introduced.
- Separated genuine stage entrance events from navigation. Restoring a saved case and turning motion off/on cannot replay its previous handoff, printing or completion effects. Pause keeps the current effects mounted.
- Browser paused RF-104 at Evidence. Two separated geometry samples of all six steam trails, printer paper, three screen-text layers, evidence scan and courier were identical. Resume reached the successful demo outcome.
- Browser returned to completed RF-104 after selecting another case: the desk used its restored class and no handoff element existed. Motion off hid steam and left the courier at the same position in two separated samples; motion on did not recreate the old handoff.
- Emulated reduced motion and verified that the app switched motion off, hid steam and removed the handoff. Cleared the emulation and restored motion afterwards.
- RF-105 reached Review needed on a 390 × 844 phone viewport. Screenshot inspection showed the clipped review paper, active station, case tray and controls without overlap. Document and viewport widths were both 390px.
- The brief Payments animation was not captured separately: timed browser observations missed that transient stage. Source review verified its event gating and pause/off handling; browser runs verified the resulting workflow outcome. This does not establish frame-by-frame playback quality for every effect.
- Independent source review found no P0–P2 pause, motion-off, stage-event or restoration issue. Five workflow tests and the final build passed (`work/build-office-activity.log`). Final browser log read returned no errors or warnings.

Final result: passed for the additional interactive office animation. The app remains a scripted local demo; its financial behaviour is unchanged.

## Case tray and saved progress, 12 October 2026

Current final screenshot: `work/desktop-tray-final.png`. Phone screenshot: `work/tray-mobile-final.png`. The sections below this update document earlier versions; this section takes precedence for the initial state and current checks.

The selected office design and its subtle staff activity are preserved. A three-folder tray at Reception now makes case selection and case status visible. Switching cases saves the exact workflow frames, current stage and remaining time; unfinished cases pause. Completed and held cases reopen at their result. Starting and resetting now show Ready to investigate at Reception, with all timeline steps waiting, instead of the earlier Checking policy concept preview.

### Visual comparison

- Displayed the original `work/selected-reference.png` and final `work/desktop-tray-final.png` together at 1488 × 1059. The state differs deliberately: the source is a Checking policy mock-up; the implementation is ready to run. The tray and staff are authorised additions, not fidelity defects.
- Layout: the dark frame, five top stations, central review desk, large case summary and bottom progress line retain their hierarchy. The tray occupies the lower Reception area without covering the active investigator or desk labels.
- Typography and copy: locally bundled Inter remains legible; case labels are short and long status text wraps. The initial Ready label and waiting timeline describe actual demo state.
- Colour: navy panels, warm office lighting, green active selection and amber review status remain consistent. Selected cases use an underline so outcome colours keep their meaning.
- Assets: the existing office, folder and staff artwork remain unchanged. Prior cosmetic P3 differences from the generated reference remain.
- Responsive: checked 1488 × 1059, 1140 × 950 and 320 × 740. At 320px the tray becomes a full-width strip, page width stays 320px and the active archive is visible after resizing. The header is sticky on compact layouts.

### Findings and verification

- P2, long tray statuses overflowed at 1140px: fixed with wrapping labels. Browser readback after the fix showed status scroll widths equal to their available widths; screenshot inspection showed no adjacent-card overlap.
- P2, resizing to a phone could leave the active station off screen: fixed by recentering the office when its viewport changes. At 320px the office width was 320px, content width 650px and scroll position 330px; Archive was visible.
- Browser verified that switching from a running RF-104 to RF-105 leaves RF-104 Paused. RF-105 can run independently; choosing its already-selected folder does not restart it.
- Returning to RF-104 restores its saved stage and Resume control. Resuming completed successfully. Returning to completed RF-104 and held RF-105 restores each outcome immediately.
- RF-104 history remained at five entries with one receipt after selection changes. RF-106 completed Already resolved with no additional refund. Selection itself does not add history or receipts.
- Reset cleared all three saved statuses and returned to Ready to investigate with all stages waiting. Reload also returned to the same ready state.
- Independent source review found no P0–P2 issue in saved frames, stage timing, restoration, reset or receipt/history handling.
- Five workflow tests passed. Production build passed after final edits; log: `work/build-tray-final.log`.
- One React development warning was logged when hot reloading an edited effect dependency list. A clean reload produced no new warnings or errors. No outstanding runtime failure was observed.

Final result: passed for this local prototype update, with no outstanding P0–P2 findings. State lasts only for the current page session; no model, payment provider or external ledger is connected.

## Motion update, 12 October 2026

Approved direction: a busy miniature office with subtle activity. The existing room and bottom case panel remain the visual baseline; clerks, courier, monitor light, case handoffs and an optional motion control are authorised additions.

- Compared `work/selected-reference.png` and `work/desktop-motion-final.png` together at 1488 × 1059, initial RF-104 Checking policy preview. The layout, desk labels, case panel and hierarchy are preserved. Three seated clerks and a smaller aisle courier provide the requested office activity.
- Investigator travel uses a pausable animation. Walking stops on arrival; working movement follows. Handoff and outcome effects are cosmetic and do not write receipts or advance the workflow.
- Fixed an existing pause issue: resuming now uses the remaining stage duration instead of restarting that stage.
- Browser checked pausing both at a desk and part-way through travel. Repeated DOM geometry samples showed both investigator and courier positions remained identical while paused, then moved after resume.
- Motion off stopped ambient movement. Two separated geometry reads confirmed the courier stayed at the same position. The case outcome and history remained available.
- Browser checked a completed RF-104 run and replay: nine history entries, one receipt, and £0 additional refund on replay.
- Checked RF-105 on a 390 × 844 viewport: document width remained 390px, office tracked the active station, and the case stopped at Review needed. Captured `work/motion-mobile-review.png`.
- Emulated `prefers-reduced-motion: reduce` in the browser and verified the motion control switched off. Removed the emulation afterwards and restored normal motion.
- Corrected activity-caption placement to avoid the central Review label.
- Five workflow tests passed again. Final build passed; log: `work/build-motion-final.log`. No browser warnings or errors were logged.
- Source review found no P0–P2 stale-animation, pause-state or receipt/history corruption issue. No outstanding P0–P2 findings from the browser checks. Existing cosmetic P3 differences below remain.

Final result: passed for the motion update. This is still a scripted local prototype, with no autonomous model or payment integration.

## Source and comparison

- User-selected source: `work/selected-reference.png` (copied from the supplied clipboard attachment).
- Final implementation: `work/desktop-final.png`.
- Browser: Codex in-app browser, http://127.0.0.1:4173/.
- Desktop viewport: 1488 × 1059 CSS pixels; device pixel ratio 1. Document width and height match the viewport. Screenshot captured at the same viewport dimensions.
- State: RF-104, initial concept preview, Checking policy. Run demo case starts at reception. Final screenshot has no open inspector or reset notice.
- Source and implementation were displayed together in the same comparison input, first after styling and again after final edits. Full-screen comparison and focused inspection of the header, desk labels, active policy desk, investigator, case summary and timeline completed.

The dark navy frame, room composition, five top workstations, central review desk, warm lamps, green monitors, large bottom case panel and timeline match the selected direction. The office background is a generated illustration; interactive labels, highlights, investigator, case data, buttons and panels are separate UI elements.

Minor differences remain: the separate folder asset is smaller and more horizontal; poster and entrance-mat lettering are absent from the clean room asset; stage spacing and native typography differ slightly. These are cosmetic P3 differences. The top disclosure deliberately says local demo and no money moves, and the initially unfinished archive says Waiting rather than Complete.

## Findings and fixes

- P2, case history was cleared on switching or replay: fixed with per-case histories and append-only activity during the page session. Browser readback after switching through other cases confirmed RF-104 retained nine entries and its single receipt.
- P2, active desk could move off screen on phones: fixed by scrolling the office viewport to the active workstation, with reduced-motion preference respected. Browser readback at 390px showed the completed archive state and office scroll position 260px.
- P3, replay icon was filled: changed to an outlined replay icon.
- No outstanding P0–P2 findings within this prototype scope.

## Functional checks

Verified through browser interactions:

- Evidence panel shows the synthetic order, packing record and previous remedies.
- Escape dismisses the native dialog; focus returns to the initiating control.
- Run, pause and resume work.
- RF-104 reaches a £20 local receipt and five-stage history.
- Replaying RF-104 ends Already resolved, displays £0 additional refund, and keeps exactly one receipt. History contains the first run and replay (nine entries).
- RF-105 stops at Review needed. The review panel identifies missing delivery evidence, and Payments reports zero demo receipts.
- RF-106 identifies seeded remedy DEMO-REMEDY-104 and records no additional refund.
- Switching back to RF-104 preserves its existing history and receipt.
- Reception, evidence, policy, payments, review and history panels have case-specific content.
- Reset returns the original RF-104 preview and Run demo case control.
- No browser errors or warnings were logged during checks.

Saved evidence includes `work/evidence-panel.png`, `work/success-history.png`, `work/review-outcome.png`, `work/repeat-history.png`, `work/mobile-success.png` and `work/narrow-history.png`.

## Responsive and accessibility checks

- Checked 1488 × 1059, 390 × 844 and 320 × 740 viewports.
- Document width equalled the viewport at both phone widths; horizontal scrolling is confined to the 650px office scene.
- At 320px the header wraps and the page scrolls vertically; the main controls remain reachable.
- Long history and policy panels retain a visible close control and scrollable content, with fixed header/footer areas.
- Buttons have accessible names and visible keyboard focus. Native dialogs provide focus containment and Escape dismissal. Status updates use live regions.
- CSS source review confirmed reduced-motion rules disable animation and transitions. This preference was not separately emulated in the browser.

## Build and scope

- Five workflow tests passed (`node --test tests/workflow.test.mjs`).
- Final production build passed (`npm run build`); output saved in `work/build-final.log`.
- All cases, policies and outcomes are scripted and synthetic. No language model, payment provider, ledger or organiser API is connected. No Stripe sandbox or live transaction occurs.
- Receipts and histories last only for the current page session. Reloading or resetting clears them.
- This verifies the visual prototype and its local interactions, not autonomous financial execution or eligibility under the unrevealed event rules.
