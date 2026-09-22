import { z } from "zod";
import type { Print } from "@touchstone/sdk";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({ printId: z.string() });
type Args = z.infer<typeof argsSchema>;

export interface GetPrintResult {
  print: Print;
  /** Derived exactly as `packages/console/server/routes/prints.ts` does it — `print.status`
   * itself is never trusted directly (`docs/methodology.md` §7: it stays "provisional" on every
   * print's signed body forever; "final" is a fact about reconciliation, not something the print
   * body can say about itself in advance). */
  final: boolean;
}

/** Wraps `@touchstone/print`'s `loadPrint` + the established final-vs-provisional derivation —
 * both injected via `deps` so this tool is testable with no real filesystem. */
export const getPrintTool: ToolDefinition<Args, GetPrintResult> = {
  name: "get_print",
  argsSchema,
  async handler(ctx, args) {
    const print = await ctx.deps.loadPrint(args.printId);
    const final = await ctx.deps.isReconciled(args.printId);
    return { print, final };
  },
};
