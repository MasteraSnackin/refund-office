# README architecture overview

This is a logical overview of the PostgreSQL application at [commit 716dff9](https://github.com/MasteraSnackin/refund-office/tree/716dff9f8a82b1d4c26ae207f8efdc78893deacb). The ten components carry 17 verified repository source references. The map does not claim that each box is a separately deployed service.

The normal local service chooses local rules using an empty provider environment. Its worker claims supplied synthetic records, obtains a proposal and passes it to SQL validation. Deterministic policy evaluation runs inside PostgreSQL; the separate checks box shows a logical responsibility, not a second process. The same transaction stores a hold, a recommendation awaiting approval or a labelled previous remedy.

The human reviewer records a decision through the interface and API. Approval binds the case revision, evidence fingerprint and amount; the local PostgreSQL path saves an unpaid reservation. The report is derived through the API from saved case records. Its arrow describes the report-building call, not an automatic publication or delivery to a customer.

OpenAI and Anthropic are explicitly selected optional proposal adapters. The local rule path makes no model call. The separate executor and Stripe branch describe prepared test execution: a new exact authorisation, saved intent, executor claim, submission and independent readback are required. Local previews cannot execute that branch. A prepared client and controlled tests do not establish account acceptance.

This snapshot does not assert the current state of hosting. Vercel/Supabase deployment and authenticated acceptance are assessed separately. The original SQLite simulator is another run mode; it is not the database shown here. Other saved-case adapters, tracing, chat and voice are described in [ARCHITECTURE.md](../../ARCHITECTURE.md).

The HTML supports optional finite animation and guided views. Motion illustrates the authored topology, not live traffic. The static PNG is a capture of this exact HTML, with no changed graph content. Download the HTML to use the interactive viewer; GitHub does not execute it inline.

Validation passed all nine showcase checks with zero errors or warnings. Automated browser checks passed at 1440×900, 1600×1000, 1920×1080 and 2048×1320. The saved light and dark images were inspected for readability, route clearance and balance. Interaction playback was not newly tested. See the [delivery receipt](readme-overview.delivery.json), [automated browser receipt](readme-overview.visual-check.json) and [visual review](readme-overview.review.json). Receipt workspace paths were normalised for publication; the specification and HTML hashes are unchanged.
