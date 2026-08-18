# `touchstone-quote` specification

_The pricing extension carried inside an x402 (or MPP) payment-required response — build1-spec.md
§8. Draft standard, versioned via `schema_version`. Implemented by `packages/sdk`'s `quote/`
module: `buildQuoteBody`, `signQuote`, `validateQuote`, `checkSpendingMandate`, and the identity
resolver seam in `quote/identity.ts`._

---

## What this is, and isn't

A `touchstone-quote` is a seller's priced offer for a unit of inference work, denominated in SIU for
comparison and settled in dollars. It is not a payment itself, not an escrow deposit, and not a
promise the seller will honour it forever — `expiry` bounds how long it stands. **Payment
amounts are dollar-fixed; SIU is the comparison unit.** A buyer comparing two sellers' quotes
compares them in SIU because that is the unit the two sellers' dollar rates are otherwise
incommensurable against; the dollars that actually move are `amount_usd_max`, converted into
`settlement[0].amount_max` minor units at the point escrow is funded.

## Field reference

| Field              | Type                                   | Meaning                                                                                                                             |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`   | string, `"2.0"` in build 1             | See "Forward compatibility" below.                                                                                                  |
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
| `settler`          | address, optional                      | An address the buyer additionally authorises to settle. Absent means seller-only. See rule 9.                                       |
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

### Minimum quotable amount

**The floor is `$0.0001`** — the smallest nonzero value representable at `amount_usd_max`'s own
4dp rounding precision (`QUOTE_AMOUNT_DP`), equal to 100 USDC minor units at USDC's real 6
decimals. This is not USDC's own floor (`$0.000001`, 1 minor unit) — widening `amount_usd_max`'s
precision to match that would be a bigger change to an already-shipped format than what actually
broke. The floor is simply the existing format's own smallest step: below it, `amount_usd_max`
has nowhere to round to but `"0.0000"`.

This was discovered live, not designed in advance: a real sub-cent inference call in P14's demo
agents priced to a true cost small enough that `amount_usd_max` rounded to `"0.0000"`, and
`TouchstoneEscrow.openAndFund` reverted on a zero `maxAmount` — an unpayable quote that had already
been signed and accepted before the transaction was attempted.

**Below the floor, a quote is rejected — never rounded up.** Rounding up would charge the buyer
more than the seller's real cost; that is an invented number, the same category of thing
`CLAUDE.md`'s "never invent numbers in documentation or UI copy" and the no-floats money-maths
invariant already rule out elsewhere. `quote/validate.ts`'s `validateQuote` enforces this: any
quote whose `amount_usd_max` is below `MINIMUM_QUOTABLE_USD` (`quote/build.ts`) fails validation.

**When a seller's true cost rounds to zero, it must not issue an individual quote for that call
at that price.** Two honest ways out, both already real code in this repo's own demo seller
(`packages/agents/src/pricing.ts`/`seller.ts`): batch multiple calls into one quote whose combined
committed amount clears the floor, or — for `cap`/`estimate` patterns — widen the `siu_max`
ceiling (for example, raise the output-token budget a seller commits to enforcing) so the
worst-case cost, not just the point estimate, clears `$0.0001`.

### The settlement floor, and where sub-floor flows belong instead

The quote-side floor above governs what can be _quoted_. A second, independent floor governs what
`TouchstoneEscrow` will actually _settle_: `MIN_SETTLEMENT = 100` USDC minor units. Below it,
`settle()` reverts (`SettlementTooSmall`) rather than accepting a real, nonzero settlement whose
fee integer division would otherwise truncate to zero — found live, the same way the quote-side
floor was: real settlements as small as 13–50 minor units were paying no fee at all, discovered
against real demo-agent activity in the console's first live run.

**The two floors are numerically identical, and that's not a coincidence worth leaving unstated.**
`MINIMUM_QUOTABLE_USD` ($0.0001) is exactly 100 USDC minor units at 6dp (`0.0001 × 10^6 = 100`) —
the same number as `MIN_SETTLEMENT`. A quote that clears the quoting floor therefore always
clears the settlement floor too, for the same underlying dollar amount; the two mechanisms agree
on where the escrow's usable range begins.

**This is a deliberate division of responsibility between two payment paths, not a limitation of
either.** `TouchstoneEscrow` is built for quote-and-settle transactions: a buyer and seller agree
a ceiling, real work happens, the seller settles for what was actually consumed. That shape — an
on-chain hold, a signed quote to check settlement against, an explicit settle call — has a real
per-transaction floor below which its own accounting (a fee that must round to at least one unit,
a settlement worth the gas of its own transaction) stops making sense. True nanopayment flows —
many sub-$0.0001 charges that only make sense aggregated — belong on Circle's Gateway batching
path instead, which the MCP server's paywall already uses for `get_quote`, `convert`, and
`verify_receipt` (`packages/mcp-server/src/paywall.ts`). Escrow and Gateway are not competing
solutions to the same problem; they're the two payment paths this protocol has, matched to the
two shapes of flow it actually needs to support — one quote-and-settle transaction at a time
above the floor, many aggregated micro-charges below it.

### Settlement

`settlement` is an array — deliberately, even though build 1 permits exactly one entry — mirroring
x402's accepted-payment-methods structure rather than a bespoke shape. Each entry is
`{ asset, chain, address, amount_max }`, with `amount_max` as **integer minor units**, not a
decimal string, so it drops directly into `TouchstoneEscrow.openAndFund`'s `uint256 maxAmount` with no
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

6. **`amount_usd_max` MUST be at least `MINIMUM_QUOTABLE_USD` (`$0.0001`).** See "Minimum
   quotable amount" above. Enforced by `validateQuote`, not by the schema — a below-floor quote is
   internally consistent (its arithmetic can still be honest) but unpayable, since
   `TouchstoneEscrow.openAndFund` reverts on a zero `maxAmount`.

7. **The escrow `expiry` passed to `openAndFund` MUST be ≥ the quote's `expiry` plus a settlement
   window.** The work the quote pays for happens _after_ payment; an escrow that expires at or
   before the quote's own expiry could reclaim funds out from under work already in flight. This
   document does not fix the settlement window's length — that is an operational parameter for
   whoever funds escrow, not a property of the quote itself.

8. **Build 1 permits exactly one `settlement` entry and it MUST be USDC.** See "Settlement"
   above.

9. **`quoteHash`** is keccak256 of the JCS-canonicalised quote body with `sig` excluded — the
   same construction a print uses, excluding its own `signature`/`public_key`. This is the
   `quoteHash` `TouchstoneEscrow.openAndFund` and `receipt.quote_hash` both refer to, and it is
   computable before a seller signs anything, since it's a property of the offer, not of the
   signer. `TouchstoneEscrow` never recomputes it — the contract takes `quoteHash` as an opaque
   `bytes32` key — so there is no risk of the two implementations disagreeing about how it is
   derived; the SDK is its single source.

10. **The seller MUST verify the on-chain settler before performing any work.** `settler` on the
    quote is what the seller agreed to; `TouchstoneEscrow.settlerOf(quoteHash)` is what the buyer
    actually funded. Before starting work the seller MUST read the on-chain value and confirm it
    matches the settler in their own signed quote. **On mismatch the seller MUST NOT perform the
    work, and MUST let the escrow expire** so the buyer's funds return untouched.

    This matters because a settler is an address the buyer chose. A buyer who funds escrow naming
    a settler the quote never agreed to could take delivery of completed work and then have that
    settler settle at zero, paying nothing. The contract cannot detect this — `settler` is fixed
    at funding time and `TouchstoneEscrow` has no way to know what a signed quote said — so the check
    has to happen off-chain, before the work is done, and it is the seller's responsibility. The
    contract makes the check cheap by exposing `settlerOf(quoteHash)` directly.

11. **The fee is charged on `actualAmount`, never on `maxAmount`, and is deducted from the
    seller's proceeds.** The seller receives `actualAmount - fee`; the treasury receives `fee`;
    the buyer is refunded `maxAmount - actualAmount` in full, with no fee taken from the portion
    being returned to them. **Sellers must price accordingly** — the headline
    `rate_usd_per_siu` in a quote is gross, and the seller's realised revenue is that figure
    less `feeBps`. `feeBps` is immutable on the deployed escrow and capped at
    `MAX_FEE_BPS = 100` (1%) by the contract's constructor, so this deduction cannot be changed
    after deployment.

## Forward compatibility

`schema_version` (`"2.0"` in build 1) lets a consumer detect additive changes without a schema
rewrite: a same-major bump (`2.0`, `2.1`, …) is additive and safe for an existing consumer to
accept and ignore unknown fields on; a major bump is not, and an unrecognised major version MUST
be rejected rather than guessed at.

Version history:

- `1.0` → `1.1` added the optional `settler` field alongside `TouchstoneEscrow`. Because the
  schema is `additionalProperties: false`, a consumer still holding the `1.0` schema file would
  have rejected a quote carrying `settler` rather than ignoring it — which is exactly why the
  version had to move: the rejection is then explicable rather than mysterious.
- `1.1` → `2.0` is the Datum → Touchstone Assay rename: the extension itself is renamed from
  `datum-quote` to `touchstone-quote`. That is a change to the format's identity, not an additive
  field, so it is a major bump rather than a minor one — a consumer built against `datum-quote`
  should not silently treat a `touchstone-quote` as the same thing. Nothing was published under
  the pre-rename name, so there is no live `1.x` consumer this bump needs to stay compatible
  with.

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

## Known limitation: the contract cannot verify the work

`TouchstoneEscrow` enforces `actualAmount <= maxAmount` and nothing more. It has no way to observe how
many tokens a model actually consumed, so **a seller can settle for anything up to `maxAmount`
regardless of the work performed.** This is a property of any on-chain escrow over off-chain
work, not an oversight in this design, and it is stated here rather than left for someone to
discover.

What bounds it:

- **The buyer's exposure is capped by `amount_usd_max`**, which is the number a spending mandate
  checks (rule 4). The worst case is bounded and known before funding.
- **Detection is off-chain**, by comparing the settlement against the signed quote — that is what
  `verify_receipt` (build1-spec.md §9) produces a signed attestation about, and what
  `docs/settlement-metadata.md`'s `matched` flag records.
- **Enforcement is reputational**, through the seller's ERC-8004 identity. A seller that settles
  at max for work it did not do accumulates receipts that say so.

## Open items, recorded rather than invented

- **ERC-8004 identity resolution is not implemented.** See "Signature semantics" above: a
  signature proves key custody, not that the key belongs to `seller_id`. `Erc8004Resolver`
  throws rather than pretending otherwise.
