# @touchstone/contracts

Solidity: `TouchstoneAttestation`, `TouchstoneEscrow` (Foundry, Base) — build1-spec.md §10.

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
forge test            # 83 tests
forge coverage        # 100% line/branch/function on both src contracts
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

Nothing has been deployed yet — no address here is live.
