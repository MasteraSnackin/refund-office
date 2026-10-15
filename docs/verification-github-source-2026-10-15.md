# GitHub source verification, 15 October 2026

This record covers the clean source copy prepared for the private [MasteraSnackin/refund-office repository](https://github.com/MasteraSnackin/refund-office). It does not replace earlier feature or provider acceptance records.

## Checks completed

- The production build completed, including the static Sites assets and case-canvas bundle.
- The complete application test command passed all 834 tests, with no failures, cancellations or skipped tests. This final run includes the hosted receipt updates captured during preparation.
- Source review excluded credentials, filled environment files, private databases, saved case histories, dependencies, generated builds, raw working captures and old delivery archives.
- The upload includes both committed synthetic packs, the README, architecture documents, five animated GIFs, their MP4 and JPG alternatives, the gallery, and the labelled historical demo film.
- All relative Markdown links in the prepared copy resolve. References to omitted local artifacts lead to [the artifact catalogue](../ARTIFACTS.md), which states their availability instead of supplying missing evidence.

## Dependency and runtime scope

Checks ran with Node.js 26.10.0 and npm 11.19.1. An offline `npm ci` could not find the locked Lucide package in the local cache. No online retry was made. The existing local dependency installation was copied into the separate check directory, excluded from Git, and used for the successful build and test run. This record therefore does not claim a successful clean installation from the registry.

Provider credentials were removed from the build and test command environments, and the application network setting was offline. The tests use controlled fixtures and responses; their results do not establish provider account acceptance. The separate PostgreSQL integration suites, hosted sign-in and deployment acceptance were not rerun for this upload.

The original rehearsal application, its saved case databases and previous archives were not modified by preparing the GitHub copy. Human approval remains required for every new refund.
