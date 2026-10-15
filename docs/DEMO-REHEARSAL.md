# Three-minute offline rehearsal

Show a retailer's refund request becoming a checked recommendation, then show the evidence and report a reviewer can use. This walkthrough uses a fresh copy of the **focused-12** synthetic pack. It records a fictional clarification and an internal evidence request, but stops before approving any refund. All sponsor services and Arize uploads remain disabled.

The live path is the current local PostgreSQL application. Its investigator uses local rules. Prepared model adapters have controlled-response tests; this rehearsal does not demonstrate a live model, Supabase sign-in, n8n run or Stripe payment.

## Prerequisites and isolation

- The complete source folder and its locked dependencies. Use the Node.js **26.10.0** runtime exercised by the project; other runtime combinations are not established by this rehearsal.
- A running **local Docker daemon**, with `docker` on `PATH` and a Unix socket at `~/.docker/run/docker.sock` or `/var/run/docker.sock`. The launcher does not use a remote Docker context.
- A cached **`postgres:16-alpine`** image. The launcher uses `--pull=never` and runs the database with no network or published database port. A source archive does not include Docker or this image.
- Two free local ports. This guide uses **4773** for the interface and **4774** for the API so existing 4173, 4273, 4473 and 4673 previews can remain separate.
- A browser with local session storage enabled, for saved retry commands. This clean-copy check uses `localhost`, while the existing previews use `127.0.0.1`, to separate their host-only cookies. Ports alone do not isolate cookies: other `localhost` previews still share that hostname. Use a dedicated browser context if several previews must use the same host.

For a source folder with cached npm packages, this installation attempt makes no npm registry request and skips dependency lifecycle scripts:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
```

The build checks that the cached platform binaries work without their install scripts. If the offline cache or a platform binary is missing, installation or build will fail; stop there and prepare the required dependencies separately. Do not remove `--offline` or download an image as an unannounced fallback. A successful clean-copy check on this machine does not establish that another machine has the same prerequisites.

Start from the extracted source folder:

```sh
node scripts/run-judge-rehearsal.mjs focused-12 --ports 4773 4774
```

Open <http://localhost:4773/> and choose **Local reviewer**. The API permits both `localhost` and `127.0.0.1` on these ports; use the same hostname throughout this rehearsal. The launcher prints the equivalent `127.0.0.1` URL, but opening that in the browser context used by the earlier previews can replace their host-only session cookie. The `localhost` choice separates this run from those existing `127.0.0.1` previews; it does not isolate it from other `localhost` ports.

These profiles are local test identities. Wait for the initial queue to finish. Before adding any new request, the expected result is **12 cases: six awaiting approval, five held, one linked to labelled historical data**. No new refund should be approved or reserved.

The launcher creates a distinct workspace, Docker volume and marker under `.data/judge-runtime-rehearsals/`. It refuses occupied ports, forces providers off and leaves existing previews and saved data alone. It does not apply the prepared hosted payment migrations. If the initial state differs from the expected result, inspect the case history before presenting it.

## Three-minute presentation

The timings are presentation targets, not measured processing guarantees. Have the fictional text below ready to paste. Keep the report viewer available so the downloaded Markdown can be shown immediately.

| Time | Action on screen | Explain |
| --- | --- | --- |
| 00:00–00:15 | Show the office, synthetic pack and local-mode labels. | “Refund Office prepares missing-item refunds for a shop's support reviewer. Every new refund still needs a person to approve the exact amount.” |
| 00:15–00:40 | Open **Intake queue**. Choose `SYN-F12-O001`, enter the mug request below and choose **Submit and investigate**. Open the newly created case from the queue. | “Enter the request once. The worker retrieves the supplied order, packing and delivery records, checks policy, and saves its recommendation.” |
| 00:40–01:00 | Inspect the new case's evidence and £20 recommendation, with **Awaiting approval** visible. | “This £28 order contains a £20 mug that the synthetic packing record says was omitted. The £20 proposal passes policy, but that does not authorise a refund.” |
| 01:00–01:20 | Select **RF-2008**. Show the generic complaint and two omitted lines. Record the evidence request below through Review. | “This request does not identify which missing item the customer is claiming. The office holds it for clarification.” |
| 01:20–01:50 | In **Customer clarification**, select the sketchbook, paste the fictional statement, source and reason below, confirm the statement and choose **Save statement and reinvestigate**. | “I am recording a fictional reply already received for this demo. The original complaint and packing record stay intact. The worker checks again and prepares £10 for the sketchbook.” |
| 01:50–02:05 | Open **Review £10 proposal** and show the amount, evidence and approval boundary. Close it without approving. | “New evidence means a fresh decision. The reviewer can inspect the facts, ask for more evidence, or decline. This demonstration leaves the refund unapproved.” |
| 02:05–02:25 | Open **Judge mode** on RF-2008. Step through the original hold, evidence request, clarification and completed investigation. Use pause and seek. | “These are saved events in recorded order. Playback does not run the investigator again or make a decision. Its speed controls are for presentation, not elapsed-time measurement.” |
| 02:25–02:40 | Choose **Download saved brief** and show its original complaint, clarification source, checks and pending decision. | “The output is a usable decision brief with its supporting record. It is not a payment receipt.” |
| 02:40–03:00 | Close the inspection. Choose **Reset demo**, confirm the same pack and choose **Save run and reset demo**. Show the return to profile selection when ready. | “Reset saves this run and opens a fresh copy of the same pack. Earlier statements and decisions stay with the previous run. No provider is contacted and no refund is approved.” |

If processing takes longer than its slot, show the actual waiting state and explain it. Do not relabel a saved event as live work or claim reset finished before its confirmed result. For a strict timed presentation, use the saved recording with its stated version, or rehearse a shorter screen sequence; a three-minute target does not justify omitting an unresolved result.

## Fictional inputs

### New intake

Select **`SYN-F12-O001 · £28.00 · missing mug`**. The character before `001` is the letter **O**. Enter:

> My parcel arrived, but the travel mug is missing. Please refund the missing travel mug.

The browser creates and retains the event reference for a safe retry. The new case number is assigned at runtime; identify it from the saved queue instead of assuming a number. A second claim about the order can still await review because neither claim has an approved refund. This is not evidence that duplicate payments have occurred.

### RF-2008 evidence request

Choose **Request evidence** and use this **Evidence needed** text:

> Synthetic rehearsal: please identify whether the missing item being claimed is the sketchbook or the marker set. The original complaint does not identify one line.

Choose **Save evidence request**. This records an internal review action. It sends no customer message and does not approve a refund.

### RF-2008 clarification

| Field | Value |
| --- | --- |
| Item identified by the customer | Sketchbook, £10 each; existing line `SYN-F12-O008-L1` |
| Received customer statement | `The sketchbook is the missing item I am claiming.` |
| Source reference | `Synthetic rehearsal support reply RF-2008` |
| Reason for recording this clarification | `Fictional reply for the offline rehearsal. It identifies the sketchbook; the original catalogue, packing and delivery records remain unchanged.` |

Confirm the supplied statement as a **fictional rehearsal input**, then choose **Save statement and reinvestigate**. The expected current result is a **£10 recommendation awaiting approval**. The broader language checks now cover this phrasing. An earlier film preserves a hold caused by the older parser; that historical recording is not altered by the current behaviour.

## Check the result and stop cleanly

Before reset, confirm that the new mug case is awaiting approval for £20 and RF-2008 is awaiting approval for £10. The new request adds a thirteenth case; with no other changes, there should be **eight awaiting approval, four held and one historical remedy**. Neither recommendation is a refund receipt.

Keep the downloaded RF-2008 brief from the run before reset. It should identify the saved case revision, original request, fictional clarification, source reference, reviewer and investigation history, with no refund approval. Readable evidence summaries and policy explanations appear in the main brief; the appendix retains the original evidence bodies. The report distinguishes the current approval requirement from the earlier internal evidence-request decision. That earlier decision is not a payment authorisation.

After reset confirms its result, select **Local reviewer** again and let the fresh queue finish. Confirm the original **12-case, six/five/one** result. The new mug request and clarification belong to the retained earlier run, not the new pack.

If reset's response is lost, use **Check saved reset** or **Retry same reset request**. Do not submit another reset or remove its saved recovery record. A failed or unresolved switch needs inspection.

Stop the rehearsal with `Ctrl+C`. A successful shutdown checkpoints the current run, removes its owned container and retains its data volume. Use the most recent successful restart command: the launcher prints an updated command after each confirmed reset and at shutdown. An earlier command identifies an earlier retained run. For example:

```sh
node scripts/run-judge-rehearsal.mjs focused-12 --ports 4773 4774 --reuse SAVED_RUN_UUID
```

Replace `SAVED_RUN_UUID` with that run's actual UUID. Keep its source folder in the same location for checked reuse: the volume ownership includes the project path. Moving a saved marker alone does not migrate a database to another folder or computer. Use a fresh pack in a newly transferred source copy.

The current launcher writes a separate status file for each port pair, such as `work/five-improvements/judge-previews/4773-4774.json`. It records the current and initial run, retained run identifiers, reset status and restart command. The old single `judge-preview.json` is not updated. A saved status file is a handover aid, not proof that the process is still running. Failed or unresolved switches have no restart command; inspect the saved reset result before restoring a run. If a status write fails, the launcher warns and the API and reset journal remain authoritative.

For a separate local data directory, add `--data-directory PATH` when starting the Judge launcher. Its restart command retains that path and the chosen ports. This changes the local save location only; it does not move an existing workspace or bypass its ownership checks.

## Recordings and version boundaries

The existing films remain unchanged. Their MP4s play locally without starting the application or generating new narration.

| Material | What it shows | Limit |
| --- | --- | --- |
| `docs/demo/refund-office-3min.mp4` | Earlier original SQLite demonstration with local simulated-payment footage. | Predates intake and sponsor preparation. It is not this rehearsal. |
| Sibling `videos/refund-office-current/deliverables/Refund-Office-1min.mp4` | A 60-second PostgreSQL product introduction using recorded intake, clarification and saved output. | Predates Judge mode and the five latest improvements. |
| Sibling `videos/refund-office-current/deliverables/Refund-Office-3min.mp4` | A 180-second walkthrough with a workflow diagram, clarification history, decision brief, prepared Miro map and local evaluation. | Its evaluation covers the earlier SQLite engine. It does not show the current PostgreSQL evaluation or Judge mode. |
| Current live source and [five-improvement verification](verification-five-improvements-2026-10-14.md) | Broader local language handling, prepared main model path, current PostgreSQL evaluation and Judge mode. | Controlled responses and synthetic checks do not establish real account acceptance or customer savings. |

The newer films contain approved James narration from ElevenLabs, generated during that earlier video task. Playing them makes no new provider request. Their accompanying delivery guide records sampled visual/source checks and measured audio; it does not claim uninterrupted subjective viewing or listening. If the handover includes a newer recording of this clean-copy rehearsal, use its own manifest to establish its source version and what it actually shows.

For questions about evidence flow, open the prepared Miro map or [architecture map](diagrams/local-observability.html). For measured synthetic outcomes, use the current PostgreSQL report linked from [the verification record](verification-five-improvements-2026-10-14.md). For business claims, use the [retailer study](business-validation/README.md); no participant savings have yet been measured.
