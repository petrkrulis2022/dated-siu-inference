import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { clientsFor } from "@touchstone/agents";
import { setupDevnet, CLASS_CODE, type DevnetHandle } from "./deploy.js";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import { signRateAttestation } from "../chain/rate-attestation.js";

/**
 * The property the user asked to see proven, not just asserted: `RateAttestationVerifier.sol`
 * hand-rolls its own EIP-712 domain separator and typed-data digest (see that file's own doc
 * comment for why — OZ's `EIP712` base pulls in an MCOPY-emitting dependency chain, incompatible
 * with this repo's Shanghai EVM pin). Every existing Foundry test signs with a Solidity helper
 * (`WorkClaim.t.sol`'s `_signRateAs`) that computes the same struct hash and domain the contract
 * itself does — a real cross-check of the domain separator's *value* (read live via
 * `claim.rateAttestationDomainSeparator()`, never recomputed by hand there), but never a
 * cross-check against an independent, off-chain EIP-712 implementation. If the domain here and
 * the domain the real print pipeline signs against (viem's `signTypedData`,
 * `chain/rate-attestation.ts`) ever diverged, every existing Foundry test would still pass.
 *
 * This suite closes that gap directly: `signRateAttestation` (real viem `signTypedData`, the same
 * function the print/gate-market pipeline itself calls) signs off-chain, and the real, unmodified,
 * `forge build`-compiled `WorkClaim` bytecode on a real anvil devnet (`setupDevnet()`) verifies
 * on-chain. No FFI (confirmed absent from `foundry.toml` and every CI workflow; this test uses the
 * devnet infrastructure this package already has instead of adding that surface).
 */
describe("rate attestation — viem signs off-chain, real Solidity verifies on-chain", () => {
  let devnet: DevnetHandle;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  const windowFrom = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const windowTo = windowFrom + 7n * 24n * 3600n;
  const quantity = 500n;
  const nanoUsdPerSiu = 10_700_000n; // arbitrary, real-scale rate — see WorkClaim.t.sol's own note
  const validUntil = 9_999_999_999n; // far future — expiry isn't what this suite is testing

  function mintArgs(signature: Hex) {
    return [
      CLASS_CODE,
      quantity,
      windowFrom,
      windowTo,
      { printId: "2026-09-25", nanoUsdPerSiu, validUntil },
      signature,
    ] as const;
  }

  it("accepts a genuine viem-signed attestation — the real cross-implementation round trip", async () => {
    const buyer = clientsFor(devnet.agents.ORCHESTRATOR.privateKeyHex, devnet.rpcUrl);

    const signature = await signRateAttestation(
      { printId: "2026-09-25", nanoUsdPerSiu, validUntil },
      devnet.deployment.network.chainId,
      devnet.deployment.workClaim.address as Hex,
      devnet.publisherPrivateKeyHex,
    );

    const receipt = await writeAndConfirm(buyer, {
      address: devnet.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "mint",
      args: mintArgs(signature),
    });
    expect(receipt.status).toBe("success");
  });

  it("rejects a viem-signed attestation for the wrong chainId — cross-chain replay is structurally blocked", async () => {
    const buyer = clientsFor(devnet.agents.ORCHESTRATOR.privateKeyHex, devnet.rpcUrl);

    // Same attestation, same real publisher key, wrong chainId in the domain — e.g. what a
    // genuine Base Sepolia (84532) attestation would look like if replayed against this Arc-style
    // devnet. Computed independently by viem, not by flipping Foundry's vm.chainId cheatcode.
    const wrongChainSignature = await signRateAttestation(
      { printId: "2026-09-25", nanoUsdPerSiu, validUntil },
      devnet.deployment.network.chainId + 1,
      devnet.deployment.workClaim.address as Hex,
      devnet.publisherPrivateKeyHex,
    );

    await expect(
      writeAndConfirm(buyer, {
        address: devnet.deployment.workClaim.address as Hex,
        abi: WORK_CLAIM_ABI,
        functionName: "mint",
        args: mintArgs(wrongChainSignature),
      }),
    ).rejects.toThrow();
  });

  it("rejects a viem-signed attestation for the wrong verifyingContract", async () => {
    const buyer = clientsFor(devnet.agents.ORCHESTRATOR.privateKeyHex, devnet.rpcUrl);

    const wrongContractSignature = await signRateAttestation(
      { printId: "2026-09-25", nanoUsdPerSiu, validUntil },
      devnet.deployment.network.chainId,
      devnet.deployment.capacityBond.address as Hex, // a real, deployed, but wrong contract
      devnet.publisherPrivateKeyHex,
    );

    await expect(
      writeAndConfirm(buyer, {
        address: devnet.deployment.workClaim.address as Hex,
        abi: WORK_CLAIM_ABI,
        functionName: "mint",
        args: mintArgs(wrongContractSignature),
      }),
    ).rejects.toThrow();
  });
});
