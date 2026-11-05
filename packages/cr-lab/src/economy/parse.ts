/**
 * The strict parser for an agent's reply (`docs/part5-build-plan.md` §3.3): exactly one JSON object, reasoning first, `{"reasoning": "...", "action": {"tool": "...", "args": {...}}}`.
 * A reply that is not that object is a failed turn: logged, counted, never repaired. Amounts are plain decimal strings, read exactly into base units.
 *
 * The scale-slip check (D82) runs on every amount an agent states: an amount a thousand times above or below what it plainly refers to (the agent's own balance for a sale or a
 * redemption, the participant's ask for a purchase) is flagged. A flagged decision still executes and stays in every count; the report lists it for examination.
 */
import { TASKS, type TaskId } from "../tasks/instances.js";
import type { Board } from "./board.js";
import { parseUnits, type AguUnits } from "./units.js";
import type { Action, Role } from "./world.js";

export const TOOLS_BY_ROLE: Readonly<Record<Role, readonly string[]>> = {
  research: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "post_quote",
    "buy_data",
    "commission_task",
    "deliver_brief",
  ],
  demand: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "accept_quote",
  ],
  hedger: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "commission_task",
    "buy_claims",
    "deliver_forward",
  ],
};

export const TOOL_HELP: Readonly<Record<string, string>> = {
  pass: "{} — do nothing this round",
  message:
    '{"to": "<agent id or all>", "text": "..."} — send a message to one agent, or to every agent',
  buy_agu:
    '{"agu": "<AGU-lab to buy>"} (or {"usdc": "<USDC to spend>"}) — buy AGU-lab from the participant at its ask',
  sell_agu:
    '{"agu": "<AGU-lab to sell>"} — sell AGU-lab back to the participant at its bid (an exit to USDC)',
  redeem_agu:
    '{"agu": "<AGU-lab>"} — redeem AGU-lab in kind: you receive your share of the reserve\'s work claims',
  present_claim:
    '{"claim": "<claim id>"} — present a work claim in its window: the issuer does one task of its type for you',
  order_front_claim:
    '{"task": "CR-PL", "siu": "0.25"} — order work claims for the next window, paid in USDC at the roll at a discount to the print',
  post_quote:
    '{"need": "<need id>", "tasks": ["CR-PL", "CR-UO"], "price_siu": "<SIU>"} — offer a brief to the demand agent with that need',
  accept_quote:
    '{"quote": "<quote id>"} — accept a quote: its price goes into escrow in AGU-lab, released only if the brief passes',
  buy_data:
    '{"dataset": "perp|lending|tokens|stablecoins"} — buy today\'s data for a task type (USDC)',
  commission_task:
    '{"tasks": ["CR-PL", "CR-UO"], "issuer": "<issuer id>"} — pay an issuer in AGU-lab (escrowed, paid per task only on a pass) to do these tasks now; a research agent\'s first task on a dataset each day also buys that data (USDC)',
  deliver_brief:
    '{"quote": "<quote id>"} — deliver a brief from your passing outputs of today; you are paid only if every component passed',
  buy_claims:
    '{"task": "CR-PL", "siu": "0.25", "windows_ahead": 1} — buy work claims for a future window, in USDC at the print',
  deliver_forward:
    "{} — deliver one of the briefs you sold forward, from two passing outputs of today",
};

export type Parsed =
  | { ok: true; reasoning: string; action: Action; flags: string[]; fenced: boolean }
  | { ok: false; error: string; reasoning?: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The same fence rule as the snapshot-mode gate (`tasks/gates.ts`, `parseAnswer`): a reply that is EXACTLY one fenced block (```json ... ```) is read from inside the fence and
 * marked `fenced`, noted and never counted as a failure; anything else around or after the object is still a failed turn, never repaired (found in DW2, 2026-11-05: claude-haiku-4-5
 * fenced all 18 of its replies, each a valid object inside).
 */
const FENCE = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/;

export function parseReply(text: string, role: Role, board?: Board): Parsed {
  let v: unknown;
  let body = text.trim();
  const fence = FENCE.exec(body);
  const fenced = fence !== null;
  if (fence !== null) body = (fence[1] as string).trim();
  try {
    v = JSON.parse(body);
  } catch {
    return { ok: false, error: "the reply is not one JSON object" };
  }
  if (!isObj(v)) return { ok: false, error: "the reply is not one JSON object" };
  const keys = Object.keys(v);
  if (keys.length !== 2 || keys[0] !== "reasoning" || keys[1] !== "action")
    return { ok: false, error: 'the object must have exactly "reasoning" then "action"' };
  const reasoning = v.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "")
    return { ok: false, error: "reasoning must be a non-empty string" };
  const a = v.action;
  if (!isObj(a) || typeof a.tool !== "string" || !isObj(a.args ?? {}))
    return { ok: false, error: 'action must be {"tool": "...", "args": {...}}', reasoning };
  const tool = a.tool;
  if (!TOOLS_BY_ROLE[role].includes(tool))
    return { ok: false, error: `tool ${tool} is not available to a ${role} agent`, reasoning };
  const args = (a.args ?? {}) as Obj;
  try {
    const action = toAction(tool, args);
    return {
      ok: true,
      reasoning,
      action,
      flags: board === undefined ? [] : scaleFlags(action, board),
      fenced,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, reasoning };
  }
}

const str = (args: Obj, k: string): string => {
  const v = args[k];
  if (typeof v !== "string" || v.trim() === "")
    throw new Error(`args.${k} must be a non-empty string`);
  return v;
};
const task = (args: Obj): TaskId => {
  const t = str(args, "task");
  if (!TASKS.includes(t as TaskId)) throw new Error(`args.task must be one of ${TASKS.join(", ")}`);
  return t as TaskId;
};
const amount = (args: Obj, k: string, decimals = 6): bigint => {
  const v = args[k];
  if (typeof v !== "string") throw new Error(`args.${k} must be a decimal string`);
  const n = parseUnits(v, decimals);
  if (n <= 0n) throw new Error(`args.${k} must be above zero`);
  return n;
};

function toAction(tool: string, args: Obj): Action {
  switch (tool) {
    case "pass":
      return { tool: "pass" };
    case "deliver_forward":
      return { tool: "deliver_forward" };
    case "message":
      return { tool: "message", to: str(args, "to"), text: str(args, "text").slice(0, 600) };
    case "buy_agu":
      if ((args.agu === undefined) === (args.usdc === undefined))
        throw new Error('args must name exactly one of "agu" or "usdc"');
      return args.agu !== undefined
        ? { tool: "buy_agu", agu: amount(args, "agu") }
        : { tool: "buy_agu", usdc: amount(args, "usdc") };
    case "sell_agu":
      return { tool: "sell_agu", agu: amount(args, "agu") };
    case "redeem_agu":
      return { tool: "redeem_agu", agu: amount(args, "agu") };
    case "present_claim":
      return { tool: "present_claim", claim: str(args, "claim") };
    case "order_front_claim":
      return { tool: "order_front_claim", task: task(args), milli: amount(args, "siu", 3) };
    case "post_quote": {
      const tasks = args.tasks;
      if (!Array.isArray(tasks) || !tasks.every((t) => TASKS.includes(t as TaskId)))
        throw new Error("args.tasks must be a list of task types");
      return {
        tool: "post_quote",
        need: str(args, "need"),
        tasks: tasks as TaskId[],
        priceMicroSiu: amount(args, "price_siu"),
      };
    }
    case "accept_quote":
      return { tool: "accept_quote", quote: str(args, "quote") };
    case "buy_data":
      return { tool: "buy_data", dataset: str(args, "dataset") };
    case "commission_task": {
      const tasks = args.tasks;
      if (
        !Array.isArray(tasks) ||
        tasks.length === 0 ||
        !tasks.every((t) => TASKS.includes(t as TaskId))
      )
        throw new Error("args.tasks must be a non-empty list of task types");
      return { tool: "commission_task", tasks: tasks as TaskId[], issuer: str(args, "issuer") };
    }
    case "deliver_brief":
      return { tool: "deliver_brief", quote: str(args, "quote") };
    case "buy_claims": {
      const ahead = args.windows_ahead;
      if (typeof ahead !== "number" || !Number.isInteger(ahead))
        throw new Error("args.windows_ahead must be a whole number");
      return {
        tool: "buy_claims",
        task: task(args),
        milli: amount(args, "siu", 3),
        windowsAhead: ahead,
      };
    }
    default:
      throw new Error(`unknown tool ${tool}`);
  }
}

/** an amount at least a thousand times above, or at most a thousandth of, what it refers to */
export function scaleFlags(a: Action, b: Board): string[] {
  const off = (x: bigint, ref: bigint): boolean =>
    ref > 0n && (x >= ref * 1_000n || x * 1_000n <= ref);
  const flags: string[] = [];
  const check = (what: string, x: AguUnits, ref: bigint): void => {
    if (off(x, ref)) flags.push(`${what}: ${x} base units against ${ref}`);
  };
  if (a.tool === "sell_agu" || a.tool === "redeem_agu")
    check(`${a.tool} vs your AGU-lab balance`, a.agu, b.agu);
  if (a.tool === "buy_agu" && a.usdc !== undefined)
    check("buy_agu vs the ask for one AGU-lab", a.usdc, b.askUsdcPerAgu);
  if (a.tool === "buy_agu" && a.agu !== undefined && b.agu > 0n)
    check("buy_agu vs your AGU-lab balance", a.agu, b.agu);
  if (a.tool === "post_quote") {
    // what the quoted brief plainly refers to: its own tasks at their cheapest issuer price (found in DW3: against the dearest task in the market, a CR-VS the brief did not
    // include, every ordinary quote looked a thousandfold too small)
    const ref = a.tasks.reduce((sum, t) => {
      const prices = b.issuerPrices.filter((p) => p.task === t).map((p) => p.priceMicroSiu);
      return sum + (prices.length === 0 ? 0n : prices.reduce((x, y) => (y < x ? y : x)));
    }, 0n);
    check("price_siu vs the quoted tasks' cheapest issuer prices", a.priceMicroSiu, ref);
  }
  return flags;
}
