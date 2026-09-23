import { clientsFor, type ChainClients } from "@touchstone/agents";
import { BudgetCeiling, CeilingExceededError } from "./budget/ceiling.js";
import { DualRenderer } from "./context/dual-render.js";
import type { ToolCallRecord } from "./context/assemble.js";
import { TOOLS, type ToolDefinition, type ToolName } from "./tools/index.js";
import type { RunnerDeps, ToolContext } from "./deps.js";
import type { AgentId } from "./identity/resolve.js";

export interface RunnerOptions {
  agentId: AgentId;
  windowId: string;
  privateKeyHex: string;
  rpcUrl: string;
  deps: RunnerDeps;
  ceiling: BudgetCeiling;
  /** The calling agent's loaded skill's `tools.yaml` list (`skills/registry.ts`'s `loadSkill`).
   * Optional and unrestricted when omitted — WP-5's dry-loop scenarios and this package's own
   * scripted tests drive tools directly, with no skill in the loop, and must keep working
   * unchanged. A real run (WP-7) should always pass this. */
  allowedTools?: readonly ToolName[];
}

/** Spec §12.3: "the runtime denies any call outside that list and records the denial." Thrown
 * by `Runner.callTool` when `allowedTools` is set and `toolName` isn't in it. */
export class ToolNotAllowedError extends Error {
  constructor(
    public readonly agentId: AgentId,
    public readonly toolName: ToolName,
  ) {
    super(`${agentId} is not permitted to call "${toolName}" — not declared in its skill's tools.yaml.`);
    this.name = "ToolNotAllowedError";
  }
}

/** "Records the denial" — a call blocked by `allowedTools`, kept queryable the same way a real
 * `ToolCallRecord` is, rather than only ever surfacing as a thrown-and-discarded error. */
export interface DeniedToolCall {
  turn: number;
  jobId: string;
  toolName: ToolName;
}

/**
 * The key-isolation boundary WP-4's own prompt requires: "the model requests signatures through
 * a tool. It never sees key material and never receives a provider API key." `#privateKeyHex`
 * and `#clients` are private fields — never returned by any public method, never placed in a
 * `ToolCallRecord`. The only public surface is `callTool`, which returns a plain, loggable
 * `{turn, jobId, toolName, args, result}` record — exactly the shape `context/assemble.ts`'s
 * `AgentContext` (what WP-7 will eventually hand a model) is built from, and nothing else.
 * `runner.test.ts` is the regression test WP-4 asks for: it serializes a real `AgentContext`
 * built from a representative call sequence and asserts no key-shaped pattern appears in it.
 */
export class Runner {
  readonly agentId: AgentId;
  readonly windowId: string;
  readonly address: string;

  #privateKeyHex: string;
  #clients: ChainClients;
  #deps: RunnerDeps;
  #ceiling: BudgetCeiling;
  #allowedTools?: readonly ToolName[];
  #dualRenderer = new DualRenderer();
  #records: ToolCallRecord[] = [];
  #deniedCalls: DeniedToolCall[] = [];
  #countedTurns = new Set<number>();

  constructor(options: RunnerOptions) {
    this.agentId = options.agentId;
    this.windowId = options.windowId;
    this.#privateKeyHex = options.privateKeyHex;
    this.#clients = clientsFor(options.privateKeyHex, options.rpcUrl);
    this.address = this.#clients.account.address;
    this.#deps = options.deps;
    this.#ceiling = options.ceiling;
    this.#allowedTools = options.allowedTools;
  }

  /**
   * The only way any signing or chain-write happens. `meta.turn` is caller-supplied (from
   * whatever loop eventually drives this, in WP-7) rather than incremented internally, since one
   * model turn may call several tools — the budget ceiling counts a turn only once per distinct
   * `meta.turn` value, not once per `callTool` invocation.
   */
  async callTool(
    toolName: ToolName,
    args: unknown,
    meta: {
      turn: number;
      jobId: string;
      /** The worst-case dollar cost of the model turn this tool call is part of — real token
       * counts × the agent's real `reasoning_model` registry price
       * (`budget/inference-cost.ts`'s `projectedTurnCostUsd`). Optional: no live model loop
       * calls this package yet (that's WP-7), so nothing to project until one does — the
       * mechanism is real and tested now, wired end-to-end once a real turn loop can compute it. */
      projectedInferenceUsd?: string;
    },
  ): Promise<ToolCallRecord> {
    if (this.#ceiling.isHalted(this.agentId, this.windowId)) {
      throw new CeilingExceededError(this.agentId, this.windowId, "turns");
    }
    if (!this.#countedTurns.has(meta.turn)) {
      this.#ceiling.recordTurn(this.agentId, this.windowId);
      this.#countedTurns.add(meta.turn);
    }
    if (meta.projectedInferenceUsd) {
      this.#ceiling.recordInferenceSpend(this.agentId, this.windowId, meta.projectedInferenceUsd);
    }

    if (this.#allowedTools && !this.#allowedTools.includes(toolName)) {
      this.#deniedCalls.push({ turn: meta.turn, jobId: meta.jobId, toolName });
      throw new ToolNotAllowedError(this.agentId, toolName);
    }

    // See tools/index.ts's own doc comment on why TOOLS carries no shared supertype annotation —
    // this single cast, not a widened registry type, is where that tradeoff is paid.
    const tool = TOOLS[toolName] as ToolDefinition<unknown, unknown>;
    const parsedArgs = tool.argsSchema.parse(args);

    const spendUsd = tool.spendUsd?.(parsedArgs);
    if (spendUsd) {
      this.#ceiling.recordSpend(this.agentId, this.windowId, spendUsd);
    }

    const ctx: ToolContext = {
      deps: this.#deps,
      clients: this.#clients,
      dualRenderer: this.#dualRenderer,
    };
    const result = await tool.handler(ctx, parsedArgs, this.#privateKeyHex);

    const record: ToolCallRecord = {
      turn: meta.turn,
      jobId: meta.jobId,
      toolName,
      args: parsedArgs,
      result,
    };
    this.#records.push(record);
    return record;
  }

  /** Every record so far — the only data `context/assemble.ts`'s `assembleContext` may read. */
  toolCallRecords(): readonly ToolCallRecord[] {
    return this.#records;
  }

  /** Every call `allowedTools` blocked so far — spec §12.3's "records the denial." */
  deniedToolCalls(): readonly DeniedToolCall[] {
    return this.#deniedCalls;
  }
}
