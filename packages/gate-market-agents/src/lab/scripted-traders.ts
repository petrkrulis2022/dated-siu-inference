/**
 * The scripted lab traders: every trader's decision comes from a fixed script, not a model. A debug mode, for
 * one purpose — to walk every route of the lab against the real chain with no model in the way, so that what
 * a model run finds is about models and not about plumbing.
 *
 * Never evidence of behaviour. The report of a scripted run says so and is never counted. No model is called,
 * so there is no agent whose choices could be reported, and a script is not told to prefer anything: it is
 * given a fixed assignment of routes to purchases whose only aim is that every route gets used.
 *
 * The seam is the same as the gate configuration's (`cli/scripted-policy.ts`): a script is an `Adapter` that
 * reads the same prompt a model would and returns the next tool call, so the loop, the tools, the board, the
 * guards, the wake gates, the validator and the chain are all the real ones.
 *
 * What it walks, by assignment (trader k = 1..4; j = that trader's j-th purchase of its kind, from 0):
 *   jobs      — usdc, mint-and-forward, held balance, split … cycled by (k + j)
 *   raw work  — usdc, mint-and-forward, held balance, split … cycled by (k + j)
 * so each route is used at least twice across the eight jobs and eight units. Every route has a price in
 * something the trader must hold — dollars for `pay`, dollars for the mint in `pay_with_claim` and the split,
 * fSIU for a held transfer — so before each payment the script reads its balances, uses the planned route if it
 * can afford it, else the one it can afford that the walk has used least, and the walk records where it had to. A payment that fails is
 * not repeated: the route is set aside and the balances read again. A payment made from a balance that includes
 * fSIU the trader RECEIVED is the "passed on" case, which the verifier looks for in the loop's own records.
 */
import type { Adapter, AdapterResult } from "@touchstone/harness";
import { LAB_TRADERS, type TraderLabel } from "./economy.js";
import {
  claimTokenId,
  deliveredIn,
  directoryOf,
  historyOf,
  myAddress,
  openNeeds,
  owedJobs,
  receivedQuotes,
  unitsHeld,
  whoAmI,
  type HistoryCall,
} from "./lab-cues.js";
import { openRequests, owedInUsdc } from "../cues/prompt-cues.js";
import { claimMintCostMinorUnits } from "../loop/parity.js";
import { claimForUsd, decimalToUnits } from "./money.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type JobRoute = "usdc" | "mint_forward" | "held" | "split";
export type RawRoute = JobRoute;
export const JOB_ROUTES: readonly JobRoute[] = ["usdc", "mint_forward", "held", "split"];
/** The brief lists the same four settlement calls "for a job and for a unit of raw work alike", so a unit may be split too. */
export const RAW_ROUTES: readonly RawRoute[] = ["usdc", "mint_forward", "held", "split"];

/** What a script needs that is not in a prompt: how to word a quote request. */
export interface ScriptedLabEnv {
  print: { printId: string; printHash: string; rateUsdPerSiu: string; indexVersion: string };
  /** The rates the guards accept: a job at the trade price, a unit of raw work at the print. */
  rates: { trade: string; raw: string };
  /** The size of a job and of a unit, as `request_quote` takes it ("1"). */
  sizeSiu: string;
  chain: string;
  quoteExpirySeconds: number;
  /** The print in nano-USD per SIU, to size a claim from a quote exactly as the loop does. */
  printNano: bigint;
}

/** One decision, in the shape the loop's own parser reads. */
export type Intent = { tool: string; args: Record<string, unknown> } | { wait: true };

/** What a seat did, for the verifier. */
export interface ScriptStatus {
  /** Payments the script DECIDED on; one that failed shows in the report's tool errors, not here. */
  decided: { trader: TraderLabel; requestId: string; kind: "job" | "raw"; planned: string; used: string }[];
  fellBack: { trader: TraderLabel; requestId: string; planned: string; because: string }[];
  /** A payment the trader could not afford by any route it has. */
  unaffordable: { trader: TraderLabel; requestId: string; usdcMinor: string; fsiuMilliSiu: string; needsMinor: string; needsMilliSiu: string }[];
}

const free = (intent: unknown): AdapterResult => ({
  text: JSON.stringify(intent),
  stopReason: "end_turn",
  usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 },
  latency_ms: 0,
  raw: {},
  deviations: [],
});

/** The claim a quote is sized to, as the loop sizes it (`loop/parity.ts`): its price's worth at the print, rounded up. */
export const claimFor = claimForUsd;

const traderIndex = (t: TraderLabel): number => LAB_TRADERS.indexOf(t) + 1;
export const plannedJobRoute = (t: TraderLabel, j: number): JobRoute => JOB_ROUTES[(traderIndex(t) + j) % JOB_ROUTES.length];
export const plannedRawRoute = (t: TraderLabel, j: number): RawRoute => RAW_ROUTES[(traderIndex(t) + j) % RAW_ROUTES.length];

/** What a trader holds, from its own `get_balances` read. */
export interface Funds {
  usdcMinor: bigint;
  fsiuMilliSiu: bigint;
}

/** The last `get_balances` this trader made since `afterTurn`, if it has made one and it succeeded. */
function fundsSince(history: readonly HistoryCall[], afterTurn: number, tokenId: string): Funds | undefined {
  const last = history.filter((c) => c.tool === "get_balances" && !c.failed && c.turn > afterTurn).at(-1);
  if (last === undefined) return undefined;
  const result = last.result as { usdc?: { integerMinorUnits?: string }; claims?: { tokenId: string; balance: string }[] };
  const claim = (result.claims ?? []).find((c) => c.tokenId === tokenId);
  return { usdcMinor: BigInt(result.usdc?.integerMinorUnits ?? "0"), fsiuMilliSiu: claim === undefined ? 0n : BigInt(claim.balance) };
}

/** Decides one turn from one prompt. Pure but for the memory it is handed. */
export function decide(prompt: string, env: ScriptedLabEnv, mem: Memory): { intent: Intent; note?: string } {
  const me = whoAmI(prompt);
  if (me === undefined) return { intent: { wait: true } };
  const dir = directoryOf(prompt);
  const tokenId = claimTokenId(prompt);
  const history = historyOf(prompt);
  const turn = history.reduce((m, c) => Math.max(m, c.turn), 0);
  const issuerId = dir["ISSUER-B"]?.sellerId;
  const sellerLabelOf = (sellerId: string): Counterparty | undefined =>
    (Object.entries(dir).find(([, v]) => v?.sellerId === sellerId)?.[0] as Counterparty | undefined);

  // 1. Answer a request addressed to me.
  const asked = openRequests(prompt)[0];
  if (asked !== undefined) return { intent: { tool: "issue_quote", args: { requestId: asked.requestId } } };

  // 2. Release a dollar escrow I have been paid into, once the job is delivered.
  const delivered = deliveredIn(history);
  const settled = new Set(history.filter((c) => c.tool === "settle_escrow" && !c.failed).map((c) => String(c.args.requestId)));
  const releasable = owedInUsdc(prompt).find((id) => delivered.has(id) && !settled.has(id));
  if (releasable !== undefined) return { intent: { tool: "settle_escrow", args: { requestId: releasable } } };

  // 3. Deliver a job I have been paid for, once I hold a unit of raw work.
  const owed = owedJobs(prompt);
  const units = unitsHeld(prompt) ?? 0;
  const toDeliver = owed.find((o) => !delivered.has(o.requestId));
  if (toDeliver !== undefined && units >= 1) return { intent: { tool: "deliver_job", args: { requestId: toDeliver.requestId } } };

  const quotes = receivedQuotes(prompt);

  // A payment the script decided on whose quote has left the board is one that went through.
  const shown = new Set(quotes.map((q) => q.requestId));
  const confirmed = (kind: "job" | "raw"): number =>
    [...mem.decided.entries()].filter(([id, d]) => d.trader === me && d.kind === kind && !shown.has(id)).length;

  // 4. Pay the issuer's quote for a unit of raw work.
  const rawQuote = issuerId === undefined ? undefined : quotes.find((q) => q.sellerId === issuerId);
  if (rawQuote !== undefined && tokenId !== undefined) {
    return pay(me, "raw", rawQuote, plannedRawRoute(me, confirmed("raw")), prompt, history, turn, tokenId, env, mem, "ISSUER-B");
  }

  // 5. Ask the issuer for a unit when I owe more deliveries than I hold or have ordered units for.
  const rawOrdered = history.filter((c) => c.tool === "request_quote" && c.args.sellerId === issuerId && !c.failed).length;
  const outstandingRaw = rawOrdered - confirmed("raw");
  if (toDeliver !== undefined && owed.length > units + Math.max(0, outstandingRaw) && issuerId !== undefined) {
    return { intent: requestQuote(env, dir["ISSUER-B"]!.model, issuerId, env.rates.raw) };
  }

  // 6. Pay a job quote I have received.
  const jobQuote = quotes.find((q) => q.sellerId !== issuerId);
  if (jobQuote !== undefined && tokenId !== undefined) {
    const seller = sellerLabelOf(jobQuote.sellerId);
    if (seller !== undefined) {
      return pay(me, "job", jobQuote, plannedJobRoute(me, confirmed("job")), prompt, history, turn, tokenId, env, mem, seller);
    }
  }

  // 7. Ask a seller for a job I now need.
  const need = openNeeds(prompt)[0];
  if (need !== undefined) {
    const to = dir[need.seller];
    if (to !== undefined) return { intent: requestQuote(env, to.model, to.sellerId, env.rates.trade) };
  }

  return { intent: { wait: true } };
}

type Counterparty = TraderLabel | "ISSUER-B";

export interface Memory {
  /** Payments the script has decided on, by request. Whether one went through is read off the board: a paid
   *  quote leaves it. */
  decided: Map<string, { trader: TraderLabel; kind: "job" | "raw" }>;
  /** The turn on which a balance read was asked for, per request. */
  readAskedAt: Map<string, number>;
  /** The route last tried for a request, and the turn it was tried on. */
  attempt: Map<string, { route: string; turn: number }>;
  /** Routes that failed for a request and are not tried again. */
  excluded: Map<string, Set<string>>;
  status: ScriptStatus;
}

export const newMemory = (): Memory => ({
  decided: new Map(),
  readAskedAt: new Map(),
  attempt: new Map(),
  excluded: new Map(),
  status: { decided: [], fellBack: [], unaffordable: [] },
});

const TOOL_OF_ROUTE: Record<string, string> = { usdc: "pay", mint_forward: "pay_with_claim", held: "transfer_claim", split: "settle_split" };
/** Where a trader turns when it cannot afford the planned route. Dollars first: they are the plainest. */
const FALLBACK_ORDER: readonly string[] = ["usdc", "held", "mint_forward", "split"];

function requestQuote(env: ScriptedLabEnv, model: string, sellerId: string, rate: string): Intent {
  return {
    tool: "request_quote",
    args: {
      siu: env.sizeSiu,
      model,
      rateUsdPerSiu: rate,
      indexVersion: env.print.indexVersion,
      printId: env.print.printId,
      printHash: env.print.printHash,
      sellerId,
      chain: env.chain,
      expiresInSeconds: env.quoteExpirySeconds,
      pattern: "fixed",
    },
  };
}

function pay(
  me: TraderLabel,
  kind: "job" | "raw",
  quote: { requestId: string; amountUsd: string },
  planned: JobRoute | RawRoute,
  prompt: string,
  history: readonly HistoryCall[],
  turn: number,
  tokenId: string,
  env: ScriptedLabEnv,
  mem: Memory,
  sellerName: string,
): { intent: Intent; note?: string } {
  const id = quote.requestId;
  const amountMinor = decimalToUnits(quote.amountUsd, 6);
  const claimQty = claimFor(quote.amountUsd, env.printNano);

  // A payment that was tried and failed is not tried again: set the route aside and read the balances afresh.
  const tried = mem.attempt.get(id);
  if (tried !== undefined) {
    const failed = history.some((c) => c.failed && c.turn > tried.turn && c.tool === TOOL_OF_ROUTE[tried.route]);
    if (failed) {
      const set = mem.excluded.get(id) ?? new Set<string>();
      set.add(tried.route);
      mem.excluded.set(id, set);
      mem.readAskedAt.delete(id);
      mem.attempt.delete(id);
    }
  }

  const readBalances = (): { intent: Intent } => {
    mem.readAskedAt.set(id, turn);
    return { intent: { tool: "get_balances", args: { account: myAddress(prompt), tokenIds: [tokenId] } } };
  };
  const askedAt = mem.readAskedAt.get(id);
  if (askedAt === undefined) return readBalances();
  const funds = fundsSince(history, askedAt, tokenId);
  // The read has not come back, or failed: ask again rather than pay blind.
  if (funds === undefined) return readBalances();

  const affordable = (route: string): boolean => {
    switch (route) {
      case "usdc":
        return funds.usdcMinor >= amountMinor;
      case "mint_forward":
        return funds.usdcMinor >= claimMintCostMinorUnits(claimQty, env.printNano);
      case "held":
        return funds.fsiuMilliSiu >= claimQty;
      case "split":
        // Half the claim minted, the rest in dollars: together about the whole price, so require it.
        return funds.usdcMinor >= amountMinor;
      default:
        return false;
    }
  };
  const allowed = (route: string): boolean => !(mem.excluded.get(id)?.has(route) ?? false);
  // Among the routes it can afford, the one used least so far in this walk (the planned route, then the fallback
  // order, break ties): a trader's balances change as it trades, so a fixed plan cannot promise every route is
  // reached, and what the walk is for is that each one is.
  const order = [planned as string, ...FALLBACK_ORDER.filter((r) => r !== planned)];
  const usedCount = (r: string): number => mem.status.decided.filter((d) => d.kind === kind && d.used === r && d.requestId !== id).length;
  const route = order
    .filter((r) => allowed(r) && affordable(r))
    .sort((a, b) => usedCount(a) - usedCount(b) || order.indexOf(a) - order.indexOf(b))[0];

  if (route === undefined) {
    if (!mem.status.unaffordable.some((u) => u.requestId === id)) {
      mem.status.unaffordable.push({
        trader: me,
        requestId: id,
        usdcMinor: funds.usdcMinor.toString(),
        fsiuMilliSiu: funds.fsiuMilliSiu.toString(),
        needsMinor: amountMinor.toString(),
        needsMilliSiu: claimQty.toString(),
      });
    }
    return { intent: { wait: true } };
  }

  mem.attempt.set(id, { route, turn });
  // Recorded once per request, with the route last tried: a payment that failed and was set aside is one
  // decision whose final route is what the report states.
  const existing = mem.status.decided.find((d) => d.requestId === id);
  if (existing === undefined) {
    mem.decided.set(id, { trader: me, kind });
    mem.status.decided.push({ trader: me, requestId: id, kind, planned, used: route });
  } else {
    existing.used = route;
  }
  // A fall back is the planned route being out of reach, not another being chosen for coverage.
  if (!affordable(planned) && route !== planned && !mem.status.fellBack.some((f) => f.requestId === id)) {
    mem.status.fellBack.push({
      trader: me,
      requestId: id,
      planned,
      because: `holds ${funds.usdcMinor} USDC minor units and ${funds.fsiuMilliSiu} mSIU; the quote is ${amountMinor} and ${claimQty} mSIU`,
    });
  }

  const intent: Intent =
    route === "usdc"
      ? { tool: "pay", args: { requestId: id, settler: ZERO_ADDRESS } }
      : route === "mint_forward"
        ? { tool: "pay_with_claim", args: { requestId: id } }
        : route === "held"
          ? { tool: "transfer_claim", args: { agentId: sellerName, tokenId, requestId: id } }
          : { tool: "settle_split", args: { requestId: id, claimQuantityMilliSiu: (claimQty / 2n).toString(), settler: ZERO_ADDRESS } };
  return { intent, note: `${kind} ${id}: ${route}` };
}

export interface ScriptedLabTraders {
  adapters: Record<TraderLabel, Adapter>;
  status(): ScriptStatus;
}

export function scriptedLabTraders(env: ScriptedLabEnv): ScriptedLabTraders {
  const mem = newMemory();
  const adapter: Adapter = async (_model, prompt) => free(decide(prompt, env, mem).intent);
  return {
    adapters: Object.fromEntries(LAB_TRADERS.map((t) => [t, adapter])) as Record<TraderLabel, Adapter>,
    status: () => mem.status,
  };
}
