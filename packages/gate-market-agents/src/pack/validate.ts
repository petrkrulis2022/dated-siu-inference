import type { AgentContext } from "../context/assemble.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";

export type ValidationFailureKind =
  "doc-leak" | "asset-preference" | "asset-description-drift" | "api-key-pattern";

/**
 * Thrown, never a logged warning — WP-6's own instruction: "treat a failure as a halt, not a
 * warning." `kind` and `matched` make a real trigger debuggable rather than just "something
 * failed."
 */
export class ContextValidationError extends Error {
  constructor(
    public readonly kind: ValidationFailureKind,
    public readonly matched: string,
  ) {
    super(
      `Context validation failed (${kind}): matched "${matched}". Halting — this validator ` +
        "protects the only behavioural finding in the experiment (spec §10's WP-6 prompt), a " +
        "failure here is never a warning.",
    );
    this.name = "ContextValidationError";
  }
}

/** Each document's own exact title — confirmed by reading docs/gate-market-spec.md and
 * docs/monetary-design.md's first lines directly, not guessed. Distinctive enough that
 * accidental appearance elsewhere is implausible. */
const DOC_TITLE_BLOCKLIST = [
  "The Gate Market — fSIU testbed build spec",
  "The Unit, the Claim and the Curve",
];

/** Spec §10's own framing: "the important one." A documented, reviewable phrase list, not a
 * vague heuristic — extend it here, in one place, if a real run finds a phrasing this misses. */
const ASSET_PREFERENCE_BLOCKLIST = [
  "pay in fsiu",
  "pay in usdc",
  "prefer usdc",
  "prefer fsiu",
  "fsiu is better",
  "usdc is better",
  "you should use usdc",
  "you should use fsiu",
  "recommend usdc",
  "recommend fsiu",
  "usdc is preferred",
  "fsiu is preferred",
];

/** Scoped to the providers `packages/harness/src/adapters/index.ts`'s real `ApiKeys` integrates
 * (anthropic, openai, google, openrouter, groq, xai) — a real, current list, not a claim of
 * universal coverage. `sk-or-`/`sk-ant-`/`sk-proj-` are checked ahead of the generic OpenAI
 * pattern since their own hyphenated infix means the generic pattern (no hyphens allowed) can't
 * catch them itself. */
const API_KEY_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-or-[A-Za-z0-9_-]{20,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /gsk_[A-Za-z0-9]{20,}/,
  /xai-[A-Za-z0-9]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
];

/**
 * Deliberately not `serializeContext` (`context/assemble.ts`): `JSON.stringify`-ing the whole
 * `AgentContext` escapes newlines inside `skillPackText` (`\n` becomes the two characters
 * `\`+`n`), so a raw multi-line constant like `CANONICAL_ASSET_DESCRIPTION` could never match
 * against it byte-for-byte even when it's genuinely present verbatim — found live, this
 * package's own first version of the "positive case" test failed on a real, clean pack for
 * exactly this reason. `skillPackText` (plain prose, human-authored) is kept raw; each tool
 * call record (structured data, arbitrary shape) is still JSON-stringified individually, since
 * that's the only general way to search nested objects for a leaked pattern.
 */
function searchableText(context: AgentContext): string {
  const toolCallsText = context.toolCalls.map((record) => JSON.stringify(record)).join("\n");
  return `${context.skillPackText}\n${toolCallsText}`;
}

/**
 * Runs before every agent turn (spec §10's WP-6 prompt) — no turn loop exists yet (that's WP-7),
 * so this is exposed as a plain function for whichever loop calls it first, and exercised
 * directly by `validate.test.ts` here.
 */
export function validateAgentContext(context: AgentContext): void {
  const serialized = searchableText(context);
  const lower = serialized.toLowerCase();

  for (const title of DOC_TITLE_BLOCKLIST) {
    if (serialized.includes(title)) {
      throw new ContextValidationError("doc-leak", title);
    }
  }

  for (const phrase of ASSET_PREFERENCE_BLOCKLIST) {
    if (lower.includes(phrase)) {
      throw new ContextValidationError("asset-preference", phrase);
    }
  }

  if (!serialized.includes(CANONICAL_ASSET_DESCRIPTION)) {
    throw new ContextValidationError(
      "asset-description-drift",
      "(canonical asset description not found verbatim)",
    );
  }

  for (const pattern of API_KEY_PATTERNS) {
    const match = serialized.match(pattern);
    if (match) {
      throw new ContextValidationError("api-key-pattern", match[0]);
    }
  }
}
