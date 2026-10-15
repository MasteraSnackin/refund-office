# Case canvas

Case canvas is an additional inspection view inside Refund Office. The miniature office remains the main screen for investigation, review and decisions. The canvas lays out the selected case's saved evidence and results so you can follow how the records relate.

## Open and explore

Choose **Case canvas** for the selected case. The view reads that case's saved provenance export and checks that its identity and revision match the case on screen. A case still being investigated may have pending checks or decisions; the map shows those states rather than inventing a result.

The five columns are **Sources**, **Investigation**, **Policy**, **Human decision** and **Outputs**. Directed connections describe relationships recorded in the export. They distinguish gathered records from cited evidence. An arrow does not prove a live agent handoff, a model call, payment submission or delivery of a report.

Drag the background to pan. **Fit readable** keeps the text readable and may leave some records outside the viewport; the stage buttons jump to a column. **Focus selected** centres the chosen card. Select a card to read its saved map text, source identifiers, incoming and outgoing connections, and available record links in the inspector.

Search highlights matching records and their connections in the spatial view. **List** filters the same records into a view that does not require dragging. **Canvas** returns to the spatial view. The inspector identifies any exported text excerpt; the saved case export retains the complete underlying record.

With keyboard focus on the background, use arrow keys to pan, plus or minus to zoom, and Home for a readable fit. On a card, arrow keys select the next or previous record; Shift plus an arrow moves it. Escape closes the canvas.

You can move cards to make a connection easier to follow. Positions stay in memory for the open view; they are not saved to the case, a database or a Miro board. **Reset layout**, refreshing the map or reopening it restores its original layout. **Refresh** rereads the selected saved revision; a changed revision must be loaded through the current case view.

## Ask about the saved case

Choose **Ask this case** to show local chat in place of the inspector. Type a question or choose a suggested question about the amount, evidence, next step or selected record. Answers quote the verified map and label unknown or unavailable facts. Selecting a citation centres its existing canvas card; **Record inspector** returns to the saved text and connections.

This is deterministic record-based chat. It does not call OpenAI or Anthropic, investigate again, approve a refund or check a provider. The existing optional Anthropic comparison remains a separate add-on. A quoted instruction inside an evidence record stays source material and cannot change the chat's authority.

Questions are limited to 1,600 characters and the panel retains the latest 20 exchanges in memory. Closing the panel or changing the case, saved revision, workspace, run or principal clears the previous conversation and draft. It is not a saved customer-support transcript or an audit record.

Prepared ElevenLabs voice input uses separate steps: record locally, choose **Transcribe with ElevenLabs**, edit the returned question and then choose **Send question**. It is unavailable while setup is incomplete. The [voice-input guide](CANVAS-VOICE-INPUT.md) explains the microphone limit, explicit upload, server settings and account-retention limits. Transcribing a question does not add supporting evidence.

## Saved information and links

The view uses the existing `GET /api/cases/:id/board-export` response. It adds no separate evidence store, model request or sponsor publication. A configured hosted API still reads Supabase through its existing session and membership controls. The same source map also supports the prepared Miro inspector, but opening the canvas does not publish anything to Miro.

The inspector preserves the exported source references as text. It does not fetch a document, contact a customer or turn an arbitrary source URL into an active link. Record actions use the existing download control and allow only supported routes for the same case: the saved case, decision packet, decision brief and provenance export.

These routes retrieve the current saved record under the active session and, where applicable, the local run guard. They are not immutable links to a historical revision. The displayed export has its own revision label, so recheck the case if later investigation or review changes it. An available output link does not mean someone has downloaded or sent that output.

The prepared hosted provenance export does not include the separate Stripe execution record. It therefore cannot establish the current provider payment result. Inspect the dedicated payment result view when that separate service has been configured.

## Access and scope

Loading and interaction state belong to the selected case, revision, signed-in principal and workspace/run. Changing that scope clears the view and rejects delayed results from the previous context. An export with a mismatched identity, revision or unsupported record path cannot be displayed as the selected case.

Routine session checks with unchanged identity keep the canvas open and preserve its layout. A changed session generation, workspace, run, user/profile or role invalidates the previous context.

The canvas loads separately from the main office. If that load or the canvas rendering fails, its error boundary displays **Back to office**. A presentation error does not start a new investigation or change saved facts.

The canvas is read-only for every role. It cannot change evidence, edit text, create connections, start investigation, record a human decision, authorise a payment or publish a board. Existing service and database checks remain responsible for all financial authority. Every new refund still needs explicit human approval.

## Relationship to Open Canvas

This feature adapts the connected-card interaction of the user's separate Open Canvas project. That reference application is unchanged. Refund Office uses its own saved provenance and existing authenticated records; the additional view does not import the reference application's report composition, AI actions or content editing.

## Deployment and verification

The requested first hosted version is for the owner only, with a fresh synthetic workspace, local analysis and payment execution disabled. Vercel and Supabase account setup, real sign-in, membership isolation, persistence and hosted API routing must be verified separately. The authorisation for that setup does not enable Miro, other sponsors or Arize uploads.

No deployment or database migration has been performed for this addition. The Supabase dashboard destination and access to the intended Vercel workspace still need to be confirmed before hosted setup can proceed. Account access available in a browser does not establish that command-line credentials target the same account.

## Earlier canvas-only checkpoint, 15 October 2026

The application build passed and all 692 application tests passed with no failures or skipped tests. That total includes 17 focused canvas tests, two error-boundary tests and three added session-transport regressions. A focused run of 58 tests across the affected areas also passed, followed by independent review. The [full test log](../ARTIFACTS.md#excluded-044e48790c3cf846) and [build log](../ARTIFACTS.md#excluded-aa5b4c015646e2fd) record the checked version.

The browser check opened the actual RF-2008 map with 19 saved records and 25 connections. Searching for `Sketchbook` matched two of 19 records, the list showed the two matching sources, and the inspector displayed the full saved packing text and its gathered-but-not-cited relationship. A separate browser fixture using React confirmed that a rejected lazy import and a child rendering error preserve the main sibling view and leave **Back to office** usable. Neither check approved a refund or submitted a payment.

The actual browser interaction check confirmed pointer dragging, background panning and restoring the original layout. Arrow-key selection brought the next record fully into view without scrolling the native viewport. Escape closed the dialog and returned focus to the original **Case canvas** button in the office. A moved card and selected record survived an unchanged-session refresh after 36.857 seconds; the [session-stability record](../ARTIFACTS.md#excluded-6d6a3c39c6802930) preserves that observation.

The final rendered layout was inspected at an actual viewport of 822 by 1030 pixels, where the dialog fit within 790 pixels. A requested 390-pixel override did not take effect, so phone-width rendering remains unverified. These local checks made no refund approval, payment submission, database migration or cloud upload. Earlier verification documents and source archives describe their original versions and do not establish coverage of this addition.

The 692-test checkpoint predates canvas chat and voice input. The combined version subsequently passed its build and all 761 application tests; the [voice-input guide](CANVAS-VOICE-INPUT.md#verification-status) records that result and the exercised browser scope. Neither checkpoint establishes real microphone capture, speech-provider or account acceptance, phone-width rendering or deployment.

For the surrounding system, see the [architecture](../ARCHITECTURE.md), [hosted setup guide](HOSTED-SETUP.md) and [existing Miro provenance verification](verification-miro-provenance-2026-10-14.md).
