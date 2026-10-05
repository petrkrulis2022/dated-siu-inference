import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http, type Hex } from "viem";
import { repoRoot } from "../chain/deployment.js";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { explainToolError, PLAIN_ERRORS } from "./plain-errors.js";

/** The contracts an agent's calls can reach. `WorkClaim` inherits the verifier and the 1155 base. */
const SOURCES = ["WorkClaim", "CapacityBond", "ClaimRouter", "TouchstoneEscrow", "RateAttestationVerifier"];

/** `error Name(uint256 a, bytes32 b)` -> `Name(uint256,bytes32)`: the canonical signature. */
function declaredErrors(): string[] {
  const found: string[] = [];
  for (const name of SOURCES) {
    const src = readFileSync(join(repoRoot(), "packages/contracts/src", `${name}.sol`), "utf-8");
    for (const m of src.matchAll(/^\s*error\s+([A-Za-z0-9_]+)\(([^)]*)\)/gm)) {
      const types = m[2].trim() === "" ? [] : m[2].split(",").map((p) => p.trim().split(/\s+/)[0]);
      found.push(`${m[1]}(${types.join(",")})`);
    }
  }
  return found;
}

describe("PLAIN_ERRORS", () => {
  it("has a plain sentence for EVERY custom error the agent-reachable contracts declare", () => {
    // Parsed from the Solidity itself, so a new error cannot ship unexplained: an agent handed a
    // bare four-byte selector has been told nothing (`ReservationExists()` was shown to one raw).
    const declared = declaredErrors();
    expect(declared.length).toBeGreaterThan(30); // the parse found them; an empty parse is not a pass
    const missing = declared.filter((sig) => PLAIN_ERRORS[sig] === undefined);
    expect(missing, `errors with no plain sentence: ${missing.join(", ")}`).toEqual([]);
  });

  it("writes every sentence for an agent: no selector, no contract jargon, a full sentence", () => {
    for (const [sig, text] of Object.entries(PLAIN_ERRORS)) {
      expect(text, sig).not.toMatch(/0x[0-9a-f]{8}/i);
      expect(text, sig).not.toMatch(/\(\)/);
      expect(text.length, sig).toBeGreaterThan(20);
    }
  });
});

/** The shape viem gives for a revert, as seen in the first debug run (addresses shortened). */
const viemMessage = (reasonBlock: string): string =>
  `The contract function "reserveForWork" reverted ${reasonBlock}\n\nContract Call:\n` +
  `  address:   0x667c3cc8a7bC55aF128a83BE560c9C0264B744B4\n` +
  `  function:  reserveForWork(bytes32 quoteHash, bytes32 classId, uint256 quantity)\n` +
  `  args:                    (0x03a3c4, 0x2dc081, 4000)\n  sender:    0x2cd53E449F6cF45c51f600e167b4D2630128c8F3\n\n` +
  `Docs: https://viem.sh/docs/contract/decodeErrorResult\nDetails: execution reverted\nVersion: viem@2.55.16`;

describe("explainToolError", () => {
  it("turns the exact undecodable error from the first debug run into a sentence", () => {
    const raw = viemMessage(
      'with the following signature:\n0x73f18ad7\n\nUnable to decode signature "0x73f18ad7" as it was not found on the provided ABI.\nMake sure you are using the correct ABI and that the error exists on it.',
    );
    const out = explainToolError(new Error(raw));
    expect(out).toBe("you have already reserved capacity for this quote.");
  });

  it("explains the USDC string reasons the real token throws", () => {
    const out = explainToolError(new Error(viemMessage("with the following reason:\nERC20: transfer amount exceeds allowance")));
    expect(out).toMatch(/has not approved enough USDC/);
    expect(explainToolError(new Error(viemMessage("with the following reason:\nERC20: transfer amount exceeds balance")))).toMatch(
      /does not hold enough USDC/,
    );
  });

  it("explains a custom error that arrives by name or inside a 'custom error 0x…:' detail", () => {
    expect(explainToolError(new Error(viemMessage("with the following reason:\nNoReservation()")))).toBe(
      "no capacity has been reserved for this quote.",
    );
    // The form a local node gives, carrying the encoded arguments after the selector.
    const sel = Object.keys(PLAIN_ERRORS).find((s) => s.startsWith("NoIssuerWithHeadroom"))!;
    expect(sel).toBeDefined();
  });

  it("never shows an agent the call dump: no address, argument list, sender or docs link", () => {
    for (const reason of ["with the following reason:\nERC20: transfer amount exceeds allowance", "with the following signature:\n0x12345678"]) {
      const out = explainToolError(new Error(viemMessage(reason)));
      expect(out).not.toMatch(/Contract Call|args:|sender:|viem\.sh|0x[0-9a-fA-F]{8}/);
    }
  });

  it("falls back to a short, honest sentence for a revert it has no entry for — still without the dump", () => {
    const out = explainToolError(new Error(viemMessage("with the following signature:\n0xdeadbeef")));
    expect(out).toMatch(/the chain refused this call/i);
    expect(out).not.toMatch(/Contract Call|args:|0xdeadbeef/);
  });

  it("leaves an error that is not a chain revert exactly as it was — those are already written for the agent", () => {
    const own = 'pay_with_claim: no issued quote found for request "qr-9".';
    expect(explainToolError(new Error(own))).toBe(own);
    expect(explainToolError("plain string")).toBe("plain string");
  });
});

describe("the table against the deployed bytecode", () => {
  let devnet: DevnetHandle;
  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);
  afterAll(async () => {
    await devnet.stop();
  });

  // Real viem error objects from real reverts: the selectors in the table must be the ones the
  // contracts actually emit, which hand-written samples cannot show.
  async function revertFrom(functionName: "releaseReservation" | "presentForRedemption", args: readonly unknown[]): Promise<unknown> {
    const pc = createPublicClient({ transport: http(devnet.rpcUrl) });
    try {
      await pc.simulateContract({
        account: devnet.agents.ORCHESTRATOR.address,
        address: devnet.deployment.workClaim.address as Hex,
        // The shipped ABI fragment omits the contracts' custom errors, which is exactly how an agent
        // came to be handed a raw selector.
        abi: WORK_CLAIM_ABI,
        functionName,
        args: args as never,
      });
    } catch (err) {
      return err;
    }
    throw new Error(`${functionName} did not revert`);
  }

  it("explains a real NoReservation revert and a real NothingToPresent revert", async () => {
    const none = `0x${"11".repeat(32)}` as Hex;
    expect(explainToolError(await revertFrom("releaseReservation", [none]))).toBe("no capacity has been reserved for this quote.");
    expect(explainToolError(await revertFrom("presentForRedemption", [123456789n, none]))).toMatch(/hold none of this claim|does not exist/);
  }, 60_000);
});
