import type { AgentContext } from "../context/assemble.js";
import { TOOL_DESCRIPTIONS } from "../pack/tool-descriptions.js";
import type { ToolName } from "../tools/index.js";

const RESPONSE_FORMAT_INSTRUCTIONS = `Respond with exactly one JSON object and nothing else.

To call a tool: {"tool": "<tool_name>", "args": {...}}
To leave this window for good: {"done": true, "summary": "<what happened>"}

YOU DO NOT NEED TO DO ANYTHING IN ORDER TO WAIT.
  You are given a turn only when something has genuinely arrived for you to act on. Between
  those you are not asked at all — no turn is spent, nothing is lost, and you stay in the
  window. "Waiting for a delivery" therefore needs no response from you; it is the default.

  So {"done": true} is not how you wait. It is how you leave: you will not be given another
  turn in this window whatever arrives, and will never learn what happened in it. Use it only
  when you would not want to be shown a delivery, a payment or an offer even if one came.

Optionally, add a "friction" field to that SAME object — never a second, separate JSON object —
reporting anything real about *this* turn's decision, appended to your friction log every turn
regardless (spec §8.6). For example, on a tool call:
{"tool": "<tool_name>", "args": {...}, "friction": {
  "could_not_express": "<something you wanted to do but had no tool for, or null>",
  "forced_conversion": <true only if you had to convert between assets/units you would not have
    chosen to, false otherwise>,
  "conversion_reason": "<why, if forced_conversion is true, or null>",
  "missing_information": "<something you needed but weren't given, or null>",
  "decision_confidence": "low" | "medium" | "high"
}}
Omit "friction" entirely if none of this applies this turn — do not invent friction that did not happen.`;

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
  /** `loop/quote-board.ts`'s own rendered text for this agent, this turn — structured quote-
   * request/response data other agents have produced, never free text one agent wrote for
   * another to read (spec §13.3's "no agent messages" stays true; this only completes a
   * mechanism `request_quote`/`issue_quote` already needs to function at all). Omitted from the
   * prompt entirely when empty, so a turn with no open market activity isn't padded with a
   * hollow section header. */
  marketBoardText = "",
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
    ...(marketBoardText ? ["", marketBoardText] : []),
    "",
    RESPONSE_FORMAT_INSTRUCTIONS,
  ].join("\n");
}
