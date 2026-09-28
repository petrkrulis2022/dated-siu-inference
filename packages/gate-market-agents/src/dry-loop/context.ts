import type { Hex } from "viem";
import type { Print } from "@touchstone/sdk";
import { runGateHardeningChecks } from "@touchstone/task-pack-gate-hardening";
import { Runner } from "../runner.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ViemChainReader } from "../chain/reader.js";
import { signRateAttestation, SERIES_COMMODITY, unixDayStart } from "../chain/rate-attestation.js";
import type { RunnerDeps } from "../deps.js";
import { AGENT_IDS, type AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";

/** nanoUsdPerSiu for every mint/settle call in the dry loop — an illustrative devnet fixture
 * value (see WorkClaim.t.sol's own `PRICE_MICRO_USD_PER_SIU` precedent, rescaled: $0.01/SIU was
 * 10_000 in the old 1e6 "micro" scale WorkClaim.sol no longer uses), not derived from any real
 * print. No model or real print lookup happens in this scripted loop. */
export const DRY_LOOP_NANO_USD_PER_SIU = 10_000_000n; // $0.01/SIU, illustrative

const DRY_LOOP_PRINT: Print = {
  version: "SIU-2026a",
  print_id: "dry-loop-illustrative",
  date: "2026-09-22",
  status: "provisional",
  basket_costs: [],
  weights: { source: "equal", values: [] },
  dated_siu: "0.0100",
  exchange_rate_table: [],
} as unknown as Print;

/** The tool-call args shape mint_claim/settle_window_close now need — see
 * RateAttestationVerifier.sol's own doc comment for what's verified. `nanoUsdPerSiu`/`validUntil`/
 * `printDate` are decimal strings, matching every other tool's own money-string convention.
 * `series` fixed to commodity — the same illustrative grade every dry-loop scenario's claims use,
 * added 2026-09-27 alongside `printDate` (see `RateAttestation`'s own doc comment for why). */
export interface DryLoopRateAttestationArgs {
  printId: string;
  series: Hex;
  printDate: string;
  nanoUsdPerSiu: string;
  validUntil: string;
  signature: Hex;
}

/** Signs one real, genuine rate attestation for `DRY_LOOP_PRINT`'s illustrative rate, using the
 * real publisher key this specific devnet's `WorkClaim` was deployed to trust
 * (`devnet.publisherPrivateKeyHex` — see devnet/deploy.ts). `validUntil` is generous (1 real day
 * from the moment of signing) since a dry-loop run completes in seconds, not because expiry
 * itself is untested — `runner.test.ts`/a dedicated Foundry test covers that edge directly.
 * Callers sign once per scenario run and reuse the same attestation across every mint/settle
 * call in it, exactly like a real caller would reuse one day's real signed rate.
 *
 * `claimWindowTo` — the specific claim's own real window-close Unix timestamp (each scenario
 * computes its own, relative to wall-clock `now`, never `DRY_LOOP_PRINT`'s own fixed illustrative
 * `date`) — added 2026-09-27 alongside `series`/`printDate`: `settleWindowClose` requires
 * `printDate` to equal the *specific claim's own* default date, not a fixed historical one, so a
 * scenario that settles a real default needs this to genuinely match the claim it mints.
 */
export async function signDryLoopRateAttestation(
  devnet: DevnetHandle,
  claimWindowTo: number,
): Promise<DryLoopRateAttestationArgs> {
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  const printDate = unixDayStart(BigInt(claimWindowTo));
  const signature = await signRateAttestation(
    {
      printId: DRY_LOOP_PRINT.print_id,
      series: SERIES_COMMODITY,
      printDate,
      nanoUsdPerSiu: DRY_LOOP_NANO_USD_PER_SIU,
      validUntil,
    },
    devnet.deployment.network.chainId,
    devnet.deployment.workClaim.address as Hex,
    devnet.publisherPrivateKeyHex,
  );
  return {
    printId: DRY_LOOP_PRINT.print_id,
    series: SERIES_COMMODITY,
    printDate: printDate.toString(),
    nanoUsdPerSiu: DRY_LOOP_NANO_USD_PER_SIU.toString(),
    validUntil: validUntil.toString(),
    signature,
  };
}

/** No spend/turn ceiling is under test here (that's `runner.test.ts`'s job) — generous limits
 * so the scripted sequences never trip it by accident. */
function generousCeiling(): BudgetCeiling {
  const limits = Object.fromEntries(
    AGENT_IDS.map((id) => [
      id,
      { maxUsdcSpend: "1000000", maxInferenceTurns: 100000, maxInferenceUsd: "1000000" },
    ]),
  ) as Record<
    AgentId,
    { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }
  >;
  return new BudgetCeiling(limits);
}

/** One `Runner` per roster agent, wired to the real devnet's real, unmodified contracts — the
 * same `RunnerDeps` shape `runner.test.ts`'s mocked unit tests use, but every field here is
 * real: a real `ViemChainReader`, the real sandboxed `runGateHardeningChecks`. This is what
 * makes the dry loop a genuine end-to-end proof rather than another layer of mocking. */
export function buildRunners(devnet: DevnetHandle): Record<AgentId, Runner> {
  const deps: RunnerDeps = {
    chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
    deployment: devnet.deployment,
    // The devnet's own real TouchstoneEscrow, deployed by DeployGateMarketLocal.s.sol alongside
    // the rest. It used to be a dead placeholder, which was harmless while no dry-loop scenario
    // touched the USDC route — it stopped being harmless once `reserveForWork` began reading real
    // escrow state to decide whether a reservation may exist at all.
    escrowAddress: devnet.escrowAddress,
    runGateHardeningChecks,
    loadPrint: async () => DRY_LOOP_PRINT,
    isReconciled: async () => false,
  };

  const ceiling = generousCeiling();
  const runners = {} as Record<AgentId, Runner>;
  for (const agentId of AGENT_IDS) {
    runners[agentId] = new Runner({
      agentId,
      windowId: "dry-loop",
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      rpcUrl: devnet.rpcUrl,
      deps,
      ceiling,
    });
  }
  return runners;
}
