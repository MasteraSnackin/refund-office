# Initial cloud database setup — 15 October 2026

The owner authorised a private first deployment with a fresh synthetic workspace, local analysis and payment submission disabled. This record covers the actual Supabase database setup. Vercel deployment and application account acceptance remain unfinished.

## Verified destination and schema

The new project is [refund-office-demo](https://supabase.com/dashboard/project/qokwlhvkkvcgioejgwnn), in the account selected by the owner. The dashboard reported Healthy, Free-plan organisation and West EU (Ireland). Automatic exposure of new tables was disabled during preparation. No other project was changed.

A read-only database preflight returned administrative user `postgres`, an absent `refund_runtime` schema and zero public base tables. The operational migrations were then applied as one transaction in this order: 001, 002, 003, 005, 007 and 008. The original outer transaction wrappers were replaced by one surrounding transaction and a fresh-schema guard. No application SQL body or test identity stub was substituted. Optional Stripe execution migrations 004 and 006 were omitted.

The exact bundle and source hashes are in [the local source manifest](../ARTIFACTS.md#excluded-1b13b7e79e7c4f7b). Its SHA-256 is `cfa8bb5084deb743ace1163688409ebbf41a45cd2c24303cfb95124611637f55`. The complete text copied back from the editor matched the prepared bundle before execution. The database returned `runtime-schema-installed`, 15 runtime tables and 15 public runtime RPCs.

An independent readback confirmed:

- All 15 runtime tables have row-level security enabled.
- `anon`, `authenticated` and `service_role` have no direct insert, update, delete, truncate, references or trigger table grants in the runtime schema.
- The optional payment-execution table is absent.

These are observed schema checks. They do not establish real application JWT behaviour, membership isolation or a successful hosted session.

## Imported synthetic pack

The existing [focused pack import](../ARTIFACTS.md#excluded-541c8e39a558c3e6) was copied into the editor, read back in full and compared before execution. Its source hash is `09b31a376d88e4c229d1586981480da5deafa77f4f4de7c6a0a4e446c365cebf`.

The import returned dataset `focused-12`, tenant `00000000-0000-4000-8000-000000000012`, 12 cases, 11 orders and `replayed: false`. Its canonical digest is `b9a6b27aa74160d48602987e0c6ddac962d512f21c043d54d279ba982b582087`.

A separate count query confirmed 12 cases, 11 orders and 12 queued requests, with zero approvals, zero memberships and zero new payment operations. One pre-existing fictional remedy was imported as explicitly labelled historical data. A further readback confirmed payment submission disabled and the optional executor table absent. No new refund was approved or submitted.

The [schema result](../ARTIFACTS.md#excluded-1a8fab6d68f8b4d7), [security result](../ARTIFACTS.md#excluded-e20f6d6f2dba9fa7), [import result](../ARTIFACTS.md#excluded-9dc4b9774ae6bec1), [count result](../ARTIFACTS.md#excluded-b7952abe57c378a9) and [payment-disabled result](../ARTIFACTS.md#excluded-311bbd8e1c413290) retain the visible readbacks. See the [import screenshot](../ARTIFACTS.md#excluded-65300fee61136ccf).

## Remaining work

The application Auth user was subsequently verified through a fresh database query: one application user exists, matching the selected owner account. An administrative transaction required that exact account to be confirmed before assigning reviewer membership to the synthetic tenant. It refused a conflicting existing role rather than replacing it. A separate readback returned exactly one reviewer membership; see the [role result](../ARTIFACTS.md#excluded-9eba953ef31ad9e4) and [access screenshot](../ARTIFACTS.md#excluded-9849c5b47f7af11e). The earlier creation form had remained stale, so its appearance was not used as the final account result. No application password was read or stored by the agent.

Application sign-in through the hosted API is still unverified. The investigator identity and bounded hosted processing path still need setup and verification.

Public sign-ups are disabled. A fresh dashboard reload confirmed that anonymous sign-ins are also disabled and email confirmation remains enabled; see the [saved authentication settings](../ARTIFACTS.md#excluded-373f6bd1f912b033). The initial workspace is limited to the owner's confirmed reviewer account.

The owner reported creating the one-day Vercel workspace token and subsequently authorised reading its one-time display, storing a private temporary copy outside the project, using it for deployment and removing the temporary copy. That display was not present in the available Vercel tab, and no file path has been supplied. No token value was read, printed, saved or used. The [latest deployment source](../ARTIFACTS.md#excluded-11661028cf429db0) built locally and retains its earlier verification scope.

No Vercel deployment URL or working application sign-in has been verified. Other provider actions, ElevenLabs transcription and Arize uploads remain disabled. Original local case databases and earlier source snapshots were not used as cloud imports.
