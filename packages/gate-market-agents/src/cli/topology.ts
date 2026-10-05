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

const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

/**
 * Is a window's capacity what the topology says it is? Returns an ABORT REASON, or undefined.
 *
 * Both lots exist from deploy, so first-fit is decided by headroom alone: a single mint larger than
 * the serving issuer's remaining headroom is routed to the NEXT issuer, whose claims cannot be
 * served. In F1's window that would put non-serving claims into the measurement without a word.
 * Planned demand keeps a run clear of it — this is the net for the mint nobody planned.
 *
 * Checked after the window, by the same rule as the failed-drain check and for the same reason: an
 * instrument that is not in the state it claims measures nothing, and the next window would be
 * paid for to measure it. `operatorMintIssuers` is who backed the operator's own mints that window
 * (the external buyer), which draw on the same capacity. An unrecorded backer is contamination,
 * never a pass.
 */
export function windowContamination(
  windowIndex: number,
  capacityEvents: readonly { kind: string; issuer?: string }[],
  operatorMintIssuers: readonly (string | undefined)[],
  expectedIssuer: string,
): string | undefined {
  const isExpected = (issuer: string | undefined): boolean =>
    issuer !== undefined && issuer.toLowerCase() === expectedIssuer.toLowerCase();
  const mints = capacityEvents.filter((e) => MINT_KINDS.has(e.kind));
  const wrong = mints.filter((m) => !isExpected(m.issuer));
  const operatorWrong = operatorMintIssuers.filter((i) => !isExpected(i));
  if (wrong.length === 0 && operatorWrong.length === 0) return undefined;
  const who = (issuers: readonly (string | undefined)[]): string =>
    [...new Set(issuers.map((i) => i ?? "an issuer that was not recorded"))].join(", ");
  const parts: string[] = [];
  if (wrong.length > 0) {
    parts.push(
      `${wrong.length} of ${mints.length} agent mints were not backed by the expected issuer ` +
        `${expectedIssuer} (backed by ${who(wrong.map((m) => m.issuer))}; "not recorded" counts as wrong)`,
    );
  }
  if (operatorWrong.length > 0) {
    parts.push(`the operator's own mint was backed by ${who(operatorWrong)}, not ${expectedIssuer}`);
  }
  return `window ${windowIndex} is contaminated: ${parts.join("; ")}`;
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
