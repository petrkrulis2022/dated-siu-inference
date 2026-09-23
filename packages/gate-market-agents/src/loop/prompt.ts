import type { AgentContext } from "../context/assemble.js";
import { TOOL_DESCRIPTIONS } from "../pack/tool-descriptions.js";
import type { ToolName } from "../tools/index.js";

const RESPONSE_FORMAT_INSTRUCTIONS = `Respond with exactly one JSON object and nothing else.

To call a tool: {"tool": "<tool_name>", "args": {...}}
To end your turn, once the job is delivered (or you have no further useful action): {"done": true, "summary": "<what happened>"}`;

/**
 * `packages/harness`'s `Adapter` is plain text in, plain text out — this builds the full prompt
 * for one turn: the assembled skill+pack text, the real tool descriptions (a subset, per
 * `availableTools` — an agent only ever sees the tools its own skill file grants it), the real
 * prior-turn history (so the model can see what it already tried and what came back), and the
 * small JSON response-format instructions `parse-tool-call.ts` expects.
 */
export function buildTurnPrompt(
  context: AgentContext,
  availableTools: readonly ToolName[],
): string {
  const toolList = availableTools.map((name) => TOOL_DESCRIPTIONS[name]).join("\n");

  const history =
    context.toolCalls.length === 0
      ? "(no turns yet — this is your first turn)"
      : context.toolCalls
          .map(
            (record) =>
              `Turn ${record.turn} — called ${record.toolName}(${JSON.stringify(record.args)}) -> ${JSON.stringify(record.result)}`,
          )
          .join("\n");

  return [
    context.skillPackText,
    "",
    "YOUR AVAILABLE TOOLS THIS TURN:",
    toolList,
    "",
    "WHAT HAS HAPPENED SO FAR:",
    history,
    "",
    RESPONSE_FORMAT_INSTRUCTIONS,
  ].join("\n");
}
