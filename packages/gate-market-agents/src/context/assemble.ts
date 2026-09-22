import type { AgentId } from "../identity/resolve.js";

/**
 * Exactly what `Runner.callTool` returns — see `runner.ts`. This is the only shape
 * `assembleContext` is allowed to read from; it must never import or reference `Runner` itself,
 * which is what makes the key-leakage regression test in `runner.test.ts` meaningful (there is
 * no path from key material into this type, by construction, not by discipline alone).
 */
export interface ToolCallRecord {
  turn: number;
  jobId: string;
  toolName: string;
  args: unknown;
  result: unknown;
}

/**
 * What WP-7 will eventually serialize and hand to a model. Built now, with no model wired up
 * yet, because WP-4's own prompt requires a test that greps "the assembled model context" for
 * key patterns — that requires this to already be a real, testable artifact, not a placeholder.
 */
export interface AgentContext {
  agentId: AgentId;
  skillPackText: string;
  toolCalls: readonly ToolCallRecord[];
}

export function assembleContext(
  agentId: AgentId,
  skillPackText: string,
  toolCalls: readonly ToolCallRecord[],
): AgentContext {
  return { agentId, skillPackText, toolCalls };
}

export function serializeContext(context: AgentContext): string {
  return JSON.stringify(context);
}
