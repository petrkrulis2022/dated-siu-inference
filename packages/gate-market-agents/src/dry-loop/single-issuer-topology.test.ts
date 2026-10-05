import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { CLASS_CODE, setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { ViemChainReader } from "../chain/reader.js";
import { buildRunners, signDryLoopRateAttestation } from "./context.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import { checkAfterDrain, planDrain, windowContamination } from "../cli/topology.js";
import { instrumentOf } from "../cli/instrument.js";

/**
 * The single-issuer instrument's topology, on real bytecode.
 *
 * Lots are created B-then-A and sized as the instrument sizes them — B 32,000 and A 48,000 mSIU
 * (640 and 960 committed hours at the devnet's fixed 100 mSIU/hour and the 0.5 issuance ratio).
 * Every claim in this file is about what the REAL `ClaimRouter` does, because the whole design
 * rests on one fact about it: it is first-fit over a registration-ordered, append-only list, so
 * which issuer a window routes to is decided by creation order and headroom, never by absence.
 *
 * Own devnet: the scenario drains an issuer to exactly zero, which would break any other test
 * sharing the instance.
 */
describe("the single-issuer topology — B first, drained after window 1, then A", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;
  let reader: ViemChainReader;

  const B = (): Hex => devnet.agents["ISSUER-B"].address;
  const A = (): Hex => devnet.agents["ISSUER-A"].address;
  const JOB = 10_000n;

  beforeAll(async () => {
    devnet = await setupDevnet({
      lotCreationOrder: ["ISSUER-B", "ISSUER-A"],
      lotHours: {
        "ISSUER-B": { code: 640n, extract: 1000n },
        "ISSUER-A": { code: 960n, extract: 1000n },
      },
    });
    runners = buildRunners(devnet);
    reader = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  const windowTimes = () => {
    const now = Math.floor(Date.now() / 1000);
    return { windowFrom: now - 60, windowTo: now + 3600 };
  };

  async function mint(quantity: bigint, turn: number): Promise<Hex> {
    const { windowFrom, windowTo } = windowTimes();
    const att = await signDryLoopRateAttestation(devnet, windowTo);
    const rec = await runners.ORCHESTRATOR.callTool(
      "mint_claim",
      { classId: CLASS_CODE, quantity: quantity.toString(), windowFrom, windowTo, ...att },
      { turn, jobId: "single-issuer-topology" },
    );
    return (rec.result as { issuer: Hex }).issuer;
  }

  const headroomOf = async (issuer: Hex) => reader.headroom(issuer, CLASS_CODE as Hex);

  it("registers B first, so registration order — not absence — is what routes window 1", async () => {
    // The central design fact. A has a code lot from the start; it is simply behind B in a
    // first-fit list. That is what holds for ALL five runs of a block, whereas "A has no lot until
    // window 2" can only ever be true of the first.
    expect((await reader.issuersForClass(CLASS_CODE as Hex)).map((a) => a.toLowerCase())).toEqual([
      B().toLowerCase(),
      A().toLowerCase(),
    ]);
    expect(await headroomOf(B())).toBe(32_000n);
    expect(await headroomOf(A())).toBe(48_000n);
  });

  it("routes every window-1 mint to B, though A has more headroom, and then empties B and routes to A", async () => {
    // Window 1's demand: the gate job, WORKER-CODE's testing purchase, and the external buyer.
    expect((await reader.routeFor(CLASS_CODE as Hex, JOB))?.toLowerCase()).toBe(B().toLowerCase());
    for (const [i, qty] of [10_000n, 4_000n, 3_000n].entries()) {
      const issuer = await mint(qty, i + 1);
      expect(issuer.toLowerCase(), `window-1 mint #${i + 1} of ${qty}`).toBe(B().toLowerCase());
    }
    // 32,000 - 17,000: still above a job, so first-fit would STILL pick B for the next one. This is
    // why the drain is needed at all — sizing alone does not move routing.
    const afterWindow1 = await headroomOf(B());
    expect(afterWindow1).toBe(15_000n);
    expect((await reader.routeFor(CLASS_CODE as Hex, JOB))?.toLowerCase()).toBe(B().toLowerCase());

    // The drain: plan it from the configuration's own shape, take exactly what is left, from B.
    const spec = instrumentOf({
      instrument: { id: "single-issuer-windows" },
      topology: {
        lotCreationOrder: ["ISSUER-B", "ISSUER-A"],
        expectedIssuerByWindow: { 1: "ISSUER-B", 2: "ISSUER-A", 3: "ISSUER-A" },
        drain: { afterWindow: 1, issuer: "ISSUER-B", classId: "code", datedTo: "run_end" },
        routeAfterDrain: "ISSUER-A",
      },
    });
    const plan = planDrain(spec.topology?.drain, 1, afterWindow1);
    expect(plan).toEqual({ action: "drain", quantityMilliSiu: 15_000n });
    const drained = await mint(15_000n, 4);
    expect(drained.toLowerCase(), "the drain itself must land on B").toBe(B().toLowerCase());

    // Both preconditions, read through the same reader the runner uses.
    const reading = {
      drainIssuerHeadroom: await headroomOf(B()),
      routedTo: await reader.routeFor(CLASS_CODE as Hex, JOB),
      expectedRoute: A(),
    };
    expect(reading.drainIssuerHeadroom).toBe(0n);
    expect(reading.routedTo?.toLowerCase()).toBe(A().toLowerCase());
    expect(checkAfterDrain(reading)).toEqual({ ok: true });

    // And a real mint now goes to A: the topology holds for the transaction, not just the view.
    expect((await mint(JOB, 5)).toLowerCase()).toBe(A().toLowerCase());
  }, 180_000);

  it("a failed precondition is detectable BEFORE window 2, and is not mistaken for scarcity", async () => {
    // With B drained and A holding 38,000, drain A too and nobody can serve a job: the router
    // reverts, `routeFor` reports null, and the check names it as not-the-topology.
    const left = await headroomOf(A());
    await mint(left, 6);
    expect(await headroomOf(A())).toBe(0n);
    const routedTo = await reader.routeFor(CLASS_CODE as Hex, JOB);
    expect(routedTo).toBeNull();
    const verdict = checkAfterDrain({ drainIssuerHeadroom: 0n, routedTo, expectedRoute: A() });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/must not be read as scarcity/);
  }, 120_000);
});

describe("the window-1 fallback, on real bytecode — one oversized mint falls through to the non-serving issuer", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet({
      lotCreationOrder: ["ISSUER-B", "ISSUER-A"],
      lotHours: { "ISSUER-B": { code: 640n, extract: 1000n }, "ISSUER-A": { code: 960n, extract: 1000n } },
    });
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  async function mintIssuer(quantity: bigint, turn: number): Promise<Hex> {
    const now = Math.floor(Date.now() / 1000);
    const att = await signDryLoopRateAttestation(devnet, now + 3600);
    const rec = await runners.ORCHESTRATOR.callTool(
      "mint_claim",
      { classId: CLASS_CODE, quantity: quantity.toString(), windowFrom: now - 60, windowTo: now + 3600, ...att },
      { turn, jobId: "window-1-fallback" },
    );
    return (rec.result as { issuer: Hex }).issuer;
  }

  it("a mint within B's headroom is clean, and one larger than it routes to A and is caught", async () => {
    const B = devnet.agents["ISSUER-B"].address;
    const A = devnet.agents["ISSUER-A"].address;

    // Planned demand: nothing to report.
    const planned = await mintIssuer(10_000n, 1);
    expect(planned.toLowerCase()).toBe(B.toLowerCase());
    expect(windowContamination(1, [{ kind: "mint_claim", issuer: planned }], [], B)).toBeUndefined();

    // The unplanned one: 22,000 mSIU remain on B, so 25,000 does not fit and the REAL router sends
    // it to A. The event is built from what the chain actually returned, not from an assumption.
    const fell = await mintIssuer(25_000n, 2);
    expect(fell.toLowerCase(), "the real router must have fallen through to A").toBe(A.toLowerCase());
    const why = windowContamination(
      1,
      [
        { kind: "mint_claim", issuer: planned },
        { kind: "mint_claim", issuer: fell },
      ],
      [],
      B,
    );
    expect(why).toMatch(/window 1 is contaminated: 1 of 2 agent mints/);
    expect(why).toContain(A);
  }, 120_000);
});
