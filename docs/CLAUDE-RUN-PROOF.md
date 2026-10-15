# Claude investigation and run proof

The judging rubric requires a real Claude-powered run. The bounded tool investigator is implemented and covered by controlled-response tests. The user chose to keep the key in Vercel only. Real requests must wait for the hosted setup, private server-side Secret and account acceptance; do not copy the key locally. Do not present the controlled fixtures or an older local-rules evaluation as that run.

## What Claude does

One investigator receives the fictional complaint and a catalogue of available evidence identifiers. Claude chooses calls to `read_order` and `read_evidence`, then calls `submit_recommendation` with an exact item, amount, concise justification and evidence citations. The read tools return only the supplied immutable snapshot. They cannot fetch a URL, change a record, contact a customer, approve or submit a refund.

The application requires completed reads, known citations and a catalogue-matching amount. The existing claim and clarification validator checks ambiguity and conflicting statements. The ordinary deterministic policy checks then decide whether the recommendation can reach human review. These are real handoffs between a model, application controls and a person; they are not a team of independently running office characters.

The existing single-response Anthropic adapter remains available. Tool mode requires an explicit additional setting. There is no silent switch from Claude to local rules after an error.

## Vercel key setup

For the selected Refund Office Vercel project, open **Settings → Environment Variables** and add `ANTHROPIC_API_KEY` as a **Secret**. Enter its value privately in Vercel. Do not put a filled `.env` file in the deployment source, use a `VITE_` variable for it, or paste the value into chat. Browser code must call the authenticated application API; only the server calls Anthropic.

Select the intended deployment environment. Changes apply to a new deployment, not an existing one. See [Vercel environment variables](https://vercel.com/docs/environment-variables) and [Config and Secret values](https://vercel.com/docs/environment-variables/sensitive-environment-variables).

The remaining Anthropic settings are ordinary configuration values:

| Name | Value for the deliberately enabled Claude path |
| --- | --- |
| `REFUND_OFFICE_NETWORK` | `enabled` |
| `REFUND_OFFICE_ANALYSER` | `anthropic` |
| `REFUND_OFFICE_ANTHROPIC_MODE` | `tools` |
| `ANTHROPIC_MODEL` | An explicit available Claude model identifier |
| `REFUND_OFFICE_ENABLED_INTEGRATIONS` | Include `anthropic`; the hosted database path also needs its existing `supabase-runtime` setting |

Choose a model from the current [Anthropic model reference](https://platform.claude.com/docs/en/models/overview), then verify it against the authorised account. No model is silently selected by the application. The key does not complete Supabase setup, reviewer membership, Vercel routing or a deployed acceptance test. Follow [hosted setup](HOSTED-SETUP.md) for those separate prerequisites.

Leave payment execution, unrelated sponsors and Arize uploads disabled. The user authorised up to three short investigations of supplied synthetic records; this is not permission to transmit real customer information.

## Isolated local proof runner

The local proof runner is implemented and checked with controlled responses. It is not the selected route for the real test: the user chose Vercel only. The command below documents the runner's contract for a separately authorised future change of setup; do not use it for live calls under the current preference. It does not load `.env` files, and a key held only in Vercel is not available to this local process.

After the configuration and synthetic transmission permission are in place:

```sh
npm run proof:claude -- --authorised-synthetic
```

No key belongs in this command. The runner creates a fresh private directory under `work/claude-proofs/` and its own synthetic SQLite database. It investigates exactly these three supplied cases:

| Case | Expected useful result |
| --- | --- |
| RF-2001 | A £20 recommendation waiting for a human decision |
| RF-2004 | A £25.01 proposal held by the £25 policy limit |
| RF-2008 | A hold because the complaint does not identify which missing item is claimed |

The runner does not approve a case, create a reservation, call a payment provider, upload traces or edit an existing rehearsal. An authentication or investigation error ends the run before the next case; there is no model retry. A mismatching result remains a failed proof rather than being rewritten to match the expectation.

The tool loop allows at most four model requests and twelve tool calls per investigation, with 1,000 output tokens per request, a 20-second total deadline and an 8,000-token reported-usage limit. The runner permits at most twelve Messages API requests across its three cases, exclusively to Anthropic. These limits bound the rehearsal; they do not guarantee a model will finish before the deadline.

## What to retain for judges

The resulting `index.html` links the observed result, readable decision brief, saved packet, execution receipts and source hashes. The runner closes and reopens its database and compares the saved cases before reporting successful persistence. Its manifest distinguishes `controlled-test` from `provider-response`, records whether expectations matched and reports approval, operation and payment-attempt counts.

Receipts retain the actual returned model, message/request identifiers when supplied, token usage, operation times, tool names and validation outcome. They do not retain private model reasoning, raw provider bodies, customer statements, tool inputs or API keys. The decision packet separately contains the explicitly fictional records needed to inspect the result.

A provider receipt is locally captured execution metadata, not independent third-party attestation. One passing three-case run supports a demonstration of those cases; it does not establish general accuracy, customer demand, payment movement or deployment. Saved receipts in the investigator are bounded request-local memory. The isolated runner writes them to disk; durable hosted receipt storage is a separate deployment task.

For the table demonstration, use the [five-minute judging plan](JUDGING-PLAN.md) and the read-only **Demo brief** in the office. Show the actual model evidence and distinguish it from the application policy checks and the human decision.
