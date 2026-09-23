import type { ToolName } from "../tools/index.js";

export interface ToolCallIntent {
  tool: ToolName;
  args: unknown;
}

export interface DoneIntent {
  done: true;
  summary: string;
}

export class ModelResponseParseError extends Error {
  constructor(public readonly rawText: string) {
    super(
      `Could not find a valid tool-call JSON object in the model's response. Halting rather ` +
        `than retrying or guessing — a smoke pass that silently papers over an unparseable ` +
        `response would misreport real turns-to-completion. Raw response: ${JSON.stringify(rawText)}`,
    );
    this.name = "ModelResponseParseError";
  }
}

/**
 * `packages/harness`'s `Adapter` is plain text in, plain text out — no native tool-calling
 * exists anywhere in this repo (confirmed by reading `adapters/types.ts` and every real adapter
 * before this smoke pass's own plan was written). This parses the small JSON tool-call protocol
 * `loop/prompt.ts` asks the model to use, out of the model's raw text response. Real models
 * don't always return *only* JSON despite being asked to — this scans for the first `{...}`
 * span and attempts to parse it, rather than requiring the entire response to be valid JSON.
 */
export function parseModelResponse(text: string): ToolCallIntent | DoneIntent {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new ModelResponseParseError(text);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelResponseParseError(text);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelResponseParseError(text);
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.done === true) {
    if (typeof obj.summary !== "string") {
      throw new ModelResponseParseError(text);
    }
    return { done: true, summary: obj.summary };
  }

  if (typeof obj.tool !== "string") {
    throw new ModelResponseParseError(text);
  }
  return { tool: obj.tool as ToolName, args: obj.args };
}
