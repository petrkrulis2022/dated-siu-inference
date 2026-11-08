/**
 * Every economy tool as a native tool call (D136/D137): the provider is given each role's tools as real JSON Schema, forced to call exactly one with `tool_choice: {type:
 * "any"}` (`mcp/anthropic-loop.ts`), so a free-text reply is no longer a possible shape at all -- there is nothing left for a model to write prose before. `reasoning` is a
 * required string, listed first in every tool's schema, so it stays the first property a model fills in practice (verified empirically, the same standard as D136's own
 * finding, not assumed from the schema alone). `parseToolCall` validates the call the provider actually returned exactly as the old free-text parser validated the object it
 * read, reusing the same per-tool argument rules unchanged: a scripted agent's own structured reply goes through it too, so the parser and every rule are still exercised
 * exactly as a model's turn exercises them.
 *
 * The scale-slip check (D82) runs on every amount an agent states: an amount a thousand times above or below what it plainly refers to (the agent's own balance for a sale or a
 * redemption, the participant's ask for a purchase) is flagged. A flagged decision still executes and stays in every count; the report lists it for examination.
 */
import type { McpToolDef } from "../mcp/types.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import type { Board } from "./board.js";
import { parseUnits, type AguUnits } from "./units.js";
import type { Action, PayUnit, Role } from "./world.js";

const pay = (args: Obj): PayUnit | undefined => {
  if (args.pay === undefined) return undefined;
  if (args.pay !== "usdc" && args.pay !== "agu") throw new Error('args.pay must be "usdc" or "agu"');
  return args.pay;
};

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
  pass: "do nothing this round",
  message: "send a message to one agent, or to every agent",
  buy_agu: "buy AGU-lab from the participant at its ask -- name exactly one of agu or usdc",
  sell_agu: "sell AGU-lab back to the participant at its bid (an exit to USDC)",
  redeem_agu: "redeem AGU-lab in kind: you receive your share of the reserve's work claims",
  present_claim: "present a work claim in its window: the issuer does one task of its type for you",
  order_front_claim:
    "order work claims for the next window at the roll's discount to the print, in USDC or AGU-lab, your choice (default usdc)",
  post_quote:
    "offer a brief to the demand agent with that need, priced in whole mSIU (a thousandth of a SIU, never a decimal) OR in USDC -- name exactly one of price_msiu or price_usdc, whichever you name is what binds at acceptance",
  accept_quote:
    "accept a quote: its price goes into escrow in whichever unit the quote named (AGU-lab or USDC), released only if the brief passes",
  buy_data:
    "buy today's data for a task type, in USDC or its AGU-lab equivalent at the live rate (default usdc); a research agent's first task on a dataset each day also buys that data",
  commission_task:
    "pay an issuer (escrowed, paid per task only on a pass) to do these tasks now, in AGU-lab or USDC, your choice (default agu)",
  deliver_brief:
    "deliver a brief from your passing outputs of today; you are paid only if every component passed",
  buy_claims:
    "buy work claims for a future window at the plain print, in USDC or AGU-lab, your choice (default usdc)",
  deliver_forward: "deliver one of the briefs you sold forward, from two passing outputs of today",
};

const PAY_ENUM = {
  type: "string",
  enum: ["usdc", "agu"],
  description: "default usdc unless this tool's own description says otherwise",
};
const TASK_ENUM = { type: "string", enum: [...TASKS] };
const REASONING = { type: "string", description: "why, in a few sentences" } as const;

/** every tool's own argument schema; `reasoning` is prepended first by `toolDefsForRole`, never listed here. */
const ARG_SCHEMAS: Readonly<
  Record<string, { properties: Record<string, unknown>; required: string[] }>
> = {
  pass: { properties: {}, required: [] },
  message: {
    properties: {
      to: { type: "string", description: 'an agent id, or "all"' },
      text: { type: "string" },
    },
    required: ["to", "text"],
  },
  buy_agu: {
    properties: {
      agu: { type: "string", description: "AGU-lab to buy, a decimal string" },
      usdc: { type: "string", description: "USDC to spend, a decimal string" },
    },
    required: [],
  },
  sell_agu: { properties: { agu: { type: "string" } }, required: ["agu"] },
  redeem_agu: { properties: { agu: { type: "string" } }, required: ["agu"] },
  present_claim: { properties: { claim: { type: "string" } }, required: ["claim"] },
  order_front_claim: {
    properties: { task: TASK_ENUM, siu: { type: "string" }, pay: PAY_ENUM },
    required: ["task", "siu"],
  },
  post_quote: {
    properties: {
      need: { type: "string" },
      tasks: { type: "array", items: TASK_ENUM, minItems: 1 },
      price_msiu: { type: "string", description: "whole mSIU, e.g. 250" },
      price_usdc: { type: "string", description: "decimal USDC, e.g. 0.015" },
    },
    required: ["need", "tasks"],
  },
  accept_quote: { properties: { quote: { type: "string" } }, required: ["quote"] },
  buy_data: {
    properties: {
      dataset: { type: "string", enum: ["perp", "lending", "tokens", "stablecoins"] },
      pay: PAY_ENUM,
    },
    required: ["dataset"],
  },
  commission_task: {
    properties: {
      tasks: { type: "array", items: TASK_ENUM, minItems: 1 },
      issuer: { type: "string" },
      pay: PAY_ENUM,
    },
    required: ["tasks", "issuer"],
  },
  deliver_brief: { properties: { quote: { type: "string" } }, required: ["quote"] },
  buy_claims: {
    properties: {
      task: TASK_ENUM,
      siu: { type: "string" },
      windows_ahead: { type: "integer", minimum: 1 },
      pay: PAY_ENUM,
    },
    required: ["task", "siu", "windows_ahead"],
  },
  deliver_forward: { properties: {}, required: [] },
};

/** the tool defs a role's model is given, native Anthropic/OpenAI tool-call shape: reasoning first, then that tool's own args. */
export function toolDefsForRole(role: Role): McpToolDef[] {
  return TOOLS_BY_ROLE[role].map((name) => {
    const s = ARG_SCHEMAS[name];
    if (s === undefined) throw new Error(`no argument schema for tool ${name}`);
    return {
      name,
      description: TOOL_HELP[name] ?? name,
      inputSchema: {
        type: "object",
        properties: { reasoning: REASONING, ...s.properties },
        required: ["reasoning", ...s.required],
      },
    };
  });
}

export type Parsed =
  | { ok: true; reasoning: string; action: Action; flags: string[] }
  | { ok: false; error: string; reasoning?: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** a single native tool call, as the provider actually returned it: `args` is the tool's input, `reasoning` included alongside its own fields. */
export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export function parseToolCall(call: ToolCall | undefined, role: Role, board?: Board): Parsed {
  if (call === undefined) return { ok: false, error: "no tool call in the reply" };
  const { tool, args } = call;
  if (!isObj(args)) return { ok: false, error: "the tool call's arguments are not an object" };
  if (!TOOLS_BY_ROLE[role].includes(tool))
    return { ok: false, error: `tool ${tool} is not available to a ${role} agent` };
  const reasoning = args.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim() === "")
    return { ok: false, error: "reasoning must be a non-empty string" };
  try {
    const action = toAction(tool, args);
    return {
      ok: true,
      reasoning,
      action,
      flags: board === undefined ? [] : scaleFlags(action, board),
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
      return { tool: "order_front_claim", task: task(args), milli: amount(args, "siu", 3), pay: pay(args) };
    case "post_quote": {
      const tasks = args.tasks;
      if (!Array.isArray(tasks) || !tasks.every((t) => TASKS.includes(t as TaskId)))
        throw new Error("args.tasks must be a list of task types");
      // v2 item 2: a quote binds in exactly one unit -- whole mSIU (never a decimal SIU amount, the owner, 2026-11-07) or whole-cent-precision USDC
      if ((args.price_msiu === undefined) === (args.price_usdc === undefined))
        throw new Error('args must name exactly one of "price_msiu" or "price_usdc"');
      return args.price_usdc !== undefined
        ? {
            tool: "post_quote",
            need: str(args, "need"),
            tasks: tasks as TaskId[],
            priceUsdcMicro: amount(args, "price_usdc"),
          }
        : {
            tool: "post_quote",
            need: str(args, "need"),
            tasks: tasks as TaskId[],
            priceMicroSiu: amount(args, "price_msiu", 0) * 1_000n,
          };
    }
    case "accept_quote":
      return { tool: "accept_quote", quote: str(args, "quote") };
    case "buy_data":
      return { tool: "buy_data", dataset: str(args, "dataset"), pay: pay(args) };
    case "commission_task": {
      const tasks = args.tasks;
      if (
        !Array.isArray(tasks) ||
        tasks.length === 0 ||
        !tasks.every((t) => TASKS.includes(t as TaskId))
      )
        throw new Error("args.tasks must be a non-empty list of task types");
      return {
        tool: "commission_task",
        tasks: tasks as TaskId[],
        issuer: str(args, "issuer"),
        pay: pay(args),
      };
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
        pay: pay(args),
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
    // v2 item 2: a usdc-priced quote is checked against the same reference, converted at the board's own live rate -- still a soft heuristic, never a financial calculation
    if (a.priceUsdcMicro !== undefined) {
      const usdcPerSiu = parseUnits(b.printUsdPerSiu, 6);
      check("price_usdc vs the quoted tasks' cheapest issuer prices", a.priceUsdcMicro, (ref * usdcPerSiu) / 1_000_000n);
    } else check("price_siu vs the quoted tasks' cheapest issuer prices", a.priceMicroSiu as bigint, ref);
  }
  return flags;
}
