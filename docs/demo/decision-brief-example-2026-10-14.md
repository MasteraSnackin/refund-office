# RF-2008 — Two missing lines, unclear claim

Local PostgreSQL rehearsal · synthetic records · payment submission disabled

Saved revision: 7
Outcome: awaiting-approval
Proposed amount: £10.00

Evidence and policy checks passed\. A human reviewer must approve the exact saved amount\.

## Complaint

Some items are missing from my order\. Please check the packing record\.

## Investigation

The complaint reports a missing item and the packing record omits 1 × Sketchbook\. The proposed amount is taken from the order price\. The recorded customer clarification was considered alongside the original complaint\.

Evidence references cited by the saved proposal: order:SYN-F12-O008, packing:SYN-F12-O008, clarification:5950e29e-8f79-404c-9ea9-e3ed445f965a.

## Saved policy checks

These are saved investigation checks, not current payment results.

- One supported missing item [missing-item]: pass. The saved proposal identifies a missing item with a positive value\.
- Packing evidence cited [evidence]: pass. The saved proposal cites the packing record and only known evidence references\.
- Exact missing-item value [amount]: pass. £10\.00 matches the missing quantity and unit price in the saved check\.
- Delivery undisputed [delivery]: pass. The saved delivery record did not mark a dispute\.
- Within policy limit [limit]: pass. £10\.00 passed the policy limit check when this investigation ran\.
- No existing remedy [duplicate]: pass. No existing remedy for the proposed order line and issue was found when this check ran\.
- Within remaining order balance [balance]: pass. £10\.00 was within the remaining order balance when this check ran\.
- Recorded clarification matches the selected item [clarification]: pass. Recorded clarification matches the selected item was recorded as passed\.

## Human decision

Current refund approval: required for £10\.00 and has not been granted\.
No current review decision is attached to this case state\.
Saved review history contains 1 event\. Those records are preserved below and do not grant current refund approval\.
Original operation: None recorded

## Payment result

No payment was submitted or made.

## Saved evidence

The readable descriptions below come from the saved evidence snapshot. Citation labels refer only to the current saved proposal, not earlier investigation events.

### Customer clarification

Evidence reference: clarification:5950e29e-8f79-404c-9ea9-e3ed445f965a
Use in this saved proposal: Cited by the saved proposal.
Source: Customer clarification recorded by reviewer

The sketchbook is the missing item I am claiming\.

Selected order line: SYN-F12-O008-L1
Source reference: Synthetic judge lifecycle reply
Recorded by: 40000000-0000-4000-8000-000000000001
Recorded at: 2026-10-14T22:16:55\.482392\+00:00

### Customer complaint

Evidence reference: complaint:SYN-F12-C008
Use in this saved proposal: Gathered record; not cited by the saved proposal.
Source: Synthetic intake

Some items are missing from my order\. Please check the packing record\.

### Synthetic delivery record

Evidence reference: delivery:SYN-F12-O008
Use in this saved proposal: Gathered record; not cited by the saved proposal.
Source: Synthetic catalogue

Recorded delivery status: delivered\. The record does not mark a delivery dispute\. Synthetic parcel received\. Quantities below are the supplied fictional packing record\.

### Synthetic order

Evidence reference: order:SYN-F12-O008
Use in this saved proposal: Cited by the saved proposal.
Source: Synthetic catalogue

Synthetic order SYN-F12-O008: £18\.00 total\. Items ordered: 1 × Sketchbook at £10\.00 each; 1 × Marker set at £5\.00 each; 1 × Paper clips at £3\.00 each\.

### Synthetic packing record

Evidence reference: packing:SYN-F12-O008
Use in this saved proposal: Cited by the saved proposal.
Source: Synthetic catalogue

Sketchbook: 1 ordered, 0 recorded as packed; 1 unit is not recorded as packed\. Marker set: 1 ordered, 0 recorded as packed; 1 unit is not recorded as packed\. Paper clips: 1 ordered, 1 recorded as packed; all ordered units are recorded as packed\.

### Saved remedies

Evidence reference: remedies:SYN-F12-O008
Use in this saved proposal: Gathered record; not cited by the saved proposal.
Source: Operational database

No earlier remedies or reservations were recorded for this order when the investigation gathered this evidence\.

## Recorded history

History is shown in saved append order. Earlier review events do not grant current refund approval.

- 2026-10-14T22:16:48\.609324\+00:00 — Synthetic intake imported: Fresh case saved; no human decision or payment imported\. Event reference: 8. Recorded actor: Not recorded.
- 2026-10-14T22:16:51\.361518\+00:00 — Investigation claimed: Saved catalogue evidence; no approval or payment\. Event reference: 27. Recorded actor: 40000000-0000-4000-8000-000000000003.
- 2026-10-14T22:16:51\.419647\+00:00 — Local investigation finished: Saved recommendation and deterministic checks; human review required\. Event reference: 28. Recorded actor: 40000000-0000-4000-8000-000000000003.
- 2026-10-14T22:16:55\.329764\+00:00 — Evidence request recorded: Synthetic judge test: identify the missing item\. Event reference: 37. Recorded actor: 40000000-0000-4000-8000-000000000001.
- 2026-10-14T22:16:55\.484654\+00:00 — Customer clarification recorded: Fictional local verification input\. Event reference: 38. Recorded actor: 40000000-0000-4000-8000-000000000001.
- 2026-10-14T22:16:56\.142186\+00:00 — Investigation claimed: Saved catalogue evidence; no approval or payment\. Event reference: 39. Recorded actor: 40000000-0000-4000-8000-000000000003.
- 2026-10-14T22:16:56\.199241\+00:00 — Local investigation finished: Saved recommendation and deterministic checks; human review required\. Event reference: 40. Recorded actor: 40000000-0000-4000-8000-000000000003.

## Exact saved evidence bodies

This JSON appendix preserves each original evidence identifier and body. Parse the JSON to recover the exact supplied strings, including spacing and line breaks. The descriptions above do not replace those records. Source references are not fetched.

```json
[
  {
    "id": "clarification:5950e29e-8f79-404c-9ea9-e3ed445f965a",
    "body": "The sketchbook is the missing item I am claiming."
  },
  {
    "id": "complaint:SYN-F12-C008",
    "body": "Some items are missing from my order. Please check the packing record."
  },
  {
    "id": "delivery:SYN-F12-O008",
    "body": "{\"detail\": \"Synthetic parcel received. Quantities below are the supplied fictional packing record.\", \"status\": \"delivered\", \"disputed\": false}"
  },
  {
    "id": "order:SYN-F12-O008",
    "body": "{\"id\": \"SYN-F12-O008\", \"label\": \"SYN-F12-O008 · £18.00 · ambiguous items\", \"lines\": [{\"id\": \"SYN-F12-O008-L1\", \"name\": \"Sketchbook\", \"packed\": 0, \"ordered\": 1, \"unitAmountMinor\": 1000}, {\"id\": \"SYN-F12-O008-L2\", \"name\": \"Marker set\", \"packed\": 0, \"ordered\": 1, \"unitAmountMinor\": 500}, {\"id\": \"SYN-F12-O008-L3\", \"name\": \"Paper clips\", \"packed\": 1, \"ordered\": 1, \"unitAmountMinor\": 300}], \"currency\": \"gbp\", \"delivery\": {\"detail\": \"Synthetic parcel received. Quantities below are the supplied fictional packing record.\", \"status\": \"delivered\", \"disputed\": false}, \"synthetic\": true, \"totalMinor\": 1800, \"sampleComplaint\": \"Some items are missing from my order. Please check the packing record.\"}"
  },
  {
    "id": "packing:SYN-F12-O008",
    "body": "[{\"id\": \"SYN-F12-O008-L1\", \"name\": \"Sketchbook\", \"packed\": 0, \"ordered\": 1, \"unitAmountMinor\": 1000}, {\"id\": \"SYN-F12-O008-L2\", \"name\": \"Marker set\", \"packed\": 0, \"ordered\": 1, \"unitAmountMinor\": 500}, {\"id\": \"SYN-F12-O008-L3\", \"name\": \"Paper clips\", \"packed\": 1, \"ordered\": 1, \"unitAmountMinor\": 300}]"
  },
  {
    "id": "remedies:SYN-F12-O008",
    "body": "[]"
  }
]
```

No online account, model provider, payment provider or Supabase endpoint was connected.
