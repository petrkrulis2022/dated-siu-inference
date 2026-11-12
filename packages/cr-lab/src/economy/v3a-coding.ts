/**
 * v3a's blind coding of the account measure (docs/experiment-3a-design.md, "How blind coding works"): two different models code every priced decision for the unit its
 * reasoning uses -- SIU, dollars, both or none -- without seeing arm, run or agent; Petr hand-codes a random 10%; if the two coders' agreement (Cohen's kappa) is below
 * 0.7, the account measure reports n/a.
 *
 * Built, not run (Phase 3): `extractPricedDecisions` and `blindItems` prepare the items, `codeAll` runs any `Coder` over them, `modelCoder` makes a coder from a tool chat
 * (forced to answer through one tool with the four labels), `handSample` draws the 10%, and `kappa` scores agreement. Running the model coders spends money and waits for
 * the owner's go.
 *
 * A priced decision is an executed turn that states or accepts a price (a quote, an acceptance, an offer PROVIDER posts, a purchase or order of claims ahead, a request
 * for claims) or a message that names an amount (a counter-offer). Its text is the agent's own stated reasoning for that turn, with every agent id masked.
 */
import { createHash } from "node:crypto";
import type { McpToolDef } from "../mcp/types.js";
import type { ToolChat } from "../mcp/tool-loop.js";
import { SeedStream } from "../tasks/seeds.js";
import type { LogEntry } from "./log.js";

export const UNIT_LABELS = ["SIU", "dollars", "both", "none"] as const;
export type UnitLabel = (typeof UNIT_LABELS)[number];

/** the two coder models proposed for the owner's approval (Phase 3 report): different families, both reachable with the trial's existing tool loops and keys */
export const PROPOSED_CODERS = ["gpt-5.1", "claude-haiku-5-5"] as const;
export const KAPPA_FLOOR = 0.7;
export const HAND_SHARE_BPS = 1_000;

const PRICED_TOOLS = new Set(["post_quote", "accept_quote", "post_offer", "buy_offer", "order_front_claim", "request_claims"]);
/** a message that names an amount: a counter-offer */
const AMOUNT_IN_TEXT = /\$\s?\d|\d[\d,]*\s*(?:m?siu|µ\$|usd|usdc|agu)/i;

export interface PricedDecision {
  /** a stable key that names neither the run nor the agent: sha256 of the run label and the turn's sequence number */
  key: string;
  run: string;
  seq: number;
  agent: string;
  /** "quote", "accept", "offer" (PROVIDER's mint decision), "buy ahead", "request" or "counter" */
  kind: string;
  reasoning: string;
}

const KIND: Record<string, string> = {
  post_quote: "quote",
  accept_quote: "accept",
  post_offer: "offer",
  buy_offer: "buy ahead",
  order_front_claim: "buy ahead",
  request_claims: "request",
};

export const decisionKey = (run: string, seq: number): string =>
  createHash("sha256").update(`v3a-decision:${run}:${seq}`).digest("hex").slice(0, 16);

/** every priced decision in one run's log, each with the reasoning the agent wrote for that turn */
export function extractPricedDecisions(run: string, log: readonly LogEntry[]): PricedDecision[] {
  const out: PricedDecision[] = [];
  // the runner writes an agent's reasoning, then its action's own entries (a message, for a message), then its turn
  const reasoning = new Map<string, string>();
  const message = new Map<string, string>();
  for (const e of log) {
    if (e.kind === "reasoning" && typeof e.text === "string") {
      reasoning.set(e.actor, e.text);
      message.delete(e.actor);
      continue;
    }
    if (e.kind === "message" && typeof e.text === "string") {
      message.set(e.actor, e.text);
      continue;
    }
    if (e.kind !== "turn" || e.parsed !== true || e.mirror === true) continue;
    const tool = String(e.tool);
    const kind = PRICED_TOOLS.has(tool)
      ? KIND[tool]
      : tool === "message" && AMOUNT_IN_TEXT.test(message.get(e.actor) ?? "")
        ? "counter"
        : undefined;
    if (kind !== undefined)
      out.push({ key: decisionKey(run, e.seq), run, seq: e.seq, agent: e.actor, kind, reasoning: reasoning.get(e.actor) ?? "" });
    reasoning.delete(e.actor);
    message.delete(e.actor);
  }
  return out;
}

/** agent ids masked, so a coder never sees who decided (nor, through the id, which role or arm) */
const AGENT_ID = /\b(?:PROVIDER|HEDGER|RESEARCH-\d+|DEMAND-\d+)\b/g;
export interface BlindItem {
  key: string;
  kind: string;
  text: string;
}
export const blindItems = (decisions: readonly PricedDecision[]): BlindItem[] =>
  decisions.map((d) => ({ key: d.key, kind: d.kind, text: d.reasoning.replace(AGENT_ID, "[agent]") }));

export type Coder = (item: BlindItem) => Promise<UnitLabel>;

export const CODING_INSTRUCTIONS = [
  "You code one decision by an agent in a small market. Read the agent's own reasoning and say which unit it reasons about prices and value in:",
  '- "SIU": it states or compares amounts in SIU or mSIU (units of work), not in dollars.',
  '- "dollars": it states or compares amounts in dollars, USD, USDC or µ$, not in SIU.',
  '- "both": it states or compares amounts in both.',
  '- "none": it states no amount in either.',
  "A currency's name alone (paying in AGU-lab or USDC) is not a unit of account; code the unit the amounts are reasoned in. Answer with the tool, nothing else.",
].join("\n");

const CODE_TOOL: McpToolDef = {
  name: "code_unit",
  description: "the unit this reasoning states and compares amounts in",
  inputSchema: { type: "object", properties: { unit: { type: "string", enum: [...UNIT_LABELS] } }, required: ["unit"] },
};

/** a coder from any tool chat: one forced tool call per item, its label read from the call */
export function modelCoder(chat: ToolChat, maxTokens = 2_000): Coder {
  return async (item) => {
    const prompt = `${CODING_INSTRUCTIONS}\n\nThe decision (${item.kind}):\n"""\n${item.text}\n"""`;
    const turn = await chat.send(chat.init(prompt), chat.toolSpecs([CODE_TOOL]), maxTokens, { forceTool: true });
    const unit = turn.reply?.toolUses[0]?.args.unit;
    if (turn.status !== 200 || !UNIT_LABELS.includes(unit as UnitLabel))
      throw new Error(`coder call failed for ${item.key} (status ${turn.status}, unit ${String(unit)})`);
    return unit as UnitLabel;
  };
}

export async function codeAll(items: readonly BlindItem[], coder: Coder): Promise<Map<string, UnitLabel>> {
  const out = new Map<string, UnitLabel>();
  for (const it of items) out.set(it.key, await coder(it));
  return out;
}

/** a seeded random `HAND_SHARE_BPS` share of the items (at least one when there are any), for Petr to code by hand without seeing any coder's label */
export function handSample(items: readonly BlindItem[], seed: string, shareBps = HAND_SHARE_BPS): BlindItem[] {
  const want = Math.max(items.length === 0 ? 0 : 1, Math.round((items.length * shareBps) / 10_000));
  const pool = [...items];
  const s = new SeedStream(seed, "v3a-hand-sample");
  for (let i = pool.length - 1; i > 0; i--) {
    const j = s.next(i + 1);
    [pool[i], pool[j]] = [pool[j] as BlindItem, pool[i] as BlindItem];
  }
  return pool.slice(0, want).sort((a, b) => a.key.localeCompare(b.key));
}

/** Cohen's kappa between two codings over the keys both coded; null with no common key, or when chance agreement is total (both used one same label throughout) */
export function kappa(a: ReadonlyMap<string, UnitLabel>, b: ReadonlyMap<string, UnitLabel>): { kappa: number | null; n: number; agreed: number } {
  const keys = [...a.keys()].filter((k) => b.has(k));
  const n = keys.length;
  if (n === 0) return { kappa: null, n, agreed: 0 };
  let agreed = 0;
  const ca = new Map<UnitLabel, number>();
  const cb = new Map<UnitLabel, number>();
  for (const k of keys) {
    const x = a.get(k) as UnitLabel;
    const y = b.get(k) as UnitLabel;
    if (x === y) agreed++;
    ca.set(x, (ca.get(x) ?? 0) + 1);
    cb.set(y, (cb.get(y) ?? 0) + 1);
  }
  const po = agreed / n;
  const pe = UNIT_LABELS.reduce((s, l) => s + ((ca.get(l) ?? 0) / n) * ((cb.get(l) ?? 0) / n), 0);
  return { kappa: pe === 1 ? null : (po - pe) / (1 - pe), n, agreed };
}
