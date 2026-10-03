/**
 * Is the capacity pool actually whole before this run starts?
 *
 * **Why this exists.** §4.6z closed three routes by which capacity leaked *within* a run, and a
 * run's own close-out sweeps what it consumed. Nothing covered a run that **never reaches its
 * close-out**. On 2026-10-03 a debug run crashed on window 1 after minting a 10,000 mSIU claim;
 * its sweep never executed; the claim stayed outstanding; and the next run quietly started with
 * ISSUER-A at 38,000 of 48,000. Nobody noticed until the headroom line was read by hand
 * afterwards, and every subsequent run would have inherited the same shortfall.
 *
 * A carry-over is not necessarily wrong — a claim may legitimately still be live — but it must
 * be a **stated precondition** rather than a silent one, because scarcity is what this testbed
 * measures. Starting 12.5% short without saying so makes every capacity result that run
 * produces incomparable with the last.
 *
 * So: read live headroom, compare against the lots' own issuance limits, and if they differ say
 * exactly how much and against which issuer. The run then refuses to continue unless the
 * operator says the shortfall is expected.
 */
export interface LotExpectation {
  agentId: string;
  address: string;
  issuanceLimitMilliSiu: bigint;
}

export interface PoolReconciliation {
  whole: boolean;
  expectedTotal: bigint;
  actualTotal: bigint;
  shortfallTotal: bigint;
  perIssuer: {
    agentId: string;
    address: string;
    expected: bigint;
    actual: bigint;
    shortfall: bigint;
  }[];
}

/** Pure, so it is testable without a chain. The caller supplies the live readings. */
export function reconcilePool(
  lots: readonly LotExpectation[],
  liveHeadroom: ReadonlyMap<string, bigint>,
): PoolReconciliation {
  const perIssuer = lots.map((l) => {
    const actual = liveHeadroom.get(l.address.toLowerCase()) ?? 0n;
    return {
      agentId: l.agentId,
      address: l.address,
      expected: l.issuanceLimitMilliSiu,
      actual,
      // Negative shortfalls are not clamped away: headroom ABOVE the limit would mean the
      // deployment record and the chain disagree, which is a louder problem than a leak and
      // must not be hidden by a `Math.max`.
      shortfall: l.issuanceLimitMilliSiu - actual,
    };
  });
  const expectedTotal = perIssuer.reduce((s, r) => s + r.expected, 0n);
  const actualTotal = perIssuer.reduce((s, r) => s + r.actual, 0n);
  return {
    whole: perIssuer.every((r) => r.shortfall === 0n),
    expectedTotal,
    actualTotal,
    shortfallTotal: expectedTotal - actualTotal,
    perIssuer,
  };
}

/**
 * What the operator sees. Names the issuer and the amount, and says plainly that the run is
 * not comparable with one that started whole — which is the actual consequence, and the reason
 * a warning alone would not be enough.
 */
export function renderPoolReconciliation(r: PoolReconciliation, flag: string): string {
  if (r.whole) {
    return `Pool reconciled: ${r.actualTotal} mSIU, matching every lot's issuance limit.`;
  }
  const lines = [
    "=== POOL IS NOT WHOLE AT LAUNCH ===",
    `  expected ${r.expectedTotal} mSIU across the lots, found ${r.actualTotal} — ` +
      `short by ${r.shortfallTotal}.`,
  ];
  for (const p of r.perIssuer) {
    if (p.shortfall === 0n) continue;
    lines.push(
      p.shortfall > 0n
        ? `    ${p.agentId} ${p.address}: ${p.actual} of ${p.expected}, ${p.shortfall} consumed`
        : `    ${p.agentId} ${p.address}: ${p.actual} of ${p.expected} — ABOVE its limit, which ` +
          `means the deployment record and the chain disagree. Do not run.`,
    );
  }
  lines.push(
    "  Capacity consumed by an earlier run that never reached its own close-out stays consumed",
    "  (spec §4.6z covers leaks WITHIN a run; a crashed run reaches no sweep at all). Settle or",
    "  expire the outstanding claims, or state that the shortfall is expected.",
    "  Scarcity is what this testbed measures, so a run starting short is not comparable with",
    `  one starting whole. Pass ${flag} to proceed anyway, and the shortfall is recorded.`,
  );
  return lines.join("\n");
}

/**
 * Why a given claim is still holding capacity. The distinction that matters is **recoverable
 * versus leaked**, and it is not visible from a headroom figure alone.
 *
 * Run 17 ended in `blocked_awaiting_print` legitimately: a claim presented in the final window
 * cannot be settled until a print dated its close day exists, and the run-end sweep correctly
 * declines to settle it. That is not a leak, and a pre-flight that reported it the same way as
 * a crashed run's residue would push the operator to pass `--allow-partial-pool` every time.
 * **An override reached for routinely has stopped being a gate**, so the categories exist to
 * keep it rare.
 */
export type OutstandingCategory =
  /** Its delivery window has not closed. Entirely normal; nothing to do. */
  | "live"
  /** Closed, presented, and a print dated its close day exists: settle it and the bond pays
   *  the holder. Recoverable right now. */
  | "settleable_pays_holder"
  /** Closed and presented, but no print is dated its close day, so `settleWindowClose` would
   *  revert. Recoverable, blocked, and not anyone's mistake — this is how run 17 ended. */
  | "blocked_awaiting_print"
  /** Closed and never presented. Settling burns it and returns the capacity to its issuer,
   *  paying nobody (fsiu-design.md §4.3a). This is the shape a crashed run leaves behind. */
  | "settleable_pays_nobody";

export interface OutstandingClaim {
  tokenId: string;
  holder: string;
  issuerAgentId?: string;
  quantityMilliSiu: string;
  /** Unix seconds; the claim's own delivery-window close. */
  windowToUnix: number;
  everPresented: boolean;
}

/** `availablePrintDates` holds `YYYY-MM-DD` strings for every commodity print on disk. */
export function categorise(
  c: OutstandingClaim,
  nowUnix: number,
  availablePrintDates: ReadonlySet<string>,
): OutstandingCategory {
  if (c.windowToUnix > nowUnix) return "live";
  if (!c.everPresented) return "settleable_pays_nobody";
  const day = new Date(Math.floor(c.windowToUnix / 86400) * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  return availablePrintDates.has(day) ? "settleable_pays_holder" : "blocked_awaiting_print";
}

/** True only for the categories an operator should act on before running again. */
export function isRecoverableNow(cat: OutstandingCategory): boolean {
  return cat === "settleable_pays_holder" || cat === "settleable_pays_nobody";
}

export function renderOutstanding(
  claims: readonly (OutstandingClaim & { category: OutstandingCategory })[],
  scannedBlocks: number,
): string {
  if (claims.length === 0) {
    return (
      `  No outstanding claim found in the last ${scannedBlocks} blocks. The shortfall is ` +
      "therefore NOT explained — do not assume it is benign; it may predate the scan window."
    );
  }
  const label: Record<OutstandingCategory, string> = {
    live: "LIVE — window still open, nothing to do",
    settleable_pays_holder: "SETTLE NOW — presented, and the bond will pay its holder",
    blocked_awaiting_print: "BLOCKED — presented, but no print is dated its close day yet",
    settleable_pays_nobody: "SETTLE NOW — never presented, so this only returns the capacity",
  };
  const lines = [`  Outstanding claims found (scanned the last ${scannedBlocks} blocks):`];
  for (const c of claims) {
    lines.push(
      `    ${c.tokenId.slice(0, 18)}… ${c.quantityMilliSiu} mSIU, holder ${c.holder.slice(0, 10)}` +
        `${c.issuerAgentId ? `, issued by ${c.issuerAgentId}` : ""}\n      ${label[c.category]}`,
    );
  }
  const actionable = claims.filter((c) => isRecoverableNow(c.category));
  lines.push(
    actionable.length > 0
      ? `  ${actionable.length} of these can be settled right now, and should be before running again.`
      : "  None of these can be settled right now, so the shortfall is expected rather than leaked.",
  );
  return lines.join("\n");
}

/**
 * Discovering WHICH claims are holding the capacity, which needs the chain.
 *
 * Deliberately **bounded**: `eth_getLogs` on a public endpoint is capped at 1,000 blocks per
 * call, so this walks back a fixed number of chunks rather than the whole history. A shortfall
 * older than the window therefore comes back unexplained, and `renderOutstanding` says so
 * rather than reporting "none found" as though that were reassurance.
 *
 * The callbacks are injected so the categorisation above stays testable without a chain, and so
 * this can be pointed at a different RPC without the CLI knowing.
 */
export interface ClaimEnumerationDeps {
  latestBlock(): Promise<bigint>;
  /** Minted events in `[from, to]`, which is where tokenId and buyer both come from. */
  mintedIn(from: bigint, to: bigint): Promise<
    { tokenId: bigint; issuer: string; buyer: string; quantity: bigint; windowTo: bigint }[]
  >;
  balanceOf(tokenId: bigint, holder: string): Promise<bigint>;
  everPresented(tokenId: bigint, holder: string): Promise<boolean>;
  nowUnix(): Promise<bigint>;
}

export const DEFAULT_SCAN_CHUNKS = 50;
export const CHUNK_BLOCKS = 1000n;

export async function enumerateOutstanding(
  deps: ClaimEnumerationDeps,
  issuerAgentIdByAddress: ReadonlyMap<string, string>,
  availablePrintDates: ReadonlySet<string>,
  chunks: number = DEFAULT_SCAN_CHUNKS,
): Promise<{
  claims: (OutstandingClaim & { category: OutstandingCategory })[];
  scannedBlocks: number;
}> {
  const latest = await deps.latestBlock();
  const nowUnix = Number(await deps.nowUnix());
  const seen = new Map<string, OutstandingClaim>();
  let scanned = 0;
  for (let i = 0; i < chunks; i++) {
    const to = latest - BigInt(i) * CHUNK_BLOCKS;
    const from = to - CHUNK_BLOCKS + 1n;
    if (to < 0n) break;
    let minted: Awaited<ReturnType<ClaimEnumerationDeps["mintedIn"]>>;
    try {
      minted = await deps.mintedIn(from < 0n ? 0n : from, to);
    } catch {
      // One unreadable chunk is not a reason to abandon the scan, but it IS a reason not to
      // claim the scan was complete — the block count below reflects only what was read.
      continue;
    }
    scanned += Number(CHUNK_BLOCKS);
    for (const m of minted) {
      const key = `${m.tokenId}:${m.buyer.toLowerCase()}`;
      if (seen.has(key)) continue;
      const balance = await deps.balanceOf(m.tokenId, m.buyer);
      if (balance === 0n) continue; // burned, settled, or moved on — holding nothing now
      seen.set(key, {
        tokenId: m.tokenId.toString(),
        holder: m.buyer,
        ...(issuerAgentIdByAddress.get(m.issuer.toLowerCase()) !== undefined
          ? { issuerAgentId: issuerAgentIdByAddress.get(m.issuer.toLowerCase()) as string }
          : {}),
        quantityMilliSiu: balance.toString(),
        windowToUnix: Number(m.windowTo),
        everPresented: await deps.everPresented(m.tokenId, m.buyer),
      });
    }
  }
  return {
    claims: [...seen.values()].map((c) => ({
      ...c,
      category: categorise(c, nowUnix, availablePrintDates),
    })),
    scannedBlocks: scanned,
  };
}
