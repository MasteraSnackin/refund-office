# Refund Office map sources and checks

[Open the system map](refund-office.html). The [typed JSON](refund-office.architecture.json) is the editable source. This map describes the local implementation inspected on 13 October 2026. It is a component and dependency map, not a trace of runtime traffic.

## Scope

The office interface is a React application. Its desks and characters present one in-process workflow engine. The API, engine functions, analyser and refund adapter are logical roles in a single Node service. SQLite and the synthetic order fixtures are local data sources.

The local analyser and payment simulator are the default path. OpenAI and Stripe paths exist in source, but this documentation work did not connect to either provider. The Stripe adapter is limited to test keys. The Sites package is a prepared static hosting variant: its asset worker does not implement the API or SQLite service.

## Local source evidence

| Map role | Source | What it establishes |
| --- | --- | --- |
| Office interface | [src/api.js](../../src/api.js#L1), [src/App.jsx](../../src/App.jsx#L73) | The client uses fetch for `/api` requests. It schedules the next advance while a case is running. |
| HTTP API | [server/index.mjs](../../server/index.mjs#L29) | Node `node:http` routes call the in-process engine. |
| Workflow and evidence | [server/engine.mjs](../../server/engine.mjs#L67) | Evidence and deterministic policy evaluation use synthetic order facts. |
| Approval | [server/engine.mjs](../../server/engine.mjs#L268) | The approval and refund-operation reservation share a SQLite transaction. |
| Refund execution | [server/engine.mjs](../../server/engine.mjs#L152) | Execution checks approval against the current proposal, saves pending submission before calling the provider, and records the result. |
| Human wait | [server/engine.mjs](../../server/engine.mjs#L351) | A new refund waits for explicit human approval before payment. |
| SQLite store | [server/store.mjs](../../server/store.mjs#L6) | The synchronous SQLite store uses WAL and keeps cases, settings and operations. A unique order, line and issue prevents duplicate reservations. |
| Synthetic records | [server/fixtures.mjs](../../server/fixtures.mjs#L1) | Local order fixtures and seed cases supply the demonstration data. |
| Analysis adapter | [server/providers.mjs](../../server/providers.mjs#L59) | Local mode avoids a remote analysis request. Optional model analysis uses the OpenAI Responses API. |
| Refund adapter | [server/providers.mjs](../../server/providers.mjs#L125) | The provider object supports the local simulator, Stripe test submission and result reconciliation. |
| Static hosting variant | [worker/index.js](../../worker/index.js#L1), [scripts/prepare-sites-build.mjs](../../scripts/prepare-sites-build.mjs#L1) | The worker serves `env.ASSETS` and an HTML fallback; the build script prepares that package. |

The map uses ordinary file references. It has no repository origin and commit declaration, so the Archify delivery receipt does not verify commit-pinned source blobs. The legacy `src/workflow.js` helper is excluded from the runtime map because the running client does not import it.

## Behaviour and limits

- The browser drives case advances. The local application has no independent background scheduler.
- Every new refund needs an explicit local review decision. The reviewer name is a local label, not an authenticated identity.
- Approval binds a proposal revision and fingerprint. Payment submission rechecks that decision and persists the operation before contacting a provider.
- SQLite WAL and duplicate-operation constraints do not establish distributed availability, production throughput or an immutable audit log.
- External adapters and static hosting files show implementation intent. They do not prove configured credentials, connectivity, a deployed backend or successful live money movement.

## Validation and review

The [validation result](refund-office.validation.json) and [delivery receipt](refund-office.delivery.json) report 9 of 9 showcase checks, zero composition errors and zero warnings.

The [automated browser receipt](refund-office.visual-check.json) reports `pass`. It checks desktop containment at 1440 x 900, 1600 x 1000, 1920 x 1080 and 2048 x 1320. It also captures light and dark themes at the smallest and largest sizes. The [contact sheet](refund-office.visual-check.html) opens those captures.

Perceptual review passed after inspecting all four screenshots for text fit, route clarity, card layout and balance. Two correction rounds reduced vertical spacing, shortened explanatory cards and clarified that synthetic orders are JavaScript constants. Node identities and relationships were preserved.

Manual search, component focus, route tracing and a guided view passed in the Codex browser. Searching for SQLite returned one node; focus opened its relationship card; the human-controlled refund chapter showed six stops; and tracing the interface to SQLite resolved four nodes and three directed relationships. The [interaction record](refund-office.interactions.json) binds these checks to the delivered HTML. These are viewer checks, not evidence of runtime traffic.

| Receipt field | Value |
| --- | --- |
| Diagram type | `architecture` |
| Specification SHA-256 | `27bde125d2ebb93f0971d0b2b1854fc2307949783fbd31205bc2bf4e0c155a7b` |
| HTML SHA-256 | `af059bfb2527a3231283d5b98220546e333fbb7b5c21542b6896982a3912f3d8` |
| Deterministic validation | `9/9 showcase, 0 errors, 0 warnings` |
| Automated browser evidence | `passed` |
| Perceptual visual review | `passed` |
| Visual correction rounds | `2` |
