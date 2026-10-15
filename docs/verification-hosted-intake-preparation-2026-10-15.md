# Hosted intake preparation — 15 October 2026

This records a local interface correction and refreshed deployment source. It is not evidence of a Vercel deployment, Supabase account acceptance or a provider operation.

## Change and checks

[App.jsx](../src/App.jsx) passes the selected API's capabilities and worker status into [IntakeOffice.jsx](../src/IntakeOffice.jsx). The intake dialog describes an enabled local worker as automatic investigation. Hosted processing with its worker disabled says the request is saved for an authorised investigator, including the submit label, saved-request notice and empty state. Unconfirmed runtime scheduling does not promise background work.

The change does not start a worker, change role permissions or modify financial calls. The saved exact retry payload, request paths, polling, workspace/run storage scope and resume permission remain unchanged. Human approval remains mandatory.

| Check | Result and limit |
| --- | --- |
| Intake interface and state tests | Eight passed across the two focused test files. |
| Independent source review | No blocking finding; four interface tests also passed independently. |
| Local browser | The existing PostgreSQL investigator session displayed Local intake queue, background investigation, Submit and investigate and reviewer approval. The dialog was closed without submitting a request. |
| Refreshed source build | Passed using already installed dependencies with npm offline and ambient provider/Vite variables excluded. |
| Disabled hosted API | Session and voice-input requests returned HTTP 503 before consuming headers/body; the injected refusing fetch recorded zero requests. |

The [local intake screenshot](../ARTIFACTS.md#excluded-ab2764516270ce17) records the browser check. Hosted wording was exercised with controlled interface props, not a deployed account. No full application suite or new database suite was run for this display-only change.

## Deployment source

The new [combined assistant and hosted intake snapshot](../ARTIFACTS.md#excluded-11661028cf429db0) contains 95 regular source and asset files totalling 5,135,804 bytes. Its source digest is `bbce40f624ed9d6c5fd3b199dea8731bbcf8f4d1d4d868db1e52392f6faeb401`. All source, staged-byte and complete import-closure comparisons matched after building. The 67 generated artifacts are outside the deployable staging directory.

This snapshot contains the additional saved-case canvas, record-based chat and separately gated voice-input route. Earlier combined-assistant and combined-canvas snapshots were retained. Saved cases, credentials, working evidence and recordings are excluded from deployable source.

The [README](../README.md), [architecture](../ARCHITECTURE.md) and [hosted setup guide](HOSTED-SETUP.md) describe the distinction between the local automatic worker and the protected hosted investigation path. No architecture topology or database contract changed.

## Remaining acceptance

The first private deployment is authorised for a fresh synthetic workspace with local analysis and payment execution disabled. Correct Vercel workspace access and the exact Supabase project destination must be available before activation. A reviewer cannot investigate; configure a separate investigator identity and verify the bounded invocation before claiming intake reaches review online.

Actual account sign-in, membership isolation, refresh, revocation, API routing, function bundling, persistence and a synthetic intake-to-recommendation run still need live acceptance. Reset remains local-only. Other sponsor actions, ElevenLabs transcription and Arize uploads remain disabled unless separately activated. No refund was approved or submitted during this preparation.
