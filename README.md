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

## Deployments

<!-- BEGIN GENERATED: deployments -->

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
