# Synthetic demonstration packs

Two reproducible datasets for **Paper Harbour Demo Shop**, a fictional GBP merchant. They contain no real customers, contact details, credentials or external payment references.

| Pack | Cases | Orders | Ready for human approval after investigation | Held for review | Already resolved from labelled history |
| --- | ---: | ---: | ---: | ---: | ---: |
| [Focused demonstration](focused-12.json) | 12 | 11 | 6 | 5 | 1 |
| [Busy office](busy-50.json) | 50 | 46 | 26 | 20 | 4 |

These are initial investigation outcomes under the supplied £25 policy, before anyone approves a new refund. All imported cases start ready, with no approval, receipt or prefilled policy pass. The local intake worker investigates them and stops at human review. The historical-remedy cases refer to separate, explicitly seeded local fixtures; they do not invent a current approval or a provider API result.

Use the focused pack for the main demonstration and the busy pack to show a larger queue. See [the scenario guide](SCENARIOS.md) for the three-minute path and the repeat-claim experiment. The project [README](../README.md) describes the local launchers and isolated databases. Do not merge either pack into an existing operational database.

## Files

- [focused-12.json](focused-12.json): complete focused catalogue, policy, cases and one historical local operation.
- [busy-50.json](busy-50.json): complete busy catalogue, policy, cases and four historical local operations.
- [expected-outcomes.csv](expected-outcomes.csv): every case, category, expected initial outcome, expected proposed amount and conditional duplicate follow-up.
- [n8n-intake.focused-12.json](n8n-intake.focused-12.json) and [n8n-intake.busy-50.json](n8n-intake.busy-50.json): local intake payload examples. No n8n connection is required to read or test them.

Each dataset has `schemaVersion: 1`, an explicit synthetic merchant and orders, policy, basic case seeds, labelled historical operations and scenario expectations. The case labels are in the RF-2000 range and internal references start with `SYN-`. All prices are integer pence and every order total equals its ordered quantities multiplied by unit prices.

`expectedAmountMinor` is the analyser's proposed amount after investigation. It is not an amount already paid. A held £25.01 case still has a £25.01 proposal; a disputed or unsupported request has no supported proposal. A historical case can identify the original missing-item value while requiring £0 of additional refund.

## Stable intake examples

The event reference is `demo-{dataset.id}-{case.id}`. It matches the imported queue record, so sending the same example to that pack's local intake API returns the existing case instead of creating another one. Preserve the event reference and exact payload after an uncertain response.

The example files are arrays of request objects. Send one object per intake request; they are not batch endpoint payloads. They target the custom orders in the corresponding pack, not the default five-order catalogue. The prepared n8n workflow remains inactive and disconnected. Importing examples or seeing their filenames does not mean n8n has executed anything.

## Reproduce and check

From the application directory:

```sh
node scripts/generate-demo-data.mjs
node --test tests/demo-data-packs.test.mjs
```

Generation only rewrites the two pack files, two example files and expected-outcomes CSV in this directory. It does not open a database, run the application, call a provider or create approval decisions. The generator uses fixed inputs and a fixed historical-fixture timestamp.

The checks use temporary in-memory stores and the real local analyser and workflow engine. They verify all 62 initial outcomes and proposed amounts, confirm zero new payment calls during investigation, replay all 62 intake examples without extra cases, and exercise all five duplicate pairs after an explicit synthetic test approval. The latter tests use the local simulator only. They are not evidence that Stripe, n8n, Supabase or any other external service works.
