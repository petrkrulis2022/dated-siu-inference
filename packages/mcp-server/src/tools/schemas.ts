import { z } from "zod";
import { validateTouchstoneQuote } from "@touchstone/sdk";
import { TASK_CLASSES } from "./get-quote.js";
import { SUPPORTED_VERIFY_RECEIPT_CHAINS } from "./verify-receipt.js";

/**
 * Each tool's input schema — the single copy both the MCP registration (../server.ts) and the
 * paywall's pre-check (../paywall.ts) read. The paywall charges only for a call the tool will
 * actually accept: one that fails these checks is passed through unpaid, and the MCP layer (or the
 * tool's own first check) returns its error for free. Found live 2026-10-24 on Arc Testnet: a
 * verify_receipt call missing `quote` was charged $0.01 and then rejected — the paywall ran before
 * validation. Sharing one schema object means "would this call pass validation" can never drift
 * from what the MCP layer actually validates.
 */
export const TOOL_INPUT_SHAPES = {
  get_index: { version: z.string().optional(), date: z.string().optional() },
  get_quote: { task_class: z.string(), model: z.string() },
  convert: {
    model: z.string(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  },
  verify_receipt: {
    chain: z.string(),
    tx_hash: z.string(),
    quote: z.record(z.string(), z.unknown()),
  },
} as const;

/**
 * The deterministic input checks each tool's handler makes before doing any work, run again here
 * so the paywall never charges for a call the handler would refuse on its input alone. Found live
 * the same day: verify_receipt with `quote: {}` passed the schema above (any object), was charged,
 * then failed the published touchstone-quote schema inside the handler. Data-dependent failures —
 * an unknown model, a settlement that isn't on chain — can't be judged without I/O and are not
 * covered here (the Worker pre-checks get_quote and convert against the print; see
 * ../workers/index.ts).
 */
const TOOL_INPUT_CHECKS: Record<string, (args: Record<string, unknown>) => boolean> = {
  get_quote: (a) => TASK_CLASSES.has(a.task_class as string),
  verify_receipt: (a) =>
    (SUPPORTED_VERIFY_RECEIPT_CHAINS as readonly string[]).includes(a.chain as string) &&
    validateTouchstoneQuote(a.quote).valid,
};

/**
 * True when the tool would accept `args`: they pass the MCP layer's own validation (parsed exactly
 * as the SDK does — `request.params.arguments` as received, so a missing object fails any tool with
 * a required field) AND the tool's own deterministic input checks. An unknown tool is not this
 * function's to judge, so it returns true.
 */
export function toolArgumentsAreValid(tool: string, args: unknown): boolean {
  const shape = (TOOL_INPUT_SHAPES as Record<string, z.ZodRawShape>)[tool];
  if (!shape) return true;
  if (!z.object(shape).safeParse(args).success) return false;
  const check = TOOL_INPUT_CHECKS[tool];
  return check ? check(args as Record<string, unknown>) : true;
}
