# Synthetic packs and sponsor handover verification

Checked locally on 14 October 2026 using Node.js 26.10.0 and installed dependencies. No sponsor service was connected, no deployment or upload occurred, and no new speech was generated.

## Automated results

The build passed. All 166 Node tests passed, followed by the separate four-test Sites check. The Sites tests are also included in the aggregate suite; the separate run is a packaging check, not four additional unique tests. Four Python extraction tests run within the integration setup suite. The handover suite also compares a packaged extraction example against the pure Python function.

| Check | Result |
| --- | --- |
| All 62 initial scenarios | Exact expected outcomes and proposed amounts matched the local engine. Investigation made zero new payment calls. |
| All 62 stable intake events | Replaying each event returned its existing case without creating another. |
| Five duplicate pairs | After an explicit synthetic test approval and simulated payment on the original, the follow-up found the same receipt and retained one operation. |
| Dataset integrity | Invalid arithmetic, references, identity, seed state and catalogue changes were rejected. No seed grants a human approval. |
| Database isolation | Preparation uses separate pack paths. Repeated preparation leaves database bytes unchanged. Fresh rehearsal copies preserve prior decisions. |
| Startup identity | A missing, ordinary, mismatched or corrupted database is rejected before application recovery. Rejection leaves existing database bytes unchanged. |
| Offline launch | Pack launchers override online selections, select local analysis and clear the integration allowlist. The development launcher strips provider credentials and does not read secret files. |
| Occupied ports | A running preview causes the pack launcher to refuse startup without replacing it. Both Mac launchers passed shell syntax checks. |
| Sponsor handover | Eight tests cover all ten entries, exact file hashes, synthetic data, matching request shapes, private-file exclusion, blocked real transport, changed-file protection and relative links. |

Logs: [build](../ARTIFACTS.md#excluded-e0f6f857f1b3a1de), [aggregate tests](../ARTIFACTS.md#excluded-20b12073387a66f9), [Sites check](../ARTIFACTS.md#excluded-85de82ebad2869ba).

The final [sponsor preparation archive](../ARTIFACTS.md#excluded-12ca650e4f4df768) contains 49 allowlisted files and is 111,340 bytes. Every source file matched its manifest hash before packaging; the archive integrity check passed. No working database, filled environment file, dependency directory, logs or media were included. See the [archive record](../ARTIFACTS.md#excluded-d14197f1fdf736e5) and [checksum](../ARTIFACTS.md#excluded-d59376010cb44270).

## Prepared databases

Both standard rehearsal databases were created without running investigation. A read-only inspection confirmed 12 and 50 ready cases, matching queued intake records and no approvals. Their only payment operations are the explicitly seeded historical fixtures. The focused pack has one such fixture; the busy pack has four.

The browser checks used a separate fresh focused copy. The standard pack databases therefore remain available for showing the queue from its initial state. See the [inspection record](../ARTIFACTS.md#excluded-aecfc128d3ce9764).

## Browser acceptance

The local focused launcher started the API and interface. The browser showed the pack label, all twelve cases and background progress while a different case was selected. Once the queue finished, saved results were:

- Six cases awaiting explicit approval.
- Five held for policy or evidence review.
- One already resolved by an explicitly labelled historical fixture.
- No new payment operations or successful refunds.

The inbox showed eleven cases needing attention, zero open and one resolved. The workload total remained £0 simulated. The £20 mug case remained awaiting approval, and its briefing explicitly said no human approval or payment was recorded. Downloading its decision brief produced a readable Markdown file with the same evidence and decision state.

The pack label was readable at 1280-pixel desktop width and 390-pixel mobile width. Mobile document width remained 390 pixels; the office itself retains its intended horizontal scroll. No browser warnings or errors were reported at the final check.

Evidence: [office](../ARTIFACTS.md#excluded-7caa55fb79032165), [inbox](../ARTIFACTS.md#excluded-2c29326cfdf8c295), [mobile](../ARTIFACTS.md#excluded-760794b8978464fd), [downloaded report](../ARTIFACTS.md#excluded-b91c5e756ed4e3d5), [saved bootstrap](../ARTIFACTS.md#excluded-3166706ec5243a6b), [saved queue](../ARTIFACTS.md#excluded-d210f0bc96b1d193).

The original case database and its two SQLite companion files matched their earlier hashes. See the [preservation check](../ARTIFACTS.md#excluded-8ee7328fd021c609). The earlier £18 practice refund and £12 pending case were not edited; the preview now displays a separate synthetic rehearsal.

## Scope and remaining work

The busy pack passed all fifty engine scenarios and database preparation checks; its complete queue was not separately watched in the browser. The new focused browser run stopped before approval. Approval and duplicate-payment behaviour were exercised in the isolated automated tests, with the earlier browser payment run documented separately.

The sponsor handover is a small source, configuration and example pack. It is not a standalone application. The current app still runs on local SQLite. The [Supabase migration document](SUPABASE-MIGRATION.md) is an implementation plan, and the staging JSON is input for that future work. It is not a working Supabase schema or a direct operational import.

External account access, credits, available model and voice choices, deployed endpoints, actual database permissions and remote readback remain unverified. The [setup guide](ONLINE-SETUP.md) records the first authorised checks for each sponsor. Vercel preparation serves only a frontend with API requests unavailable; it does not host the refund workflow.
