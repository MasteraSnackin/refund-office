# Case canvas verification — 15 October 2026

Case canvas is an additional read-only function. The miniature office remains the main screen, and financial decisions remain in the existing review workflow. The separate Playground Open Canvas project was not changed.

## Implementation and scope

The lazy [canvas component](../src/CaseCanvas.jsx) reads the existing saved provenance export. Its case, revision, workspace, run and transport checks reject mismatched or delayed results. Source references remain quoted text; supported case downloads use the existing authenticated download control. Moving a card changes in-memory layout only.

The native dialog returns focus to its opener when closed. [CanvasBoundary](../src/CanvasBoundary.jsx) contains loading and rendering failures so that the office remains available. [RuntimeAccess](../src/RuntimeAccess.jsx) retains its bound request function during an unchanged session check, while account, workspace, run, role, profile or generation changes invalidate it.

No new server route, database migration, case mutation, approval, payment or Miro publication was introduced by the canvas.

## Recorded checks

| Check | Observed result |
| --- | --- |
| Final application suite | 692 passed; no failures, skips or cancellations. |
| Final production build | Passed, including the separate canvas JavaScript and CSS chunks. |
| Focused canvas, boundary, session and reset checks | 58 passed, also rerun independently. |
| Independent source review | No remaining blocking finding after error isolation and stable-session fixes. |
| Protected original data and media | All 71 protected-file hashes unchanged. |
| Architecture map | Nine showcase checks passed, with no errors or warnings. |

The application suite was run after the build finished. These are local checks; they do not establish Vercel or Supabase account acceptance. No new database check was needed for this client-only extension. Earlier database results retain their original verification scope.

Logs and manifests are retained in [the application test log](../ARTIFACTS.md#excluded-044e48790c3cf846), [build log](../ARTIFACTS.md#excluded-aa5b4c015646e2fd), [focused session log](../ARTIFACTS.md#excluded-f97fe08115d4b375) and [preservation result](../ARTIFACTS.md#excluded-ca83a33da0b2ce00).

## Browser checks

The existing synthetic RF-2008 case displayed 19 records and 25 labelled connections. Searching for Sketchbook matched two source records, and the list view retained that search. The inspector showed the complete saved packing text and the relationship labelled “Gathered record; not cited by the saved proposal”. The case remained held, with a pending human decision.

Search, selection and a moved card position remained unchanged after 36.857 seconds, covering the application's 20-second session-check interval. The [timed result](../ARTIFACTS.md#excluded-6d6a3c39c6802930) records the before and after values. This followed a real browser finding: recreating the request function on each unchanged session check had reset the canvas. The transport regression tests and timed check exercise the correction.

Keyboard movement changed the original complaint card from left 32 to left 56. Pointer dragging then changed it to left 116, top 132. Background dragging changed the pan by 50 pixels horizontally and 25 vertically. Reset layout restored left 32, top 102. Arrow-key selection focused the next record fully within the canvas, with native viewport scroll still at zero. Escape returned to the office and restored focus to the Case canvas button.

An isolated local React fixture exercised both a rejected lazy import and a child rendering error. In both cases the sibling office remained visible, the canvas fallback omitted error details, and Back to office worked. The fixture is in the working evidence folder and is excluded from the deployment source.

The layout was inspected at an actual 822 × 1030 viewport. A requested 390-pixel viewport override did not apply; the measured width remained 822, so phone-width rendering is unverified. The final saved screenshot shows the currently selected RF-2003 case, also at saved revision 3; it is separate from the RF-2008 interaction test. No refund decision was made during these checks.

See the [office screenshot](../ARTIFACTS.md#excluded-35638a24edbb8fc6), [final canvas screenshot](../ARTIFACTS.md#excluded-4044ea5053f37f2d) and [user guide](CASE-CANVAS.md).

## Deployment status

The user authorised an initial owner-only Vercel and Supabase deployment with a fresh synthetic workspace, local analysis and disabled payment execution. Other sponsor adapters and Arize uploads remain disabled.

The [combined deployment copy](../ARTIFACTS.md#excluded-96f6a736536814af) contains 89 regular source and asset files. Its build and complete source-hash readback passed; its disabled API returned HTTP 503 without making an external request. The final source digest is `026d9ff40210d2a703225d547e343d587748d9764a1a3232903a0327ba22f1f0`. Credentials, saved cases, recordings and working evidence are excluded.

No Vercel deployment or Supabase migration has been performed. The user reported creating a Supabase project, but it was not found in the selected organisation; its exact dashboard URL has been requested. The Vercel CLI authenticated into a different account from the selected browser workspace. Those temporary CLI logins were ended, and a one-day workspace token form was prepared for the user's review and creation. No token was created by the agent or copied into the project.

After the destination and correct account access are confirmed, database setup, reviewer membership, application sign-in, function routing, persistence and the hosted case workflow still require verification. A successful local build is not a working online deployment.
