# @touchstone/contracts

Solidity: `TouchstoneAttestation`, `TouchstoneEscrow` (Foundry, Base) — build1-spec.md §10 — plus
`CapacityBond`, `ClaimRouter`, `WorkClaim` (Gate Market testbed, WP-2 —
`docs/gate-market-spec.md` §5.3, a sanctioned exception to CLAUDE.md's "no token in build 1"
invariant, scoped to this testbed alone — see CLAUDE.md's dated note on that invariant).

Not a pnpm workspace member: separate toolchain, per CLAUDE.md's stack conventions. `pnpm test`
at the repo root does **not** run these tests — run `forge test` here instead. That is a
deliberate tradeoff: wiring Foundry into `pnpm -r test` would break the TypeScript test run for
anyone without Foundry installed.

## Setup

`lib/` is vendored as git submodules (Foundry's standard `forge install`), which this repo did
not previously use. After cloning:

```bash
git submodule update --init --recursive
```

Dependencies: `forge-std` and `openzeppelin-contracts` v5.7.0 (`SafeERC20`, and the
storage-based `ReentrancyGuard` — deliberately not the transient-storage variant, which would
require Cancun).

```bash
forge build
forge test            # 125 tests
forge coverage        # 100% line/branch/function on TouchstoneAttestation and TouchstoneEscrow;
                       # CapacityBond/ClaimRouter/WorkClaim/MinimalERC1155 are lower (line coverage
                       # 57-96%, branch coverage 8-82% — see "Coverage on the Gate Market
                       # contracts" below for the real numbers and why)
forge fmt             # Solidity formatting; prettier does not touch this package
```

## `TouchstoneAttestation`

`postPrint(bytes32 bodyHash, string version)`, restricted to an immutable `publisher`. Stores
`bodyHash => timestamp` and emits `PrintPosted`. Re-anchoring an already-anchored hash reverts —
the recorded timestamp is the fact being attested, so overwriting it would destroy evidence
rather than add to it.

No upgradeability, no admin, and no publisher rotation: rotating the key means deploying a new
instance and naming the new address in the published methodology. A mutable publisher would let
whoever controls the mutation retroactively change who is trusted to have anchored past prints.

## `TouchstoneEscrow`

```solidity
openAndFund(bytes32 quoteHash, address seller, address settler, uint256 maxAmount, uint64 expiry)
settle(bytes32 quoteHash, uint256 actualAmount, bytes32 receiptRef)
expire(bytes32 quoteHash)
```

**The `settler` parameter is a deliberate deviation from §10's stated signature.** §10 says
`settle` is callable by "a settler the buyer authorised in the quote", but the quote schema had
no channel for that authorisation (recorded as an open gap in `docs/datum-quote.md` when the
schema was written). The buyer now authorises the settler atomically at funding time. There is no
`authoriseSettler` function and no way to change the settler afterwards. `settler == address(0)`
means seller-only settlement.

Because the settler is buyer-chosen, `docs/datum-quote.md` rule 9 makes it **normative that a
seller reads `settlerOf(quoteHash)` and checks it against their own signed quote before doing any
work** — otherwise a buyer could name a settler the quote never agreed to, take delivery, and
settle at zero. `settlerOf` exists to make that check cheap.

### Money flow

Fee is charged on `actualAmount`, never on `maxAmount` — the buyer must not pay fees on funds
being refunded — and is deducted from the seller's proceeds:

| Destination | Amount                                  |
| ----------- | --------------------------------------- |
| seller      | `actualAmount - fee`                    |
| treasury    | `fee` (`actualAmount × feeBps / 10000`) |
| buyer       | `maxAmount - actualAmount`              |

Which sums to exactly `maxAmount`. `feeBps` and `treasury` are **immutable**, with a hard
`MAX_FEE_BPS = 100` (1%) ceiling enforced in the constructor — no setter, no admin role, no
timelock. Set `treasury` to a Safe/multisig so signer rotation happens at the Safe rather than by
redeploying.

### Non-custodial by construction

There are exactly three state-mutating functions, and every token movement in all three has a
destination fixed by state written at funding time: the recorded seller, the recorded buyer, or
the immutable treasury. No owner, no admin, no pause, no sweep, no upgrade path, no setter for
any immutable, and no `receive`/`fallback` (so ETH cannot enter and become stranded).

`test/NoAdminPath.t.sol` asserts this structurally rather than by comment: it reads the compiled
ABI and requires the set of non-view functions to be _exactly_ `{openAndFund, settle, expire}`,
and scans the deployed bytecode — opcode-aware, skipping PUSH immediates — for `DELEGATECALL`,
`CALLCODE` and `SELFDESTRUCT`, none of which appear.

### Known limitation

The contract cannot verify the work a quote paid for, so a seller may settle for anything up to
`maxAmount`. Detection is off-chain via `verify_receipt`; enforcement is reputational via
ERC-8004. See `docs/datum-quote.md`.

## `CapacityBond`, `ClaimRouter`, `WorkClaim` — the Gate Market testbed

Three contracts for `docs/gate-market-spec.md`'s dated work claims. `CapacityBond` holds each
issuer's bonded USDC per class and tracks headroom (`issuanceLimit = committedCapacityHours ×
measuredRateMilliSiuPerHour × 0.5`, the ratio fixed, never a per-lot parameter — see the
contract's own doc comment for why). `WorkClaim` is the ERC-1155 claim itself. `ClaimRouter`
picks which issuer a mint draws from, so the buyer never does.

### Token id scoped to one issuer — a real scoping decision, not the spec's own design

`docs/gate-market-spec.md` §6.1 describes claims as fungible *across* issuers within one
(class, window) — one token id, multiple issuers backing it, with routing happening at
*redemption* time. That requires attributing a shared pool's outstanding supply back to
individual issuers proportionally when the pool only partially defaults, which is genuinely
unresolved even in the monetary design doc (`docs/monetary-design.md` §7.4 flags default
correlation as an open question; nothing states how liability splits across issuers). Solving
that correctly is real design work, not something to improvise directly into a contract holding
bonded USDC.

This build routes at **mint** time instead: `tokenId = keccak256(issuer, classId, windowFrom,
windowTo)`, so every claim's default/expire liability is unambiguously one issuer's, and "the
holder never picks" is satisfied at mint (`ClaimRouter.route`) rather than at redemption. The
cost: claims from different issuers for the same (class, window) aren't the same fungible token
id. See `ClaimRouter.sol`'s own doc comment. Worth reopening once the proportional-attribution
question has a real answer, not before.

### Three terminal states, not two

Settled via review, 2026-09-22 — the spec's own DEFAULT wording reads as if "never presented" and
"presented and failed" carry the same consequence, which is the wrong economics: redemption
failure here is always issuer-attributable (the holder supplies only a task spec; the gate grades
the issuer's own served output), so the two cases can't be treated the same.

| State | Trigger | Headroom | Bond |
| --- | --- | --- | --- |
| Redeemed | `serveRedemption` reports a genuine pass | restored | untouched |
| Defaulted | window closed, holder presented at least once, never successfully redeemed | restored | **pays the holder** |
| Expired | window closed, holder never presented | restored | untouched — an unexercised option, not a default |

All three restore headroom — the property `WorkClaim.invariant.t.sol` fuzzes hardest, per review:
if any terminal path failed to, claims nobody touched would silently and permanently lock
issuance capacity.

### The four ways value can leak, each fuzzed directly

- **Minting free work** (access control) — an unrouted party's forged "pass" must never succeed.
  `WorkClaimHandler.attackerServeUnrouted`, asserted via `ghostUnauthorisedServeSucceeded == 0`.
- **Inflating headroom** (serve idempotency / invariant 3 itself) — a failed serve must leave
  balance and headroom exactly unchanged. Checked twice: inline in
  `WorkClaimHandler.serveFail`, immediately after every single failed call (the property review
  asked to fuzz hardest), and in aggregate by `invariant_outstandingEqualsSumOfLiveClaims`, which
  computes the live sum from real on-chain ERC-1155 balances, never a ghost total.
- **Draining the bond** (default idempotency) — a claim reaching a terminal state must pay out at
  most once. `WorkClaimHandler.attackerDoubleSettle`, asserted via
  `ghostDoubleServeOnRetiredSucceeded == 0`.
- **USDC escaping the known actor set** — same conservation shape as
  `TouchstoneEscrow.invariant.t.sol`, adapted for issuers and the bond, not just a single escrow.

`@custom:forge-config default.invariant.runs = 10000` on `WorkClaim.invariant.t.sol` — the
per-file override this suite runs at, not the repo default (256), specifically because invariant
3 is the property this class's entire thesis rests on.

**Coverage discipline learned live, matching `TouchstoneEscrow.invariant.t.sol`'s own precedent
exactly:** `afterInvariant` asserts only `ghostMints > 0` — not `ghostServeFails`,
`ghostRejectedUnauthorisedServes`, or `ghostRejectedDoubleServesOnRetired`, even though those are
exactly the paths under test. `afterInvariant` runs once *per independent run*, and whether any
one bounded-depth run happens to also land a rarer path is genuinely random — with 10,000
independent runs, even a small per-run miss probability guarantees some run fails a
probabilistic coverage assertion even though the underlying property never broke. Found this the
hard way before fixing it: an earlier version asserted all four and failed intermittently at
every run count tried, despite the real conservation invariants passing cleanly throughout.
Reachability of the rarer paths is instead proven deterministically by
`WorkClaimHandlerCoverageTest`, the same role `EscrowHandlerCoverageTest` already plays for
`TouchstoneEscrow`.

**Confirmed at full scale, 2026-09-22:** `FOUNDRY_INVARIANT_RUNS=10000 FOUNDRY_INVARIANT_DEPTH=80
forge test --match-contract WorkClaimInvariantTest` — 5/5 invariants passed, 800,000 real calls,
0 reverts. This is the definitive run the per-file `@custom:forge-config` override above targets;
the repo-default 256-run pass (`forge test` with no env override, what CI runs) is a fast sanity
check on the same suite, not the property's real evidence.

### Coverage on the Gate Market contracts — real numbers, not a claim of 100%

Unlike `TouchstoneAttestation`/`TouchstoneEscrow` above, `forge coverage` does **not** show 100%
on `CapacityBond`, `ClaimRouter`, `WorkClaim`, or `MinimalERC1155`. Real numbers as of 2026-09-22:

| File               | Lines  | Statements | Branches | Functions |
| ------------------ | ------ | ---------- | -------- | --------- |
| `CapacityBond.sol` | 93.75% | 78.57%     | 7.69%    | 90.00%    |
| `ClaimRouter.sol`  | 88.89% | 75.00%     | 50.00%   | 100.00%   |
| `WorkClaim.sol`    | 96.43% | 84.51%     | 47.62%   | 83.33%    |
| `MinimalERC1155.sol` | 57.14% | 51.81%   | 31.58%   | 56.25%    |

Branch coverage is the honest low point, mostly unexercised `if (x) revert Y()` guard clauses that
neither the functional tests nor the invariant handler's constrained inputs ever trigger (e.g.
`CapacityBond`'s zero-address constructor checks, `WorkClaim`'s `BadWindow`/`ZeroAmount` guards on
malformed input the handler never constructs). `MinimalERC1155`'s lower numbers are largely
`safeBatchTransferFrom`/`balanceOfBatch`/`uri`/`supportsInterface` — real ERC-1155 surface this
testbed's own usage never exercises, since `WorkClaim` only ever calls single-transfer paths.

Line and branch coverage measure something different from what the 10,000-run invariant suite
proves: coverage shows which code a fuzz *campaign happened to reach*, not whether the properties
that matter held under adversarial pressure. The three value-conservation properties (invariant
3, access control, default idempotency) are proven by the invariant run above, not by this table —
this table is reported here in full rather than rounded up to "100%", per this repo's own
"never invent numbers" convention.

### Known limitation

`WorkClaim.mint`/`settleWindowClose` take a USD-per-SIU rate (`microUsdPerSiu`) as a
caller-supplied parameter, not one verified against an on-chain print — `CapacityBond.drawForDefault`
itself only ever receives the already-computed USDC amount, never the rate.
`TouchstoneAttestation` stores only `bodyHash => postedAt`, nothing numeric — the honest fix
requires reproducing the print body's exact JCS canonicalisation on-chain, real work deliberately
out of scope here, disclosed rather than half-solved. Mirrors `TouchstoneEscrow`'s own disclosed
"cannot verify the work a quote paid for" limitation. This package's own invariants (headroom
conservation, exactly-once payout, access control) hold regardless of whether the supplied rate
is honest — a dishonest rate is a pricing-manipulation risk, structurally different from the
conservation properties fuzzed above.

**Fixed 2026-09-22, before any real settlement ran:** the rate parameter was originally
`usdPerMilliSiu` — a whole number of USDC minor units per mSIU, which can only express USD/SIU
prices in $0.001 steps. `dated_siu` publishes to 4 decimal places (`docs/methodology.md`'s
rounding table; e.g. `"0.0107"`), one digit finer than that — a real rate would have silently
truncated to the nearest $0.001/SIU on every mint and every default settlement, a multi-percent
value leak on the one path where the bond pays real USDC out, invisible to the invariant suite
above because its fixtures use round test prices rather than real print magnitudes. Renamed to
`microUsdPerSiu` (matches USDC's own 6 decimals, `packages/sdk/src/money/units.ts`'s
`USDC_DECIMALS`) and the final USDC amount is computed as `quantity * microUsdPerSiu / 1000`,
truncating only in that last division — bounded under 1 USDC minor unit (1e-6 USD) of error
*total*, not per mSIU. `WorkClaim.t.sol`'s `test_mintPricingHoldsRealPrintRateExactly` is the
regression test, using the real 2026-09-22 print's own `dated_siu` ($0.0107/SIU) against a
deliberately non-round quantity so the division can't cancel out by luck.

**Hard precondition before this goes to Arc — see this file's own section below.**

## Deploying (Base Sepolia) — Gate Market

`script/DeployGateMarket.s.sol`, same chain-id guard as `Deploy.s.sol`. `CapacityBond` and
`WorkClaim` reference each other's addresses immutably (no setter — see `CapacityBond.sol`'s own
doc comment for why), so `WorkClaim`'s future address is computed from the broadcaster's own
nonce sequence before anything is deployed:

```bash
# optional: TOUCHSTONE_GATE_MARKET_USDC to override Base Sepolia's USDC address
forge script script/DeployGateMarket.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"                 # simulate
forge script script/DeployGateMarket.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast     # deploy
```

After deploying, at least one issuer must call `CapacityBond.createLot` (approving USDC to the
bond first) before any claim can be minted — there is no seed data, deliberately, matching every
other contract in this repo's "constructor parameters only, no privileged setup step" convention.

## Tests

Every test category was mutation-checked — the property was broken deliberately and the suite
confirmed to fail — because a security test that cannot fail is worse than no test:

- **Reentrancy** (`TouchstoneEscrow.reentrancy.t.sol`): a hostile token re-enters from its transfer
  hook. The nested call targets a _second, still-open_ escrow whose authorised settler is the
  token itself, and the token holds a balance and approval — so neither CEI, nor the
  authorisation check, nor a missing allowance can be what refuses it. Only the guard can.
- **No admin path** (`NoAdminPath.t.sol`): verified by injecting an `emergencyWithdraw` and
  confirming three tests fail.
- **Conservation** (`TouchstoneEscrow.invariant.t.sol`): 256 runs × 64 calls of arbitrary
  open/settle/expire/warp sequences. The headline invariant sums balances across every possible
  legitimate holder and asserts it equals the total minted, so any token reaching any other
  address breaks it. `afterInvariant` guards against the suite passing vacuously — an earlier
  revision was doing exactly that and looked green.

## Deploying (Base Sepolia only)

`script/Deploy.s.sol` is guarded with `require(block.chainid == 84532)`: broadcasting it against
another network would deploy an escrow pointing at an address that is not USDC there, and the
mistake would only surface when funds failed to arrive. Chain-specificity lives in the script;
the contracts take every environment-dependent value as a constructor parameter, so adding Arc or
Base mainnet later is a new script, never a contract change.

```bash
export TOUCHSTONE_PUBLISHER_ADDRESS=0x...   # address of the print-signing publisher key
export TOUCHSTONE_TREASURY=0x...            # fee destination — immutable, use a Safe
export TOUCHSTONE_FEE_BPS=50                # 0.5%, must be <= 100
# optional: TOUCHSTONE_USDC to override Base Sepolia's USDC address

forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"                 # simulate
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast     # deploy
```

Base Sepolia USDC defaults to `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, from Circle's own
documentation and the same value `packages/sdk/src/money/assets.ts` carries.

## Deploying (Arc Testnet)

`script/DeployArcTestnet.s.sol` is the same script, guarded to Arc Testnet's chain id (5042002)
instead — a new file per the note above, not a parameterized version of `Deploy.s.sol`.

```bash
export TOUCHSTONE_PUBLISHER_ADDRESS=0x...   # address of the print-signing publisher key
export TOUCHSTONE_TREASURY=0x...            # fee destination — immutable, use a Safe
export TOUCHSTONE_FEE_BPS=50                # 0.5%, must be <= 100
# optional: TOUCHSTONE_USDC to override Arc Testnet's USDC address

forge script script/DeployArcTestnet.s.sol --rpc-url https://rpc.testnet.arc.io                 # simulate
forge script script/DeployArcTestnet.s.sol --rpc-url https://rpc.testnet.arc.io --broadcast     # deploy
```

Arc Testnet USDC defaults to `0x3600000000000000000000000000000000000000`, verified against two
independent Circle documentation pages and the same value `packages/sdk/src/money/assets.ts`
carries. Arc Testnet's native gas currency is USDC itself (shown with 18 decimals at the protocol
level — the ERC-20 contract above still reports 6, like every other chain's USDC): the deployer
wallet needs Arc Testnet USDC from https://faucet.circle.com before broadcasting, since the same
balance pays both gas and any settlement.

Real addresses for both networks are recorded in `data/deployments/base-sepolia.json` and
`data/deployments/arc-testnet.json`.

## Arc mainnet — prepared, not run

`script/DeployArcMainnet.s.sol` deploys `TouchstoneAttestation` only (no `TouchstoneEscrow` — see
`data/deployments/arc-testnet.json`'s `mainnetRequirements` for why) ahead of Arc's 2026-09-16
public mainnet launch. Its chain-id guard is driven by an `ARC_MAINNET_CHAIN_ID` env var rather
than a hardcoded constant, since Arc's real mainnet chain id wasn't publicly documented at the
time this was written — confirm the real value against Arc's own docs before ever running this.

## Hard precondition before `CapacityBond` goes to any chain other than the one it started on

`CapacityBond` default settlement reads a print's `bodyHash` from the `TouchstoneAttestation`
instance **on the same chain the bond is deployed to** — `TouchstoneAttestation` stores only
`bodyHash => postedAt`, nothing numeric, so there is no other way for a contract to establish that
a caller-supplied print is genuine. That structurally rules out reading the wrong chain's
attestation (a contract can only call an instance deployed on its own chain), but it creates a
real, easy-to-miss operational dependency: **a chain's `CapacityBond` cannot settle a single
default until prints are actually being anchored to that chain's own `TouchstoneAttestation`.**

Today the daily print-publish automation (`.github/workflows/publish-print.yml`) anchors to Base
Sepolia only. Before any `CapacityBond` is deployed to Arc:

1. The publish automation must also post to Arc's `TouchstoneAttestation`
   (`data/deployments/arc-testnet.json`, or the mainnet instance once it exists) — not as a
   follow-up, as a precondition.
2. That must be **verified live** — anchor a real print, then confirm Arc's `CapacityBond` can
   read and cryptographically verify it — before a single claim is minted against an Arc bond.

A default is already the stressed path in this design. Its price source cannot be the thing that
turns out to be untested the first time it's actually needed.
