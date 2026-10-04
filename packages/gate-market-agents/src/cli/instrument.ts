/**
 * Which INSTRUMENT a run measured, as configuration — never code.
 *
 * "One issuer per window" must stay a property of a deployment record, so that a second serving
 * issuer can be plugged back into the same windows when cross-issuer fungibility is designed.
 * Nothing here hardcodes ISSUER-A or ISSUER-B, and nothing supporting several issuers per class is
 * removed or simplified: the router is still first-fit over `issuersForClass`, token ids still
 * carry the issuer, and every lot and bond is untouched. What differs between instruments is
 * which lots exist, the ORDER they were created in (which is routing priority), and what the
 * runner does between windows — all of it read from the record.
 *
 * A record with no `instrument` block is the fifth trio and runs exactly as it always has.
 */
import type { AgentId } from "../identity/resolve.js";

export const DEFAULT_DEPLOYMENT_FILE = "data/deployments/base-sepolia-gate-market.json";
export const FIFTH_TRIO_INSTRUMENT_ID = "fifth-trio-two-issuer";

/** Capacity an operator takes from one issuer after a window, so later windows route elsewhere. */
export interface DrainSpec {
  afterWindow: number;
  issuer: AgentId;
  /** Only `code` today. Named so the record says what is drained rather than the code assuming. */
  classId: "code";
  /** The drain claim's window ends with the run, so it holds through every later window and is
   *  returned by the same sweep that already returns the external buyer's capacity. */
  datedTo: "run_end";
}

export interface Topology {
  /** The order issuers bond lots in. Registration order IS routing priority (first-fit, and the
   *  issuer list is append-only), so this is declared in the record to let the deploy tool and a
   *  reader agree on it instead of inferring it from transaction order. */
  lotCreationOrder: AgentId[];
  /** The issuer each window's mints are EXPECTED to route to. Used for the F1-clean check and for
   *  reporting; it does not steer anything. */
  expectedIssuerByWindow: Record<number, AgentId>;
  drain?: DrainSpec;
  /** After the drain the router must return this issuer for a job-sized mint, or the run aborts. */
  routeAfterDrain?: AgentId;
}

export interface InstrumentSpec {
  id: string;
  description: string;
  topology?: Topology;
}

export function parseInstrumentFlags(argv: readonly string[]): { deploymentFile: string } {
  const at = argv.indexOf("--deployment");
  if (at === -1) return { deploymentFile: DEFAULT_DEPLOYMENT_FILE };
  const file = argv[at + 1];
  if (!file || file.startsWith("--")) {
    throw new Error("--deployment expects a path to a deployment record, relative to the repo root.");
  }
  return { deploymentFile: file };
}

/**
 * Reads and VALIDATES the instrument block. Validation is strict and runs before anything is
 * spent: a topology that cannot work should fail at launch, not after a window has run.
 */
export function instrumentOf(record: unknown): InstrumentSpec {
  const r = record as { instrument?: { id?: unknown; description?: unknown }; topology?: unknown };
  if (r.instrument === undefined) {
    return {
      id: FIFTH_TRIO_INSTRUMENT_ID,
      description:
        "Two issuers, claims routed at mint by first-fit, with the issuer that cannot serve " +
        "registered first. The instrument every run before 2026-10-04 measured.",
    };
  }
  if (typeof r.instrument.id !== "string" || r.instrument.id === "") {
    throw new Error("deployment record: instrument.id must be a non-empty string.");
  }
  const spec: InstrumentSpec = {
    id: r.instrument.id,
    description: typeof r.instrument.description === "string" ? r.instrument.description : "",
  };
  if (r.topology !== undefined) spec.topology = validateTopology(r.topology);
  return spec;
}

function validateTopology(raw: unknown): Topology {
  const t = raw as Partial<Topology>;
  const order = t.lotCreationOrder;
  if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length) {
    throw new Error("topology.lotCreationOrder must list each issuer once, in registration order.");
  }
  const known = new Set<string>(order);
  const expected = t.expectedIssuerByWindow ?? {};
  for (const [w, issuer] of Object.entries(expected)) {
    if (!Number.isInteger(Number(w)) || Number(w) < 1) {
      throw new Error(`topology.expectedIssuerByWindow: "${w}" is not a window number.`);
    }
    if (!known.has(issuer)) {
      throw new Error(`topology.expectedIssuerByWindow[${w}]: ${issuer} is not in lotCreationOrder.`);
    }
  }
  const drain = t.drain;
  if (drain !== undefined) {
    if (!Number.isInteger(drain.afterWindow) || drain.afterWindow < 1) {
      throw new Error("topology.drain.afterWindow must be a whole window number.");
    }
    if (!known.has(drain.issuer)) {
      throw new Error(`topology.drain.issuer ${drain.issuer} is not in lotCreationOrder.`);
    }
    if (drain.classId !== "code" || drain.datedTo !== "run_end") {
      throw new Error('topology.drain supports classId "code" and datedTo "run_end" only.');
    }
    // A drain with nothing to assert afterwards is a silent hope. It exists to make later windows
    // route somewhere specific, so the record must say where and the runner must check it.
    if (t.routeAfterDrain === undefined) {
      throw new Error("topology.drain requires routeAfterDrain: the router's expected choice.");
    }
    if (!known.has(t.routeAfterDrain) || t.routeAfterDrain === drain.issuer) {
      throw new Error("topology.routeAfterDrain must be a different issuer from the drained one.");
    }
  } else if (t.routeAfterDrain !== undefined) {
    throw new Error("topology.routeAfterDrain is set but there is no drain to follow.");
  }
  return {
    lotCreationOrder: order,
    expectedIssuerByWindow: Object.fromEntries(
      Object.entries(expected).map(([w, i]) => [Number(w), i]),
    ) as Record<number, AgentId>,
    ...(drain !== undefined ? { drain } : {}),
    ...(t.routeAfterDrain !== undefined ? { routeAfterDrain: t.routeAfterDrain } : {}),
  };
}

/**
 * Refuses to treat runs on different instruments as one population. The same rule as
 * `assertCountableForF1` for debug runs, for the same reason: a number that pools two instruments
 * describes neither.
 */
export function assertSameInstrument(
  runs: readonly { runId: string; instrument?: { id: string } | undefined }[],
): string {
  const ids = new Set(runs.map((r) => r.instrument?.id ?? FIFTH_TRIO_INSTRUMENT_ID));
  if (ids.size > 1) {
    throw new Error(
      `These runs measured different instruments (${[...ids].join(", ")}) and cannot be pooled: ` +
        runs.map((r) => `${r.runId}=${r.instrument?.id ?? FIFTH_TRIO_INSTRUMENT_ID}`).join(", "),
    );
  }
  return [...ids][0] ?? FIFTH_TRIO_INSTRUMENT_ID;
}
