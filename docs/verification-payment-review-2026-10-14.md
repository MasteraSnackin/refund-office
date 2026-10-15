# Payment review interface verification, 14 October 2026

Status: passed locally. Sponsor accounts remain disconnected.

This record covers the separate reviewer authorisation screen and saved execution result view. The existing rehearsal remains on its original database schema, with payment submission disabled. Checks use fictional interface responses and a disposable local database; they do not establish Stripe or Supabase account acceptance.

## Scope

- Read the exact original approval, current case revision and unpaid reservation before offering a new authorisation.
- Require the reviewer to bind a test account and payment reference, enter a reason and confirm the exact amount.
- Retain the original request when its outcome is uncertain; inspect or retry that same decision rather than offering a replacement.
- Keep payment execution and reconciliation restricted to the separate executor identity.
- Distinguish an authorisation, submission intent, an unknown outcome, a pending refund and a saved receipt.
- Preserve all existing rehearsal cases, original data files and earlier source archives.

## Verification

| Check | Result | Scope |
| --- | --- | --- |
| Application tests | 358/358 passed | Includes 18 payment-screen interaction checks and reservation wording regression coverage |
| Local PostgreSQL | 47/47 passed | All six migrations together, including reviewer lookup, role/tenant boundaries, stale approvals, duplicate protection, sessions and saved receipts |
| Build | Passed | Application and Sites output generated |
| Sites checks | 4/4 passed | Static packaging boundaries remain intact |
| Independent source review | No concrete findings | Approval, tenant scope, exact retries, stale callbacks and result verification |
| Architecture map | 9/9 showcase checks; zero errors or warnings | Automated desktop captures and inspected light/dark views; manual interaction tests were not repeated |

The database run made 700 SQL round trips and exercised 149 expected rejections. All 32 recorded source/input hashes matched before and after the run. It used a new network-disabled container without existing data mounts and removed it afterwards. Its evidence is under `work/payment-review/database/`; the local database identity stub is not a real Supabase authentication test.

The browser rehearsal exercised the production component with clearly labelled fictional responses: an explicit form decision, an unpaid authorisation, a lost response with exact retry, recovery after reload, and uncertain, pending, failed and succeeded result states. No execution or reconciliation control was offered to the reviewer. The existing office displayed the disconnected explanation and its unchanged £20 recommendation awaiting approval. BrowserOS tools were unavailable; these checks used the in-app browser.

[Authorisation form](diagrams/payment-authorisation-form.png) · [Unconfirmed decision](diagrams/payment-authorisation-unconfirmed.png) · [Fictional saved result](diagrams/payment-authorisation-result.png)

All twelve existing rehearsal case objects are unchanged. All fifteen original data files and all four earlier source archives retain their recorded hashes. No current case was approved, no reservation was added and no payment was created. The running office still uses migrations 001 and 002 with external services disabled.

Run `node scripts/preview-payment-review.mjs` for the separate fictional interface rehearsal on port 4373. It uses disposable in-memory examples, makes no provider calls and has no connection to either case database. The page is excluded from the normal application entry point. Its canned results demonstrate interface behaviour, not payment execution.

Run `node scripts/test-payment-review.mjs` for the explicit disposable database checks. It exercises migrations 001 through 006 without modifying a running rehearsal. The earlier [sponsor wiring verification](verification-sponsor-wiring-2026-10-14.md) remains a historical record of the preceding implementation.

Real provider credentials, Supabase sign-in and permissions, a Vercel deployment and Stripe test-account behaviour remain unverified. A later account test still needs explicit activation and a new exact reviewer authorisation.
