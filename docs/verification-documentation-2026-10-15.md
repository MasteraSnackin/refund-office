# Documentation brief completion, 15 October 2026

This record covers the two Desktop documentation briefs applied to Refund Office. The briefs remain unchanged. The outputs are the project [README](../README.md), [architecture document](../ARCHITECTURE.md) and refreshed [interactive system map](diagrams/sponsor-runtime.html).

## README brief

| Requirement | Delivered location or treatment |
| --- | --- |
| Project title and one-line tagline | Opening title and tagline |
| Optional badges | Omitted because no public build or licence badge is established |
| Description, audience and problem | Description |
| Linked table of contents | Table of contents |
| Capabilities | Features |
| Technologies | Tech stack |
| Architecture and inline Mermaid | Architecture overview, with an explanation and links to the interactive maps |
| Setup from the project folder | Installation, including the verified Node runtime, locked install and local launch |
| Practical operation and examples | Usage, including investigation, queued packs, canvas, review and isolated rehearsals |
| Environment and settings | Configuration, with links to the full setup contracts |
| Screenshot and demo | Screenshots / demo, with the recorded version boundaries |
| API and CLI examples | API / CLI reference, including read-only requests and the differing runtime contracts |
| Test framework and commands | Tests, with build-before-test ordering and historical verification scope |
| Optional roadmap | Roadmap |
| Contribution process | Contributing, with the unavailable public repository URL stated plainly |
| Licence | Licence, with the missing project licence and LICENSE file identified |
| Maintainer and support | Contact / support, with a labelled placeholder rather than an invented identity |

## Architecture brief

| Required section | Coverage |
| --- | --- |
| Title and Overview | System Architecture: Refund Office, followed by the system's purpose and current hosting limits |
| Key requirements | Financial authority, saved evidence, exact decisions, bounded work, isolation and recovery |
| High-level architecture | Components, inline Mermaid and its explanation |
| Component details | Responsibilities, technology, owned state and communication for 15 major components, plus detailed subsections |
| Data flow | Investigation/review sequence, clarification, canvas/transcription, external writes and readback |
| Data model | Main entities and their relationships |
| Infrastructure and deployment | Separate SQLite, PostgreSQL, clarification/Judge and prepared hosted paths |
| Scalability and reliability | Claims, bounded work, uncertain results, recovery and unmeasured production limits |
| Security and compliance | Actual access controls, secrets, provider opt-ins, privacy and certification limits |
| Observability | Actual events, local traces, synthetic evaluations and disabled Arize export |
| Trade-offs and decisions | Store separation, deterministic checks, review/execution roles and retained uncertainty |
| Future improvements | Authorised hosting acceptance, separately approved providers, operational checks and retailer validation |

The required sections appear in the order specified by each brief. Humanizer was applied to the prose. Product names, technical identifiers and material evidence limits were retained.

## Source review and corrections

An independent read-only review checked the documentation against the actual entrypoints, launchers, repositories, authentication, provider boundaries, case canvas and voice-input code. It found no blocking issue in the completed structure or capability descriptions.

The documents distinguish the unauthenticated original SQLite API from local test sessions and the prepared Supabase session flow. They distinguish an unpaid PostgreSQL reservation from optional separately authorised Stripe test execution. Canvas chat reads saved records without a model request. Speech input uses a separate consented route available in the PostgreSQL and prepared hosted APIs, rather than in the legacy API or the saved-briefing action ledger.

A newly completed [chat and voice record](verification-canvas-chat-voice-2026-10-15.md) was incorporated during this review. Its saved 761-test checkpoint and 95-file combined-assistant preparation are separate from the earlier 692-test canvas checkpoint and canvas-only staging. The application suite was not rerun for this documentation change. Neither saved checkpoint establishes live transcription or a usable hosted deployment.

The licence, public repository, support channel and usable hosted URL remain unspecified or unverified. No replacement details were invented.

The user also requested inclusion of the concurrent bounded Claude investigator and Demo brief as work in progress. Their design notes remain under Component details, with the [Claude proof guide](CLAUDE-RUN-PROOF.md) and [judging plan](JUDGING-PLAN.md) linked separately. They are outside the checked chat-and-voice checkpoint and enclosed recorded run. This review does not claim a successful real Claude execution.

## Diagram delivery

The refreshed map preserves all 12 component identifiers and the existing financial authority boundaries. It adds two source-backed relationships: the optional selected main investigator calling a model, and the API's separate consented transcription route. Provider edges describe prepared call sites, not observed traffic. The [source notes](diagrams/sponsor-runtime.sources.md) identify the implementation and its limits; this working folder has no commit/origin pair for pinned repository verification.

The final [typed JSON](diagrams/sponsor-runtime.architecture.json), [delivery receipt](diagrams/sponsor-runtime.delivery.json), [validation receipt](diagrams/sponsor-runtime.validation.json), [automated browser receipt](diagrams/sponsor-runtime.visual-check.json) and [review record](diagrams/sponsor-runtime.review.json) accompany the self-contained HTML.

- Deterministic validation and delivery: nine of nine checks passed, zero errors and zero warnings.
- Automated browser evidence: passed at 1440 by 900, 1600 by 1000, 1920 by 1080 and 2048 by 1320 pixels.
- Perceptual visual review: light 1440 by 900 and dark 2048 by 1320 screenshots inspected; the added routes, labels, cards and overall layout remained readable.
- Manual interaction: search, node focus, connected-relationship navigation, guided payment-authority view, return to overview and theme switching checked in the in-app browser at 1280 by 720 pixels.
- Correction rounds: one focused route correction after the initial added-edge candidate reported a crossing and label clearance issue.

BrowserOS tools were unavailable. The initial attempt to use the prior application preview received a connection refusal, so the map interaction check used a separate loopback documentation server. No application workflow or financial record was changed by that check.

## Final documentation checks

The [check result](../ARTIFACTS.md#excluded-f5590a8800257ae3) records section order, Markdown links and anchors, referenced package scripts, source-brief hashes and prose checks. The [Mermaid results](../ARTIFACTS.md#excluded-24ccafc08425a800) record local rendering of the three inline diagrams. A semicolon in the unquoted sequence-note text initially failed parsing; replacing it with a full stop corrected that diagram without changing the described behaviour.

All three final inline Mermaid diagrams rendered successfully. The current four-document link and anchor check passed, and both original Desktop brief hashes matched. The application build and full test suite were not repeated for this documentation-only change.

Only documentation, diagram outputs, their checks and requested submission artifacts were authored for this task. No sponsor was activated, no cloud deployment was performed, and no refund decision was recorded.
