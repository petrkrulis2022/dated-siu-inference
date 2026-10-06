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
 *   raw work  — usdc, mint-and-forward, held balance … cycled by (k + j)
 * so each route is used at least twice across the eight jobs and eight units. A held-balance payment is made
 * only when a balance read says the trader holds enough, else it falls back to mint-and-forward and the walk
 * records that it did; a payment made from a balance that includes fSIU the trader RECEIVED is the "passed on"
 * case, which the verifier looks for in the loop's own payment records.
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
import { decimalToUnits } from "./money.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type JobRoute = "usdc" | "mint_forward" | "held" | "split";
export type RawRoute = "usdc" | "mint_forward" | "held";
export const JOB_ROUTES: readonly JobRoute[] = ["usdc", "mint_forward", "held", "split"];
export const RAW_ROUTES: readonly RawRoute[] = ["usdc", "mint_forward", "held"];

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
export const claimFor = (amountUsd: string, printNano: bigint): bigint =>
  (decimalToUnits(amountUsd, 6) * 1_000_000n + printNano - 1n) / printNano;

const traderIndex = (t: TraderLabel): number => LAB_TRADERS.indexOf(t) + 1;
export const plannedJobRoute = (t: TraderLabel, j: number): JobRoute => JOB_ROUTES[(traderIndex(t) + j) % JOB_ROUTES.length];
export const plannedRawRoute = (t: TraderLabel, j: number): RawRoute => RAW_ROUTES[(traderIndex(t) + j) % RAW_ROUTES.length];

/** The last `get_balances` this trader made, if it has made one since `afterTurn`. */
function balanceSince(history: readonly HistoryCall[], afterTurn: number, tokenId: string): bigint | undefined {
  const reads = history.filter((c) => c.tool === "get_balances" && !c.failed && c.turn > afterTurn);
  const last = reads.at(-1);
  if (last === undefined) return undefined;
  const claim = ((last.result as { claims?: { tokenId: string; balance: string }[] }).claims ?? []).find((c) => c.tokenId === tokenId);
  return claim === undefined ? 0n : BigInt(claim.balance);
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
  status: ScriptStatus;
}

export const newMemory = (): Memory => ({
  decided: new Map(),
  readAskedAt: new Map(),
  status: { decided: [], fellBack: [] },
});

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
  const claimQty = claimFor(quote.amountUsd, env.printNano);
  const finish = (used: string, intent: Intent, because?: string): { intent: Intent; note?: string } => {
    // Recorded once per request: a payment that failed and is tried again is still one decision.
    if (!mem.decided.has(id)) {
      mem.decided.set(id, { trader: me, kind });
      mem.status.decided.push({ trader: me, requestId: id, kind, planned, used });
      if (because !== undefined) mem.status.fellBack.push({ trader: me, requestId: id, planned, because });
    }
    return { intent, note: `${kind} ${id}: ${used}` };
  };

  if (planned === "usdc") return finish("usdc", { tool: "pay", args: { requestId: id, settler: ZERO_ADDRESS } });
  if (planned === "mint_forward") return finish("mint_forward", { tool: "pay_with_claim", args: { requestId: id } });
  if (planned === "split") {
    return finish("split", {
      tool: "settle_split",
      args: { requestId: id, claimQuantityMilliSiu: (claimQty / 2n).toString(), settler: ZERO_ADDRESS },
    });
  }

  // Held balance: read the balance first, then pay from it if it covers the quote's claim.
  const askedAt = mem.readAskedAt.get(id);
  if (askedAt === undefined) {
    const account = myAddress(prompt);
    mem.readAskedAt.set(id, turn);
    return { intent: { tool: "get_balances", args: { account, tokenIds: [tokenId] } } };
  }
  const balance = balanceSince(history, askedAt, tokenId);
  if (balance !== undefined && balance >= claimQty) {
    return finish("held", { tool: "transfer_claim", args: { agentId: sellerName, tokenId, requestId: id } });
  }
  return finish(
    "mint_forward",
    { tool: "pay_with_claim", args: { requestId: id } },
    balance === undefined ? "the balance read did not come back" : `holds ${balance} mSIU, the quote needs ${claimQty}`,
  );
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
