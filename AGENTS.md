# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Approved office motion direction

Keep the selected dark pixel-art office and bottom case panel. The user prefers a busy miniature office with subtle activity: small working staff, case handoffs, and movement tied to the actual demo stage. Preserve clear policy and history panels. Avoid loud game effects and decorative rewards. Keep motion optional and respect reduced-motion preferences.

## Current connection preference

Keep the clearly labelled local analyser and local payment simulation. The user chose both on 12 October 2026. Do not provision or enable external model or Stripe access unless the user changes this preference.

## Required human approval

Every refund requires an explicit human approval. The agent may investigate and recommend an exact amount, but must wait at Review before a new payment is submitted. A refund policy limit is an additional constraint, never permission to pay automatically. Approval belongs to the specific case, amount and evidence; changed facts require renewed review. Preserve existing historical receipts without inventing retrospective approval. Keep this rule enforced by the service, not only by the interface.

## Offline integration preparation, 14 October 2026

The user has no provider logins or credits for testing. Build and test useful local features without connecting external services. Network use by application providers must require an explicit opt-in; ambient credentials alone must never activate them. Do not replace ElevenLabs with another speech provider. A text briefing is acceptable when speech is unavailable, provided it is clearly labelled.

The requested integration list is OpenAI, Anthropic, ElevenLabs, n8n, Supabase, Vercel, Miro, Modal, Stripe and Port (the developer portal). Distinguish implemented local features, disconnected adapters, preparation files and future proposals. A local queue is not an n8n execution, local rules are not an AI model call, and a prepared export is not a published board or deployed service.

The user requested both a 12-case focused rehearsal and a 50-case busy-office pack, prepared for a later online setup. Keep their synthetic catalogues and saved decisions in separate local databases; do not merge them into the original cases. Prepare all ten sponsors offline. The user subsequently authorised offline implementation of the Supabase migration and its application layer. The original office remains on SQLite at ports 4173/4174. A separate PostgreSQL rehearsal at 4273/4274 connects the UI, background investigator and review transactions through a local transport. Its selectable profiles are explicitly test identities, not real sign-in. This is not permission to connect, upload or enable cloud storage. Keep payment submission and settlement absent from the ordinary local PostgreSQL preview; preserve historical SQLite approvals as non-executable archive evidence. New user-facing cases must wait for the user's own decision. Keep rehearsal volumes separate and durable; require an explicit checked reuse instead of resetting saved state.

Prioritise a usable saved decision brief, actual execution history, error recovery and a clear small-retailer use case. The judging criteria are real output, agent design and architecture, business viability, and a demonstrable run. Never fabricate agent plans, model handoffs, activity logs, approvals or provider receipts to satisfy those criteria. Intake workers may investigate but cannot approve, submit or reconcile a payment.

## Prepared hosted sponsor wiring

The user authorised writing and locally testing the remaining sponsor application code without online connections. A separate hosted API and additive migrations prepare Supabase sessions, a shared action ledger, protected n8n intake and a gated Stripe test executor. Neither normal preview enables that code or applies the additional migrations. Existing disabled reservations do not grant Stripe permission: a new reviewer authorisation must bind the original approval, current facts, exact amount and test-account mapping. Payment execution has a distinct role; intake investigators cannot approve, submit or reconcile. Preserve the original databases and historical source archives. Update README, setup guides and architecture documentation alongside code changes, clearly separating local tests from later account acceptance.

## Customer clarification workflow

The user authorised a missing-evidence loop after the payment review screen. Record a received customer statement and its source, investigate again and stop at a fresh human decision. Preserve the original complaint and catalogue facts. A clarification can identify an existing order item; it must not override prices, packing records, delivery disputes, policy or payment details. Do not fetch a source reference or contact a customer automatically. Use a new isolated local rehearsal for the added database workflow; preserve the existing rehearsal and all earlier decisions. Every refund still requires the user's explicit approval.

## Demo reset

The user wants a Reset demo option that restarts the current synthetic pack, without choosing a different pack. Start a fresh local run and retain the previous run, evidence and decisions separately. Reset must not delete or reseed saved financial records, enable sponsor services or approve any refund. Bind requests and pending decisions to their original run so stale tabs and retries cannot affect a fresh rehearsal. Keep the original SQLite and PostgreSQL demonstrations separate.

## Miro source map

The user wants the information's source and destination shown on the Miro board. This means Miro, not Canva or a separate in-app canvas. Prepare the graph from saved records and provide local inspection while the integration remains disconnected. Distinguish gathered evidence from cited evidence, original complaints from later clarification, waiting review from recorded decisions, and available outputs from published results. Link only to supported case records; source references must not be fetched automatically. Missing or uncertain board items must prevent a claim that publication is complete.

## Arize AX observability

The user confirmed Arize AX and authorised preparation and local testing only. Keep trace uploads off even if credentials exist in the environment. Record actual operations, distinguish local rules from model calls, and exclude raw customer text, source references and secrets. Evaluate the committed synthetic packs against their expected outcomes without approving refunds. A scorecard is evidence about those observed checks, not proof of real-world correctness or live provider acceptance. Activation later requires the destination space, project and region as well as a key, explicit upload authorisation and a synthetic account test. Arize is an additional observability integration, not an eleventh confirmed sponsor.

## Additional case canvas and initial online deployment, 15 October 2026

The user authorised adapting the connected-card interaction from Playground's Open Canvas as an extra function inside Refund Office. Keep the miniature office as the main screen and preserve the current investigation, review and approval workflow. The case canvas presents saved evidence, investigations, checks, decisions and outputs; layout movement cannot change those records, create connections, approve refunds or publish to Miro. Do not modify the separate Open Canvas project. Bind the view to its case, revision and signed-in workspace/run; source references remain text.

The user now authorises deploying the combined application to Vercel with Supabase for their use only initially. Use a new synthetic workspace, local analysis and disabled payment execution. This changes the earlier offline-only restriction for the selected hosting and working database setup; it does not activate other sponsors or Arize uploads. Preserve all local rehearsals and existing case histories. Verify actual hosted sign-in, membership restrictions, persistence and API routing before reporting the app as deployed and usable. Missing account access remains an explicit setup dependency.

## Canvas chat and voice input, 15 October 2026

The user requested chat in the extra Case canvas and ElevenLabs voice input. Keep the office and refund workflow intact. The initial chat uses saved map records and must be labelled as local record-based answers, not a model conversation or a new investigation. Citations select real records. Chat must not approve, reserve, submit, alter evidence, contact a customer or publish a board. Clear in-memory conversation and microphone data when the case, saved revision, workspace, run or principal changes, or the panel closes.

Microphone use starts only after an explicit action. Keep a bounded recording local until the user explicitly chooses ElevenLabs transcription. Disclose its destination and account retention settings. Put recognised speech into an editable question; never submit it to chat or save it as evidence automatically. Use the server-side key only; never embed it in the browser, source, logs or chat. Keep transcription independently gated from ElevenLabs speech output and other sponsors. Preparing credentials does not verify provider acceptance or authorise a background audio upload.

The user requested switching Supabase to the account they selected for Vercel. Confirm the signed-in destination and new Refund Office project before applying setup. Keep exact account emails and credentials out of project documentation. The supplied Anthropic presentation is additional guidance; Anthropic remains an add-on while its API credential is prepared. Do not silently replace the existing fintech brief or claim advanced agent/API features that have not run.

## Weighted judging criteria and Claude proof, 15 October 2026

The user supplied the weighted rubric: useful output 20%, agent design and architecture 15%, business viability 20%, demo and pitch 15%, demo clarity 15%, responsible design 15%. A real Claude run is required. The user authorised up to three short Anthropic investigations using only supplied synthetic orders, fictional complaints and packing records. This changes the earlier disconnected restriction only for that bounded Anthropic test; it does not authorise real customer data, payment execution, other sponsors or Arize uploads.

The key will be configured privately as a server-side Vercel Secret named ANTHROPIC_API_KEY, not uploaded in a filled .env file or exposed through VITE_ configuration. Keep the existing explicit provider opt-ins. One bounded Claude investigator may call read-only snapshot tools, then hand a recommendation to deterministic validation and human review. Office characters are not independent agents. Record actual execution metadata and distinguish controlled fixtures, real provider responses and untested deployment. Never assign the product its own judging score or invent customer validation.

The user subsequently chose **Vercel only** for this key. Do not request a local copy or run real Anthropic calls locally. The authorised synthetic calls must wait for the hosted setup and server-side Secret configuration. The local proof runner may be tested only with explicitly controlled responses under this preference.

## Animated architecture map destinations, 15 October 2026

The user chose all three destinations for the animated architecture map: an additional in-app **System map** view, the pitch presentation and a separate 30-second video. Keep the miniature office as the main screen and reuse the same authored topology and evidence boundaries across the three destinations. Label the map **Illustrated architecture, not live traffic**. Provider paths are preparation; animation must not imply a request, investigation, approval or payment, or replace saved-case and provider execution proof.

Keep the app map read-only and isolated: pass no case records, API client or financial actions into it; retain the iframe's scripts-only sandbox and restrictive Content Security Policy. Start the embedded map Still, then let the reader choose Live and Play story. Keep its controls separate from office motion and respect reduced-motion preferences. Closing, changing case or changing session/run must remove the map's active view. Record actual validation and playback checks separately for the app, video and presentation; embedded media alone does not establish native PowerPoint playback. Keep the result and remaining unknowns in [the map verification record](docs/verification-animated-system-map-2026-10-15.md).
