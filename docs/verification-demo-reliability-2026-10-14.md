# Demo reliability and readable output verification

Checked locally on 14 October 2026. This work changes the Judge rehearsal launcher and the PostgreSQL/prepared hosted report presentation. Sponsor services and Arize remain disconnected. No new refund was approved or submitted.

## What changed

Reset now updates the Judge launcher's current run, saved status and restart command. Each port pair has its own metadata file and Vite cache. Failed or unresolved reset states withhold a restart command, including a failed final journal write after a replacement handle has been created. Metadata write failures warn without changing the reset result. If the interface fails to close, the launcher still stops the backend and returns failure; it does not publish a successful shutdown.

The local PostgreSQL and prepared hosted decision reports use readable descriptions derived from saved evidence, saved policy-check explanations and exact source identifiers. They distinguish gathered records from the current proposal's citations and identify missing cited records. A JSON appendix preserves the original evidence bodies. Supplied Markdown cannot create a heading, image or code fence inside the report's main text.

Reports and text briefings distinguish the current refund approval from earlier human review events. An earlier request for evidence remains in history after clarification, while the new recommendation still requires approval. Hosted reports keep separate payment execution outside their evidence scope.

The [example decision brief](demo/decision-brief-example-2026-10-14.md) is copied unchanged from the final database test. It contains a fictional sketchbook clarification, the earlier evidence request and a £10 recommendation awaiting approval. It is a saved test artifact, not the current state of another running office.

## Checks and evidence

| Check | Result | Scope |
| --- | --- | --- |
| Application build | Passed | Interface bundle and Sites build preparation |
| Complete application suite | 601 passed, 0 failed | Includes 22 new report and launcher regressions; baseline was 579 |
| Independent focused review | 35 passed, 0 failed | Reset controller, launcher lifecycle and report tests; no blocking findings remained |
| Real local PostgreSQL rehearsal | Four complete scenarios passed | Two concurrent Judge offices, clarification and output, two resets, stop and restoration of the latest run |
| Preserved files | All 71 checked entries unchanged | Original data, earlier releases, handover files and videos |
| Original Judge office | Cases and intake unchanged | Same twelve cases and original run identity |

The final database test used four fresh owned runs on ports 5073/5074 and 5173/5174. Each verified checkpoint contained zero approvals and exactly one labelled historical seed operation. There were no new operations. The test recorded zero non-local fetch attempts, kept providers disabled and used the cached PostgreSQL image with database networking disabled. Its temporary containers and volumes were removed after their checkpoints were verified; existing rehearsal volumes were not removed.

The readable-output scenario saved a fictional request for evidence and a received clarification, then let the local worker investigate again. It downloaded the report and briefing and checked that reading them left the saved case unchanged. Reset tests verified that the other office's metadata did not change, that the current identifier followed each reset, and that restoring the latest run recovered the same cases exactly.

The unit tests additionally cover failed checkpoint/launch/final-journal writes, passive observer failures, metadata ownership, literal custom-directory arguments, inert launcher imports, failed interface shutdown and signal exit status. Report tests cover current and historical review states, malformed evidence, unknown citations, exact evidence recovery and supplied backtick/tilde fences.

Local evidence files:

- `work/continuous-improvement-2026-10-14/final-build.log`
- `work/continuous-improvement-2026-10-14/final-tests.log`
- `work/continuous-improvement-2026-10-14/judge-lifecycle-final.log`
- `work/continuous-improvement-2026-10-14/preservation-final.json`
- `work/judge-lifecycle/2026-10-14T22-16-47-289Z-5lFLrD/verification.json`
- Source digest for that database run: `edcc1ccbe555e8c8cf4040b822881c3e123bc9c32903d7e7e54910c3604c307c` across 30 exercised source files.

## Use and limits

Follow the [rehearsal guide](DEMO-REHEARSAL.md#check-the-result-and-stop-cleanly) for current restart and recovery instructions. The old shared `judge-preview.json` is historical and is no longer updated. The new status files are handover aids, not liveness checks.

The README, architecture and operating guide describe these changes. Earlier handover archives, films and example reports remain unchanged and retain their original version scope. This round did not regenerate or relabel those archives. Prepared hosted report routes were exercised with controlled local records; no hosted account, live model, external payment or provider acceptance was tested.
