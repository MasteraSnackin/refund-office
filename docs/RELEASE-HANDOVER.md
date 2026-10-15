# Offline release handover

The dated release is a portable source package for the current Refund Office demonstration. It includes the application, locked dependencies list, both synthetic catalogues, disconnected integration templates, the business-validation exercise, architecture maps and selected recorded test evidence. It contains no installed dependencies, Docker image, saved case database or account credentials.

The archive is created under `deliverables/releases/<release-id>/`. Each release gets a new directory. Existing packages, videos and case histories remain unchanged. `application-manifest.json` lists every included file and its SHA-256. The adjacent checksum identifies the ZIP, and `archive-verification.json` records its complete readback.

Archive verification checks inventory, file modes, CRC and every file hash. It does not establish that installation or the demonstration worked after extraction. Keep the clean-copy acceptance receipt beside the archive, bound to that exact ZIP hash. It must say which checks ran and what remains untested.

## Prerequisites

- Node.js with the built-in `node:sqlite` module. The source workspace uses Node 26.10.0; other versions have not been established by this release record.
- npm and a cache containing every dependency in `package-lock.json`, including the platform-specific esbuild package. The lockfile travels with the source; the cache does not.
- Python 3 for the package verifier and optional local document server.
- Docker running through a local Unix socket, with `postgres:16-alpine` already cached. The rehearsal refuses a remote Docker endpoint, does not pull the image and gives each run a separate local volume.
- Free local ports 4773 and 4774 for this clean-copy rehearsal. The ordinary judge launcher defaults to 4673 and 4674.

A fresh computer without cached prerequisites cannot complete an offline install. Preparing those dependencies is separate from connecting sponsor services. This package does not download or enable them automatically.

## Check and extract the release

Copy the ZIP and its matching `.sha256` file into an empty transfer directory. Check the checksum before extracting. On macOS, with the directory open in Terminal:

```sh
shasum -a 256 -c refund-office-offline-<release-id>.zip.sha256
mkdir refund-office-rehearsal
unzip refund-office-offline-<release-id>.zip -d refund-office-rehearsal
cd refund-office-rehearsal
```

Use the actual dated filename from the release directory. Extract into an empty directory, rather than over an existing checkout. This gives the rehearsal its own data directory and project identity.

## Install and check without network access

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run test:sites
```

The install uses only the npm cache. It deliberately skips dependency install scripts. The subsequent build checks whether the cached platform binary is usable. If any package is missing, stop and report the missing prerequisite; do not silently retry an online install.

Build before running the tests: the Sites checks inspect the generated files under `dist/`. The application tests use temporary fixtures and do not require the original `.data` directory or historical archives. Database suites are separate and require the cached PostgreSQL image. Their recorded results are included for inspection, but they are not rerun by `npm test`.

## Start a fresh rehearsal

```sh
node scripts/run-judge-rehearsal.mjs focused-12 --ports 4773 4774
```

Open `http://localhost:4773/` and choose the local reviewer profile. Using `localhost` keeps this browser session separate from existing previews opened at `127.0.0.1`. Ports alone do not isolate cookies: use a separate browser context if another rehearsal already uses `localhost`. These profiles are fictional test identities, not real Supabase sign-in. The launcher strips provider credentials from the child environment and forces local analysis with external connections disabled. No environment template needs to be filled in.

The queue investigates the twelve fresh synthetic cases. The expected starting result is six recommendations awaiting approval, five holds and one labelled historical remedy. Every new refund remains unapproved. The local PostgreSQL preview has no payment submission route.

Use the [three-minute rehearsal guide](DEMO-REHEARSAL.md). It covers the recommendation, clarification, evidence, report, Judge mode and reset. Inspection and playback must leave financial decisions unchanged. Stop at the human decision unless the user explicitly approves that exact refund.

Use **Reset demo** to retain the current run and start the same pack again. A fresh pack returns to profile selection. Previous evidence and decisions stay in their own saved run. An old tab or pending form cannot act on the replacement run.

Press Control-C in the launcher terminal when finished. It writes a verified checkpoint and preserves the owned rehearsal volume. The launcher prints the command needed to reuse that run. Reuse requires the same extracted source folder, pack, schema and saved identity; the launcher refuses a mismatch rather than resetting it.

For the larger synthetic office, replace `focused-12` with `busy-50`. Do not run both on the same ports at once. An occupied port causes a refusal; no running demonstration is stopped.

## Inspect the included evidence

The release's `START-HERE.md` links to `recorded-evidence/runtime/index.html`, which can be opened as a local file. It presents the recorded current PostgreSQL evaluation: 62 synthetic cases, 634 checks and 310 actual spans. The accompanying scorecards, observed results and trace metadata are included. They contain synthetic references and no saved customer history.

The model summary records 26 database check groups with injected OpenAI and Anthropic responses. Both suites checked the named source modules against before/after hashes. Their shared base checks overlap; the counts do not represent separate unique tests that should be added together. The evaluated tenants created no approvals or payment executions. Separate disposable harness fixtures exercised disabled approvals and reservations.

These are recorded local results. They establish neither live provider quality nor real Supabase authentication, account permissions, hosted deployment or Arize ingestion. The recorded runtime files are copied unchanged where possible; the summary removes machine paths and container identifiers. Their original relative source locations remain as provenance.

The interactive architecture maps and business study are also included. No retailer interviews or time savings have been measured. The study opens with empty results.

## Included and omitted artifacts

The archive excludes `node_modules`, generated builds, private `.data`, raw working histories, prior archives, videos and the original working logs. `ARTIFACTS.md` identifies references to those omitted artifacts. In packaged Markdown copies, a historical local link leads to that catalogue instead of appearing to be a file included in the ZIP. Links to the selected current evaluation lead to `recorded-evidence/`.

Code, datasets and configuration templates are copied byte for byte. Local Markdown link destinations are rewritten in the portable documentation copies. The recorded HTML report's database link points to its included summary and says that raw execution details are omitted. The manifest records each changed document's original hash and transformation. Source documents in the working project are preserved.

`npm run release:prepare` is for the source workspace with its original verification records. An extracted release can be installed, checked and rehearsed, but cannot regenerate the same recorded evidence from the sanitised summaries. To produce a new release after code changes, rerun the relevant checks and select their new records in the packager before packaging.

## Later account acceptance

The [hosted setup guide](HOSTED-SETUP.md) describes the separately authorised connection sequence. Keep all supplied templates at their offline defaults until account testing is authorised. A key alone is insufficient to enable a provider. Human review and the separate exact payment authorisation remain required after activation.
