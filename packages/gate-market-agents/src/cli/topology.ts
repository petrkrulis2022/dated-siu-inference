/**
 * What the runner does between windows to make an instrument's topology hold, as pure decisions
 * the runner executes and the tests exercise without a chain.
 *
 * The runner is generic over `Topology` (see `instrument.ts`): nothing here names an issuer.
 */
import type { DrainSpec } from "./instrument.js";

/** What to do after a window, given the drain issuer's headroom read just now. */
export type DrainPlan =
  | { action: "none"; reason: string }
  | { action: "drain"; quantityMilliSiu: bigint };

export function planDrain(
  spec: DrainSpec | undefined,
  windowIndex: number,
  headroomMilliSiu: bigint,
): DrainPlan {
  if (spec === undefined) return { action: "none", reason: "no drain configured" };
  if (windowIndex !== spec.afterWindow) {
    return { action: "none", reason: `drain is after window ${spec.afterWindow}` };
  }
  if (headroomMilliSiu <= 0n) {
    // Agents already used all of it. Nothing to take, and the preconditions below still run, so
    // "already empty" is verified rather than assumed.
    return { action: "none", reason: "the issuer's headroom is already zero" };
  }
  return { action: "drain", quantityMilliSiu: headroomMilliSiu };
}

export interface AfterDrainReading {
  /** The drained issuer's headroom, read from a fresh client at a block at or beyond the drain's. */
  drainIssuerHeadroom: bigint;
  /** What `ClaimRouter.route` returned for a job-sized mint, or null if nobody could serve it. */
  routedTo: string | null;
  /** The address the record says the router must now choose. */
  expectedRoute: string;
}

/**
 * The preconditions for window 2. Both must hold.
 *
 * The router check is the stronger one: it is the actual routing decision, not an inference from a
 * headroom figure. It is also what distinguishes "A will get it" from "nobody can serve it" — the
 * second would read, to the classifier, as scarcity, which is the false reading §4.6af removed.
 * A failure here aborts the run with its own reason instead of producing a window that looks like
 * a market result.
 */
export function checkAfterDrain(r: AfterDrainReading): { ok: true } | { ok: false; reason: string } {
  if (r.drainIssuerHeadroom !== 0n) {
    return {
      ok: false,
      reason: `the drained issuer still has ${r.drainIssuerHeadroom} mSIU of headroom, so later windows could still route to it`,
    };
  }
  if (r.routedTo === null) {
    return {
      ok: false,
      reason: "no issuer can serve a job-sized mint, which is not the topology and must not be read as scarcity",
    };
  }
  if (r.routedTo.toLowerCase() !== r.expectedRoute.toLowerCase()) {
    return {
      ok: false,
      reason: `the router would send the next mint to ${r.routedTo}, not ${r.expectedRoute}`,
    };
  }
  return { ok: true };
}

/**
 * Was F1's window clean — every agent mint backed by the issuer the topology expects?
 *
 * Checked rather than assumed. First-fit falls through to the NEXT issuer the moment the first
 * one's headroom drops below a mint, so a window-1 mint could silently be backed by the
 * non-serving issuer if demand outran the lot — the contamination (64.1% of agent mints before
 * 2026-10-04) this instrument exists to remove.
 */
export function f1Clean(
  mints: readonly { issuer?: string }[],
  expectedIssuer: string,
): { clean: boolean; mints: number; backedByOthers: number } {
  const backedByOthers = mints.filter(
    (m) => m.issuer === undefined || m.issuer.toLowerCase() !== expectedIssuer.toLowerCase(),
  ).length;
  return { clean: backedByOthers === 0, mints: mints.length, backedByOthers };
}

/**
 * Reads a value until two consecutive reads agree, and returns it.
 *
 * Why a plain read is not enough here: a load-balanced public endpoint can serve a pre-write view
 * AFTER a transaction confirms (five documented instances), and a stale headroom is HIGH — it
 * shows capacity that is already consumed. Sizing the drain from it would over-ask, and first-fit
 * would then skip the drained issuer, which no longer has that much, and mint against the NEXT
 * one instead: draining the wrong issuer and leaving the right one full.
 *
 * Throws rather than returning an unsettled value. A drain sized from a number the endpoint will
 * not hold still is a drain nobody should trust.
 */
export async function readUntilStable<T>(
  read: () => Promise<T>,
  options: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let previous: T | undefined;
  let havePrevious = false;
  for (let i = 0; i < attempts; i++) {
    const current = await read();
    if (havePrevious && current === previous) return current;
    previous = current;
    havePrevious = true;
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw new Error(
    `the value did not settle across ${attempts} reads (last: ${String(previous)}); ` +
      "refusing to act on a figure the endpoint will not hold still",
  );
}
