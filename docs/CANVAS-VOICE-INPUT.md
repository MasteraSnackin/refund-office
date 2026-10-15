# Canvas chat and voice input

**Ask this case** explains the records already displayed by Case canvas. You can type a question, or use the prepared ElevenLabs speech-to-text path to draft one. The miniature office, investigation and human review workflow remain in place.

## Local chat

Open **Case canvas**, then choose **Ask this case**. Suggested questions cover the recommended amount, cited evidence, next step and selected record. You can also type a question and choose **Send question**, or press Control/Command plus Enter.

Answers use deterministic rules over the verified saved map. They quote existing records and give citation buttons that select those cards. They distinguish gathered evidence from what the saved proposal cited, an outstanding decision from historical review, and a recommendation or reservation from proof of payment. Unsupported questions remain unknown rather than being answered from invented facts.

No AI model is called by this panel. OpenAI and Anthropic configuration does not change that behaviour. The existing optional Anthropic comparison is a separate add-on, outside this local chat. Questions, drafts and the latest 20 exchanges stay in browser memory; they do not form a saved audit log. Closing the panel or changing the case, revision, workspace, run or principal clears the previous conversation and draft.

The chat cannot change evidence, record an approval, create a reservation, submit a refund, contact a customer or publish a Miro board. Citation navigation changes the selected card only. Quoted source text is data, even when it contains instructions.

## Record, transcribe and review

Voice is disabled until its server settings are complete. Typing remains available. Once enabled, the sequence is:

1. Choose **Record question** and grant the browser's microphone permission. Capture stays local for at most 45 seconds or 2 MiB. An oversized recording is discarded rather than uploaded.
2. Choose **Stop recording**, or let the time limit stop it. The panel identifies the recording as held locally. You may discard it.
3. Review the ElevenLabs destination notice, then choose **Transcribe with ElevenLabs** to upload that recording. Recording alone does not send it.
4. Check and edit the recognised text in the question box. The box has a 1,600-character limit, including any existing draft; review the result before sending.
5. Choose **Send question** separately. This runs the local saved-record answer; it does not save the transcript as evidence.

Closing or changing the active case context stops microphone capture, discards pending audio and invalidates delayed transcription replies. Cancelling an upload stops the local wait, but cannot prove that ElevenLabs never received a request already sent. The application does not automatically try another provider or retry the recording. You can type the question or explicitly record again after an error.

The browser must provide microphone recording in a secure context, such as HTTPS or localhost. Actual device permissions, recording format and account transcription quality still need an authorised account test.

## Server configuration

Speech input is separate from the prepared ElevenLabs briefing playback. It uses `scribe_v2` and does not require a text-to-speech voice ID or the `elevenlabs` playback allowlist entry. Merely supplying an API key cannot enable it.

| Setting | Requirement |
| --- | --- |
| `REFUND_OFFICE_NETWORK` | Exactly `enabled` for an authorised external request. |
| `REFUND_OFFICE_ENABLED_INTEGRATIONS` | Must include `elevenlabs-transcription`. Keep `supabase-runtime` as well when the hosted working database is configured; do not replace the required database entry. |
| `REFUND_OFFICE_VOICE_INPUT` | Exactly `elevenlabs`. |
| `ELEVENLABS_API_KEY` | Available only to the server process or deployment secrets. |
| `ELEVENLABS_STT_ENABLE_LOGGING` | Optional: unset uses provider/account defaults; `true` explicitly requests logging; `false` requests Enterprise-specific zero retention. |

Keep keys in server secret storage or load a local key from the approved Keychain helper into the child process environment. Do not put keys in browser code, project files, logs or chat. The service does not open the Keychain automatically. Ordinary rehearsal launchers continue to force external integrations off.

The default is the provider's account retention behaviour. Requesting `enable_logging=false` does not prove that zero retention is available or applied. Account eligibility, permissions and actual retention remain unverified until checked with ElevenLabs. Local tests cannot establish those facts.

## Request and access boundaries

The authenticated case route is `GET /api/cases/:savedId/voice-input` for availability and `POST` at the same path for the consented recording. `savedId` is the underlying saved case identifier, not its human-readable case label. The local and prepared hosted API require an interactive reviewer or investigator session. Machine/intake and payment-executor credentials cannot use this route.

The POST contains only `expectedRevision`, `consent: true`, `contentType` and canonical `audioBase64`. The API checks session, origin, workspace access, case identity and revision, plus the current run header in reset-enabled local rehearsals. It allows at most 2 MiB decoded audio within a 3 MiB JSON body on this exact route. Other ordinary JSON routes retain the 16 KiB limit.

The transcription adapter accepts supported WebM, Ogg, MP4 or WAV audio containers and checks the header against the declared type. These checks do not decode the audio, prove its duration or establish who spoke. The browser enforces the 45-second capture limit. The server bounds request size, response size and time; it independently rereads case/order facts and access after transcription and rejects a stale result.

Only the audio and fixed transcription options go to ElevenLabs. The saved case map, complaint, source references and chat history are not included in the provider request. The API does not persist the audio or returned transcript to a database, evidence record or chat store. This application boundary does not establish the provider's retention policy or remove data already received by a provider.

## Verification status

The final application build passed and all 761 application tests passed with no failures, skipped tests or cancellations. The [build log](../ARTIFACTS.md#excluded-e882d55db60153d6) and [application test log](../ARTIFACTS.md#excluded-9ed3bde714b54ec1) record that combined version. Independent review found an API-bridge issue, which was corrected and covered by five passing regression tests; no blocking finding remained in that review.

The local browser rehearsal showed the saved missing-mug case's £20 recommendation in chat, refused an explicit request to approve it, displayed the local-record label and kept the question composer visible. The microphone control remained disabled. The measured application viewport was 1193 by 1030 pixels; phone-width rendering was not checked.

Provider tests used injected responses and recording tests used local fixtures. Actual microphone capture, live ElevenLabs transcription, account retention and hosted deployment remain unverified. No live provider response is claimed, and a disabled microphone is not evidence that a device recording or upload has worked. These checks do not approve or submit a refund.

The [692-test canvas checkpoint](CASE-CANVAS.md#earlier-canvas-only-checkpoint-15-october-2026) predates this chat and voice addition. Earlier source archives and verification records retain their historical scope; they are not evidence that the combined version or a provider account has passed.

See the [Case canvas guide](CASE-CANVAS.md), [architecture](../ARCHITECTURE.md) and [hosted setup guide](HOSTED-SETUP.md) for the surrounding workflow and deployment limits.

The [combined verification record](verification-canvas-chat-voice-2026-10-15.md) records the final local checks, restart comparison and remaining account acceptance steps.
