import type { z } from "zod";
import type { ToolContext } from "../deps.js";

/**
 * One entry per tool in spec §10's WP-4 list: request_quote, issue_quote, pay, redeem_claim,
 * mint_claim, serve_redemption, submit_job, get_balances, get_print, check_headroom.
 *
 * `handler` receives `privateKeyHex` directly from `Runner` — the only place any tool ever sees
 * key material — and must never place it in the value it returns. `TResult` is exactly what ends
 * up in a `ToolCallRecord.result` (see `context/assemble.ts`), which is exactly what an
 * `AgentContext` is built from — so a handler that returned the key would leak it straight into
 * what WP-7 hands a model. `runner.test.ts`'s regression test is the backstop, not the only
 * safeguard.
 */
export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  /** `z.ZodType<TArgs, z.ZodTypeDef, unknown>`, not the usual `z.ZodType<TArgs>` (which defaults
   * its Input parameter to TArgs too): a schema with `.default(...)` has an Input type that
   * includes `undefined` for that field while its Output (TArgs) does not, so the default
   * Input=Output form rejects exactly the schemas this substrate needs (see `get-balances.ts`'s
   * `tokenIds` field). Input is `unknown` because every tool's raw args arrive as untrusted data
   * (a model's tool call, in WP-7) — the schema's job is validating that boundary, not agreeing
   * with a pre-existing type. */
  argsSchema: z.ZodType<TArgs, z.ZodTypeDef, unknown>;
  handler: (ctx: ToolContext, args: TArgs, privateKeyHex: string) => Promise<TResult>;
  /** Decimal-USD amount this call spends, if any — checked against the budget ceiling
   * (`budget/ceiling.ts`) before `handler` runs. */
  spendUsd?: (args: TArgs) => string | null;
}
