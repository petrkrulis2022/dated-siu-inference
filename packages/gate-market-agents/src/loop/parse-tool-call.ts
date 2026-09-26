import type { ToolName } from "../tools/index.js";

/**
 * Spec §8.6's friction log is meant as "evidence from an agent that transacted, not opinion from
 * one that read a spec" — the qualitative fields (`could_not_express`, `forced_conversion`,
 * `missing_information`) genuinely require the agent's own real-time self-report, not something
 * a loop can synthesize after the fact. Optional on every response: a model that omits it still
 * gets a real (if minimal) friction-log entry — the loop supplies conservative defaults — rather
 * than the whole turn failing to parse over a field most models won't reliably remember to fill
 * in from a first prompt revision.
 */
export interface FrictionReport {
  could_not_express?: string | null;
  forced_conversion?: boolean;
  conversion_reason?: string | null;
  missing_information?: string | null;
  decision_confidence?: "low" | "medium" | "high";
}

export interface ToolCallIntent {
  tool: ToolName;
  args: unknown;
  friction?: FrictionReport;
}

export interface DoneIntent {
  done: true;
  summary: string;
  friction?: FrictionReport;
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
 * The exact span of the first `{...}` object starting at `openIndex`, respecting JSON string
 * content (so a brace character inside a quoted string — e.g. a `submit_job` call's own `source`
 * field, real JS code full of `{`/`}` — is never mistaken for real object structure). Returns the
 * index of that object's own matching close brace, or null if it never closes.
 */
function matchingBraceIndex(text: string, openIndex: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
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
    // Found live (WORKER-CODE/claude-sonnet-5, P5 window 1, 2026-09-26): a real, recurring
    // misreading of this file's own "friction" instructions — the model closed its real tool-
    // call object cleanly, then appended a stray `, "friction": {...}` *outside* it instead of
    // merging "friction" in as a sibling key. The naive first-brace/last-brace span then spans
    // both fragments, which is never valid JSON. Falls back to the exact matching span for the
    // first opening brace alone — the model's real, complete, intended object — before giving up.
    const matchEnd = matchingBraceIndex(text, start);
    if (matchEnd !== null) {
      try {
        parsed = JSON.parse(text.slice(start, matchEnd + 1));
      } catch {
        throw new ModelResponseParseError(text);
      }
    } else {
      throw new ModelResponseParseError(text);
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ModelResponseParseError(text);
  }
  const obj = parsed as Record<string, unknown>;

  // Conditionally spread rather than always setting `friction: undefined` — "omitted entirely
  // when absent" is the real, tested property (parse-tool-call.test.ts), matching this prompt's
  // own "do not invent friction that did not happen" instruction to the model.
  const frictionField =
    typeof obj.friction === "object" && obj.friction !== null
      ? { friction: obj.friction as FrictionReport }
      : {};

  if (obj.done === true) {
    if (typeof obj.summary !== "string") {
      throw new ModelResponseParseError(text);
    }
    return { done: true, summary: obj.summary, ...frictionField };
  }

  if (typeof obj.tool !== "string") {
    throw new ModelResponseParseError(text);
  }
  return { tool: obj.tool as ToolName, args: obj.args, ...frictionField };
}
