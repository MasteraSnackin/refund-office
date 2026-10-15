# Offline integration verification: 14 October 2026

The local build and all 136 Node tests passed after the intake, sponsor and interface changes. The suite includes eight integration setup checks, which also execute four Python extractor tests. The separate four-test Sites packaging check passed. No dependency installation or external provider test was performed.

## Browser acceptance

The application ran at the usual local preview address with a separate practice database under `work/offline-integrations/browser-qa-agiha7rj/`. The original `.data/refund-office.sqlite`, WAL and shared-memory files retained their recorded SHA-256 hashes throughout verification.

- A request for the missing desk mat in synthetic order DEMO-108 created a saved case. Background investigation completed while another case remained selected.
- The case stopped at Review with a recommendation of £18. The saved packet had no payment operation before explicit approval.
- The briefing showed evidence, policy checks and the outstanding human decision. Its Markdown download completed in the browser.
- An explicit local acceptance-test approval produced one simulated £18 receipt and a saved reviewer reason. No real money moved.
- An identical intake event returned the same case. Reusing its identity with changed contents returned HTTP 409.
- A separate claim for that issue found the original operation and created no additional refund.
- A new intake request submitted through the local API appeared in the open office without a page reload. Its £12 recommendation remains awaiting the user's decision.
- All ten sponsor roles appeared with disconnected or locally prepared status. ElevenLabs remained disconnected, with text only.
- The intake and connections dialogs were checked at a 390-pixel viewport. The page had no horizontal overflow. Reopening a dialog now resets its content to the top. The viewport override was reset afterwards.

The final preview retains practice data, including the explicit acceptance-test approval. The original case database was not used for these actions.

## Evidence

- [Local HTTP acceptance record](../ARTIFACTS.md#excluded-c07189b32fab04a7)
- [Completed decision brief](../ARTIFACTS.md#excluded-d5738548526a7572)
- [Completed decision packet](../ARTIFACTS.md#excluded-56ebaf88ca872626)
- [Browser-downloaded report before approval](../ARTIFACTS.md#excluded-c8cbab3b5c413ed0)
- [Office awaiting a decision](../ARTIFACTS.md#excluded-b55295f9765dd809)
- [Mobile intake view](../ARTIFACTS.md#excluded-018cd29fe44ff560)
- [Build log](../ARTIFACTS.md#excluded-41e945977ae9f6dc)
- [Test log](../ARTIFACTS.md#excluded-b6d54c504d1488c3)
- [Sites check](../ARTIFACTS.md#excluded-273887a840d9cb40)

## Independent review and fixes

The review checked background-work authority, failure recovery, outbound request controls and the prepared service configurations. It identified and resolved a worker error that could leave a case looking active, a Modal response-validation gap and misleading timing in saved policy text. Modal results now have to match every submitted source line as well as its identity and hash. Miro and Port responses explicitly remain write acknowledgements without independent content verification.

The Supabase setup guide now states the privileged migration-owner requirement for its security-definer function and forced row-level security. That requirement has not been exercised in a database.

## Limits

No sponsor account was connected, no credential or Keychain item was read, no provider request was sent, and no cloud resource was deployed. The tests use controlled responses and fake credentials. Public API documentation was consulted separately to prepare request formats.

The n8n workflow has not been imported or activated. Supabase SQL has not been applied, so actual authentication, row-level security and concurrency still require database tests. Modal has not been deployed. Vercel preparation serves a frontend with its API deliberately unavailable; a working hosted backend remains future work. Anthropic is an alternative analyser, and ElevenLabs speech has no exposed application route. Miro and Port publishing are prepared clients with no automatic publishing loop.

Local deterministic analysis cannot demonstrate live model planning or inter-model handoffs. The usable output here is the saved evidence, recommendation, human decision and local payment record. The [demo guide](hackathon-demo.md) maps that evidence to the judging criteria without claiming customer validation or live money movement.
