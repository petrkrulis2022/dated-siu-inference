# Agentic-settlement metadata

_The structured fields emitted on settlement — build1-spec.md §8's closing line: "the seller's
ERC-8004 identity signature, SIU consumed, and index version, emitted as structured fields on
settlement. Draft standard, works over USDC today." Implemented as the `Receipt` schema
(`packages/sdk/schemas/receipt.schema.json`) and `packages/sdk`'s `receipt/` module:
`signReceipt`, `verifyReceipt`. Returned by the MCP server's `verify_receipt` tool
(build1-spec.md §9) as "a signed attestation: quoted vs paid vs matched."_

---

## What this is

A settlement produces two kinds of record: an on-chain transaction (`TouchstoneEscrow.settle`,
build1-spec.md §10) and, alongside it, structured metadata describing what was quoted, what was
actually paid, whether they matched, and which index print priced the transaction. That metadata
is what this document standardises — not the payment rail itself. **It works over USDC today and
requires no new token**: every field here describes a dollar-denominated settlement that already
happened in USDC; nothing in this standard depends on `wSIU` or `SIUSD` (build 2) existing.

## Field reference

| Field               | Type                       | Meaning                                                                                                                                                                                                              |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`    | string, `"1.0"` in build 1 | Same forward-compatibility convention as `touchstone-quote`.                                                                                                                                                         |
| `quote_hash`        | bytes32 hex                | Binds this receipt to the specific `touchstone-quote` it settles — matches `TouchstoneEscrow.openAndFund`'s `quoteHash` param (build1-spec.md §10) and `quote/sign.ts`'s `quoteHashHex`.                             |
| `chain`             | string                     | Where settlement happened. Build 1: `"base"` only.                                                                                                                                                                   |
| `tx_ref`            | string                     | The on-chain settlement transaction reference.                                                                                                                                                                       |
| `amount_quoted_usd` | decimal string             | The quote's `amount_usd_max` — what escrow was authorised to hold.                                                                                                                                                   |
| `amount_paid_usd`   | decimal string             | **Gross**: the `actualAmount` passed to `TouchstoneEscrow.settle`, _before_ the `feeBps` treasury split. See "Gross vs. net" below — build1-spec.md §10 doesn't state this either way, and this document settles it. |
| `matched`           | boolean                    | Whether the settlement honoured the quote. See "What `matched` means" below.                                                                                                                                         |
| `print_ref`         | string                     | The print this settlement's pricing was measured against.                                                                                                                                                            |
| `signature`         | hex string                 | Touchstone Assay's signature over every other field, proving the receipt itself wasn't altered after being issued.                                                                                                   |
| `public_key`        | hex string                 | The public key `signature` verifies against.                                                                                                                                                                         |

Note what is _not_ here: an ERC-8004 identity signature field distinct from `signature`. The
seller's identity claim lives on the _quote_ (`seller_id`), not the receipt — the receipt attests
to what a payment did, signed by Touchstone Assay, not by the seller. If a future version needs the seller
to co-sign settlement, that is an additive field, not a reason to alter what exists.

## Gross vs. net

`amount_paid_usd` is defined here as **gross**: the full `actualAmount` `TouchstoneEscrow.settle`
transfers before splitting `feeBps` to the treasury and the remainder to the seller. This was an
open question during planning — build1-spec.md §10 states the split happens but never says which
side of it `amount_paid_usd` refers to — and it matters because it directly determines `matched`
(see below). Gross was chosen because `amount_quoted_usd` (the quote's `amount_usd_max`) is also
a gross ceiling — `TouchstoneEscrow`'s own invariant is `actualAmount ≤ maxAmount`, both gross figures.
Comparing a gross ceiling against a net paid amount would make `matched` pass in cases where the
seller was actually charged more than the quote allowed once fees are added back — the opposite
of what "matched" should mean.

## What `matched` means

`matched` is honest when `amount_paid_usd ≤ amount_quoted_usd` — the dollar restatement of
`TouchstoneEscrow`'s own invariant, `actualAmount ≤ maxAmount`. `receipt/verify.ts`'s `verifyReceipt`
recomputes this from the receipt's own two amount fields and **rejects a receipt whose `matched`
flag disagrees with its own figures** — a receipt claiming `matched: true` while its stated
`amount_paid_usd` exceeds its stated `amount_quoted_usd` is not passed through as valid. This
means `verify_receipt`'s attestation is not merely relaying what the seller or a relay claims; it
is a checked fact.

## Binding to a quote

`quote_hash` ties a receipt to the exact `touchstone-quote` it settles, using the same `quoteHash`
construction documented in `docs/datum-quote.md`. `verifyReceipt` accepts an optional `quote`
argument and, when supplied, checks `receipt.quote_hash` against that quote's own hash — so a
receipt cannot be replayed against an unrelated offer.

## Signature scheme

Identical to how a print is signed (build1-spec.md §6) and how a quote is signed
(`docs/datum-quote.md`): JCS-canonicalise the body (every field except `signature` and
`public_key`), keccak256-hash it, sign with secp256k1. This makes a `verify_receipt` result
**independently verifiable offline** — a third party with the receipt and Touchstone Assay's public key
never needs to trust the MCP server's word for it.
