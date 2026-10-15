# Canvas chat and voice-input verification — 15 October 2026

The additional Case canvas now has an Ask this case panel. It answers from the verified saved map, cites actual records and can select those cards. It is labelled as local record-based chat: no AI model is called. The office remains the main screen and financial decisions stay in the existing review workflow.

## Voice-input boundary

The microphone is unavailable until ElevenLabs transcription is explicitly configured. A recording starts only after a user action and stays in browser memory until the user chooses Transcribe with ElevenLabs. Recognised text becomes an editable question, followed by a separate Send question action. Neither audio nor the transcript is saved as case evidence or a financial record.

Recording is bounded to 45 seconds and 2 MiB. The exact transcription POST route permits up to 3 MiB JSON for its base64 payload; ordinary session and financial actions retain their 16 KiB limit. Session, origin, host, case, revision, evidence fingerprint and local run checks precede processing, with access and saved facts checked again afterwards. The server key is never returned to the browser. The provider deadline is 18 seconds. A warm handler permits one in-flight request for each tenant/user; this is not a distributed quota or a guarantee that a provider will not charge for a cancelled request.

ElevenLabs transcription is separately gated from speech output. Provider/account retention is the default. An explicit zero-retention option is only a request for the provider's supported account setting, not a verified deletion guarantee. See the [voice-input guide](CANVAS-VOICE-INPUT.md) and current [ElevenLabs transcription reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

## Checks observed

| Check | Result |
| --- | --- |
| Production build | Passed before the full application suite. |
| Application suite at this feature checkpoint | 761 passed; no failures, skips or cancellations. Later concurrent changes require their own combined check. |
| Focused API and existing API regressions | 63 passed, including 27 new voice API checks. |
| Independent review | No remaining blocker after the hosting cancellation correction. |
| Hosted bridge regressions | Five focused checks passed, including incoming abort, unfinished response close and ordinary completion. |
| Protected original files | All 71 before/after SHA-256 hashes matched. |
| Architecture map | Nine showcase checks passed, with zero errors or warnings; automated containment passed at four desktop sizes. |
| Documentation links | All 183 links checked by the documentation worker resolved before this verification record was added. |

The [application log](../ARTIFACTS.md#excluded-9ed3bde714b54ec1), [build log](../ARTIFACTS.md#excluded-e882d55db60153d6) and [preservation result](../ARTIFACTS.md#excluded-10d09c47574a5d2c) retain the results. No database schema or financial workflow changed in this feature; no earlier database-suite result has been presented as a fresh run.

## Browser observations

The local investigation-only profile opened the missing-mug case at its saved revision. Asking about the amount returned the saved £20 recommendation and cited the pending human decision. Selecting the recommendation citation selected and focused the real canvas card while keeping the conversation open. Asking the chat to approve the refund produced a refusal and did not record a financial decision.

Closing and reopening the internal chat panel cleared both the prior conversation and an unsent draft. The disabled microphone and the local-record label remained visible. The composer remains visible while longer answers scroll. The inspected viewport was 1193 × 1030; phone-width rendering, real microphone capture and real ElevenLabs transcription remain unverified.

See the [finished chat screenshot](../ARTIFACTS.md#excluded-b4bf348caa6dee3a). The browser check used genuine saved synthetic records, with no invented provider transcript or model response.

## Rehearsal restart and preservation

The attempt to reload the current local service stopped its owner before the usual shutdown record completed. Read-only inspection confirmed that its exact local PostgreSQL container, image, volume and ownership labels still matched and that the former owner process was no longer running. A private snapshot of the 13 allowlisted tables was saved. The owned database container was stopped, the verified checkpoint marker was written and read back, and the interrupted owner marker was retained separately. The earlier container remains stopped; its volume was not deleted or reseeded.

The same rehearsal then reopened through its normal checked reuse path. All 13 database tables matched the pre-restart snapshot exactly, including all 12 cases, zero new approvals and the existing labelled historical operation. The former browser session was rejected and the profile chooser returned. The [restart readback](../ARTIFACTS.md#excluded-40d0956fc34a7117) records the comparison. The restored voice-status route returned the intended disconnected state. Private snapshots and recovery files are excluded from deployment preparation.

## Deployment and account acceptance

The [fresh deployment preparation](../ARTIFACTS.md#excluded-d808bf27c8e2f922) contains 95 regular source/assets files, including all chat and transcription inputs. Its isolated build passed, all copied source hashes matched and the disabled hosted API returned HTTP 503 with zero external requests. Previous source snapshots remain unchanged. These checks do not establish cloud deployment, real sign-in, provider access or account acceptance.

Vercel's selected browser account and the requested Supabase account are confirmed. Supabase's only existing project in that account is an older paused project, so it was not reused. A fresh refund-office-demo form was prepared in the selected account with Europe selected and automatic new-table exposure disabled. Its database password and final creation require the user's own entry and submission. Fresh project creation and deployment access remain pending. No Supabase migration, source upload, Vercel deployment, provider request, new approval or payment submission was performed. Anthropic remains a separately prepared add-on.

## Later concurrent changes

A final source readback found newer edits from the separately active Deployment, Project update and Document chats. These include hosted-intake presentation, an optional Anthropic tools investigator, and documentation refreshes. They are preserved. The 761-test result and 95-file deployment snapshot above describe the canvas/chat/voice checkpoint before those later edits; they are not a verification claim for the newest combined project. The deployment copy must be refreshed and its combined checks rerun once those changes are settled. No existing snapshot was overwritten to conceal that distinction.
