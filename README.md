# Touchstone Assay

Touchstone Assay publishes Dated SIU — the benchmark price of AI inference work, measured by actually
buying inference against a versioned task basket, not by surveying list prices.

## The two hard invariants

1. **The print is computed from executed runs only.** Published list prices inform exchange
   rates and are never inputs to the print.
2. **The escrow contract is non-custodial.** Funds move only to the pre-agreed seller, back to
   the buyer, or to the fee treasury — no admin path to user money exists in any code path.

## How to run a print

_Placeholder — wired up once `packages/print` exists._

## Docs

- [`CLAUDE.md`](./CLAUDE.md) — vocabulary, invariants, build boundaries.
- [`docs/build1-spec.md`](./docs/build1-spec.md) — the Build 1 engineering specification.
- [`docs/plan.md`](./docs/plan.md) — orientation, dependency order, and open risks.
- [`docs/architecture.md`](./docs/architecture.md) — one diagram of the whole system.
- [`docs/demo.md`](./docs/demo.md) / [`docs/demo-arc.md`](./docs/demo-arc.md) — the buyer/seller
  agent loop, real transcripts, on Base Sepolia and Arc Testnet.

## Deployments

<!-- BEGIN GENERATED: deployments -->

### Arc Testnet

Chain ID `5042002`. Deployed 2026-09-05 from commit `95eea03`.

| Contract                | Address                                                                                                                        | Verification    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `TouchstoneAttestation` | [`0x12b886b043feABc3d90bBae3ae206d22b208160d`](https://testnet.arcscan.app/address/0x12b886b043feabc3d90bbae3ae206d22b208160d) | Pass - Verified |
| `TouchstoneEscrow`      | [`0x3Cc274d68972DFA1B9B13b90eE40664E0dE2c91F`](https://testnet.arcscan.app/address/0x3cc274d68972dfa1b9b13b90ee40664e0de2c91f) | Pass - Verified |

Full record — transaction hashes, block numbers, constructor arguments, compiler settings, and live smoke-test results — is canonical in [`data/deployments/arc-testnet.json`](./data/deployments/arc-testnet.json). **This README section is a convenience view generated from that file** (`node scripts/generate-readme-deployments.mjs`) and must never be hand-edited to disagree with it.

**Not deployed to mainnet.** Requirements before it can be:

- treasury MUST be a Safe/multisig, not an EOA. It is immutable with no setter, so a lost key makes fee revenue permanently unrecoverable and the only remedy is redeploying the escrow and migrating every integrator.
- Generate TOUCHSTONE_PUBLISHER_KEY on an air-gapped machine. The testnet key reused here has passed through repository-adjacent files.
- DeployArcTestnet.s.sol is chain-guarded to 5042002; a mainnet deployment needs its own script and its own review.
- Arc mainnet's own chain ID and USDC contract address must be independently re-verified against Circle's/Arc's own documentation at deploy time — never copied from this testnet record, even though Arc's testnet USDC happens to sit at a distinctive, memorable address (0x3600...0000).
- Arc's public mainnet launches 2026-09-16 — see packages/contracts/script/DeployArcMainnet.s.sol, prepared but not run, with its chain-id guard deliberately left as an env-var placeholder rather than a guessed constant.

### Base Sepolia

Chain ID `84532`. Deployed 2026-08-18 from commit `7b1d6ed`.

| Contract                | Address                                                                                                                                | Verification    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `TouchstoneAttestation` | [`0xF60701793eD168ffd6e818e1DCcb600393297190`](https://base-sepolia.blockscout.com/address/0xF60701793eD168ffd6e818e1DCcb600393297190) | Pass - Verified |
| `TouchstoneEscrow`      | [`0x3eC06FFe8d5250d5Edf8Fff26b163aaaD65c8a00`](https://base-sepolia.blockscout.com/address/0x3ec06ffe8d5250d5edf8fff26b163aaad65c8a00) | Pass - Verified |

Full record — transaction hashes, block numbers, constructor arguments, compiler settings, and live smoke-test results — is canonical in [`data/deployments/base-sepolia.json`](./data/deployments/base-sepolia.json). **This README section is a convenience view generated from that file** (`node scripts/generate-readme-deployments.mjs`) and must never be hand-edited to disagree with it.

**Not deployed to mainnet.** Requirements before it can be:

- treasury MUST be a Safe/multisig, not an EOA. It is immutable with no setter, so a lost key makes fee revenue permanently unrecoverable and the only remedy is redeploying the escrow and migrating every integrator.
- Generate TOUCHSTONE_PUBLISHER_KEY on an air-gapped machine. The testnet key used here has passed through repository-adjacent files.
- Deploy.s.sol is chain-guarded to 84532; a mainnet deployment needs its own script and its own review.

### Verify a print independently

A print's own `signature` and `public_key` fields only prove internal consistency — that some
key signed this exact body. They cannot prove that key is Touchstone Assay's, because a tampered
file could carry a self-consistent signature over a different key entirely. Closing that gap is
the entire reason the publisher key is coupled to `TouchstoneAttestation`: the contract's `publisher` address is
immutable and lives outside the file, so it is a truth a tampered print cannot rewrite.

The loop:

1. Recompute the print's body hash independently (JCS-canonicalise the body minus its signature
   fields, keccak256 it).
2. Recover the signer's address from the raw `{signature, hash}` pair — not read from the
   print's own `public_key` field. (Recovery yields two address candidates, since the stored
   signature carries no recovery bit; exactly one matches a real signer.)
3. Compare the recovered address against `TouchstoneAttestation.publisher()`, read live from chain.
4. Confirm the same body hash is anchored (`postedAt(bodyHash) > 0`).

```bash
BASE_SEPOLIA_RPC_URL=... pnpm --filter @touchstone/print run verify-onchain <print-id> base-sepolia
```

No `TOUCHSTONE_PUBLISHER_KEY` is needed — this command only reads. Real output against the
worked-example print (docs/siu-worked-example.md, Dated SIU $0.0383) anchored on Base Sepolia:

```
On-chain publisher():        0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a
Recovered signer candidates: 0x7ab67ceaaf33b21336b0481b3e8a867b70503e35, 0x284ff2f8605ff8afeda6959b856bb7e6d48f845a
  -> MATCH (recovery id 1): this print was signed by the on-chain publisher.

postedAt(bodyHash): 1787035752
  -> ANCHORED at 2026-08-18T06:49:12.000Z

VERIFIED: signature matches the on-chain publisher AND the hash is anchored.
```

A print signed by any other key — or never anchored at all — reports `NOT VERIFIED` and exits
non-zero (verified live against Base Sepolia with an unrelated key: neither recovered
candidate matched `publisher()`, and `postedAt` read 0).

<!-- END GENERATED: deployments -->

## Historical event data needs an archive RPC

Public RPC endpoints prune old history. Confirmed live, 2026-09-27: `sepolia.base.org` now
refuses `eth_getBlockByNumber`/`eth_getLogs` for anything before block ~46,000,000 — which
includes this project's own August 2026 escrow deployment and smoke tests. Two different kinds
of read are affected very differently:

- **Current on-chain state is unaffected.** `verifyPrintOnChain` above (`postedAt(bodyHash)`,
  `publisher()`) reads `TouchstoneAttestation`'s own current storage, not historical logs — it
  works regardless of how old the anchored print is, and always will, on any node.
- **A historical event-log scan needs a real archive endpoint.** The console's own event indexer
  (`packages/console`) always scans from each contract's fixed deployment block, so it always
  needs one — set `TOUCHSTONE_<CHAIN>_ARCHIVE_RPC` (e.g. `TOUCHSTONE_BASE_SEPOLIA_ARCHIVE_RPC`)
  to a real archive-capable RPC URL (we use [Alchemy](https://www.alchemy.com/); its Base Sepolia
  endpoints serve full history on every tier — Infura is an equally standard alternative). The
  public endpoint is kept for current-state reads (`feeBps`/`treasury`/current block number)
  only.
- **`verify_receipt`'s own transaction-receipt lookup was checked, not assumed, against this same
  pruning event: it still succeeds for a real settlement from August 2026** — `getTransactionReceipt`
  by hash appears to survive on this provider's public endpoint longer than open-ended block/log
  range queries do. That is not a guarantee it always will, on this or any provider, so
  `OnChainSettlementReader`/`verify_receipt` also accept the same `TOUCHSTONE_<CHAIN>_ARCHIVE_RPC`
  as an optional override for verifying an old settlement, falling back to the public endpoint
  when unset.

**If you are independently verifying an old print or receipt and a historical read comes back
empty, this is almost certainly why** — the public endpoint's pruning horizon, not a real gap in
what was actually recorded. Configure an archive RPC before concluding otherwise.
