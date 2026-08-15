# `datum-quote` specification

_The pricing extension carried inside an x402 (or MPP) payment-required response — build1-spec.md
§8. Draft standard, versioned via `schema_version`. Implemented by `packages/sdk`'s `quote/`
module: `buildQuoteBody`, `signQuote`, `validateQuote`, `checkSpendingMandate`, and the identity
resolver seam in `quote/identity.ts`._

---

## What this is, and isn't

A `datum-quote` is a seller's priced offer for a unit of inference work, denominated in SIU for
comparison and settled in dollars. It is not a payment itself, not an escrow deposit, and not a
promise the seller will honour it forever — `expiry` bounds how long it stands. **Payment
amounts are dollar-fixed; SIU is the comparison unit.** A buyer comparing two sellers' quotes
compares them in SIU because that is the unit the two sellers' dollar rates are otherwise
incommensurable against; the dollars that actually move are `amount_usd_max`, converted into
`settlement[0].amount_max` minor units at the point escrow is funded.

## Field reference

| Field              | Type                                   | Meaning                                                                                                                             |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | string, `"1.0"` in build 1             | See "Forward compatibility" below.                                                                                                  |
| `siu`              | decimal string                         | The point-estimate SIU quantity this quote is for.                                                                                  |
| `pattern`          | `"estimate"` \| `"cap"` \| `"fixed"`   | See "Patterns" below.                                                                                                               |
| `siu_max`          | decimal string, conditionally required | The upper bound on SIU this quote can consume. Required for `estimate` and `cap`; absent for `fixed`.                               |
| `model`            | string                                 | The registry id of the model priced.                                                                                                |
| `rate_usd_per_siu` | decimal string                         | The seller's dollar rate per SIU.                                                                                                   |
| `amount_usd_max`   | decimal string                         | The dollar ceiling escrow holds against. See "How `amount_usd_max` is computed" below.                                              |
| `index_version`    | string                                 | The `SIU-2026a`-style basket version this quote's SIU figures are denominated against.                                              |
| `print_id`         | string                                 | The specific print this quote's `rate_usd_per_siu` was derived from.                                                                |
| `print_hash`       | hex string                             | That print's body hash, so a payer can verify the referenced print without trusting the seller's claim about it.                    |
| `seller_id`        | string, `erc8004:...`                  | The seller's claimed identity. See "Signature semantics" below — this field is a claim, not a verified fact.                        |
| `expiry`           | RFC3339 UTC timestamp                  | Seller-set. See rule 4.                                                                                                             |
| `settlement`       | array, ≥1 entry                        | Accepted settlement methods, ordered by seller preference. See "Settlement".                                                        |
| `sig`              | hex string                             | The seller's signature over every other field (JCS-canonicalised, keccak256-hashed, secp256k1-signed — the same scheme prints use). |

### Patterns

- **`fixed`** — the SIU quantity and dollar amount are both committed exactly; there is no
  `siu_max` because there is nothing left unbounded to cap.
- **`cap`** — the seller expects to consume close to `siu`, but the actual usage may vary up to
  `siu_max`; escrow holds against the `siu_max` figure.
- **`estimate`** — the loosest pattern; `siu` is a rough figure and `siu_max` is the only
  number a payer can safely rely on as a ceiling.

### How `amount_usd_max` is computed

`amount_usd_max = siu_max × rate_usd_per_siu` for `estimate`/`cap`, rounded half-up to 4 decimal
places — **from `siu_max`, never from the point-estimate `siu`**, because escrow must hold enough
to cover the worst case the quote allows, not the seller's best guess. For `fixed`,
`amount_usd_max = siu × rate_usd_per_siu`, since `siu` there already is the committed, exact
figure. `quote/validate.ts`'s `validateQuote` reconciles this exactly — a quote whose
`amount_usd_max` doesn't reproduce this arithmetic is rejected, because otherwise a seller could
advertise a cheap `rate_usd_per_siu` for SIU comparison while charging an unrelated dollar
amount.

_Illustrative, matching build1-spec.md §8's own example:_ `siu_max: "1.400"`,
`rate_usd_per_siu: "0.0483"` → `amount_usd_max: "0.0676"` (1.400 × 0.0483 = 0.06762, rounded
half-up to 4dp).

### Settlement

`settlement` is an array — deliberately, even though build 1 permits exactly one entry — mirroring
x402's accepted-payment-methods structure rather than a bespoke shape. Each entry is
`{ asset, chain, address, amount_max }`, with `amount_max` as **integer minor units**, not a
decimal string, so it drops directly into `DatumEscrow.openAndFund`'s `uint256 maxAmount` with no
conversion at the contract boundary. This closes a unit-mismatch risk identified during planning:
a decimal-string dollar figure and a `uint256` on-chain figure converted ad hoc in more than one
place can silently drift.

**Build 1 permits exactly one settlement entry, and it MUST be USDC at a known contract address**
— enforced by `validateQuote`, not by the schema, which is the entire point of the array shape:
`wSIU` and `SIUSD` (build 2, per `CLAUDE.md`) become _additional_ entries with no format change
and no consumer-breaking rewrite, the moment build 2 exists. Nothing about this document
anticipates a token; it only leaves the door unlocked, per `CLAUDE.md`'s stated design
consequence that "the receipt and quote formats must be written so a token wrapper is additive
later, never a rewrite."

## Normative rules

1. **Payment amounts are dollar-fixed; SIU is the comparison unit.** Escrow holds and settles in
   USDC, never in SIU — `siu`/`siu_max` exist so a payer can compare sellers on a common footing,
   not so escrow can be funded in SIU terms.

2. **`siu_max` is required for `pattern: estimate` and `pattern: cap`.** Enforced at the schema
   level (an `if`/`then` conditional) and, independently, by the mandate check below — a quote
   missing it is not merely invalid, it is unbounded, and an unbounded quote cannot be safely
   auto-paid.

3. **Escrow holds against `amount_usd_max`, not against `siu` or `siu_max` directly.** The dollar
   figure is what `openAndFund`'s `maxAmount` actually receives; SIU never touches the contract.

4. **A quote with `pattern: estimate` and no `siu_max` MUST be rejected by a payer operating
   under a spending mandate.** This is the rule the entire extension's safety rests on. Without
   an upper bound, escrow cannot hold a bounded amount, and an autonomous agent's budget is
   exposed without limit — a single malformed or hostile quote could authorise unlimited spend.
   Requiring a bound is precisely what makes the extension safe to auto-accept: a payer can check
   one number (`amount_usd_max ≤ mandate budget`) and know its maximum exposure, without needing
   to trust the seller's honesty about anything else. `checkSpendingMandate` in
   `packages/sdk/src/quote/mandate.ts` implements this rule directly against whatever object a
   payer is handed — it does not assume schema validation ran first, because a payer that trusts
   an upstream validation step it cannot verify has not actually bounded its exposure.

5. **A payer MUST reject an expired quote.** `expiry` is seller-set and RFC3339 UTC; a quote
   accepted after its own stated expiry is a quote the seller never actually offered at that
   moment.

6. **The escrow `expiry` passed to `openAndFund` MUST be ≥ the quote's `expiry` plus a settlement
   window.** The work the quote pays for happens _after_ payment; an escrow that expires at or
   before the quote's own expiry could reclaim funds out from under work already in flight. This
   document does not fix the settlement window's length — that is an operational parameter for
   whoever funds escrow, not a property of the quote itself.

7. **Build 1 permits exactly one `settlement` entry and it MUST be USDC.** See "Settlement"
   above.

8. **`quoteHash`** is keccak256 of the JCS-canonicalised quote body with `sig` excluded — the
   same construction a print uses, excluding its own `signature`/`public_key`. This is the
   `quoteHash` `DatumEscrow.openAndFund` and `receipt.quote_hash` both refer to, and it is
   computable before a seller signs anything, since it's a property of the offer, not of the
   signer. `packages/contracts`' Solidity (P13) must reproduce this exact construction — that
   coordination point was flagged during planning as the one place `sdk` and the contract must
   agree, and it is a five-minute conversation, not a shared dependency.

## Forward compatibility

`schema_version` (`"1.0"` in build 1) lets a consumer detect additive changes without a schema
rewrite: a same-major bump (`1.1`, `1.2`, …) is additive and safe for an existing consumer to
accept and ignore unknown fields on; a major bump (`2.0`) is not, and an unrecognised major
version MUST be rejected rather than guessed at.

## Signature semantics

**A signature proves body integrity and key custody only.** `sig` proves the quote body was
signed by whoever holds the private key corresponding to the public key used to verify it, and
that the body hasn't been altered since. **It does not prove that key belongs to the
`seller_id` claimed in the quote.** Binding a public key to an ERC-8004 identity is out of scope
for the build-1 spec and MUST be performed by the payer through a registry resolver before
trusting `seller_id` — build 1 does not do this. `packages/sdk/src/quote/identity.ts`'s
`IdentityResolver` is the seam this binding happens through: `StaticResolver` is a local
allowlist (for known counterparties — demo agents, tests), and `Erc8004Resolver` throws rather
than silently returning `null`, naming exactly what real ERC-8004 resolution needs and stating
plainly that it isn't built yet.

## Open items, recorded rather than invented

- **No settler field.** `DatumEscrow.settle` (build1-spec.md §10) is "callable by seller (or a
  settler the buyer authorised in the quote)" — but no field on this quote carries a settler
  address. This is a genuine gap between §8 and §10, not resolved here; whoever implements P13's
  contract-facing settlement flow needs to either add a `settler` field or find another channel
  for that authorisation.
