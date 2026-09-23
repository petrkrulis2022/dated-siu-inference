import type { GateSpec, HeldOutInstance, ReferenceTaskInstance, Submission } from "../types.js";

/**
 * The `extract` reference task (gate-market-spec.md §2.5): structured extraction to a pinned
 * schema. Deliberately no external schema-validation library (ajv or similar): every seeded gate
 * here is small, self-contained JS embedded directly in the gate source, so there is nothing to
 * bind into the sandbox beyond the node runtime itself (see run-sandboxed.ts's existing binds) —
 * widening the sandbox's importable surface to expose the pnpm store was the alternative, and a
 * self-contained validator whose full behaviour is this file's own git history is the simpler,
 * more directly pinned choice for what WP-1 actually needs (see PATHOLOGICAL GUARDS below for
 * the part that would matter most if that changes later).
 *
 * String comparison policy, stated explicitly per review: exact match, always. No whitespace
 * trimming, no case-insensitivity, no numeric-string coercion beyond what JSON.parse itself does.
 * Any tolerance here is exactly the gap an adversary aims at — see NULL_SEMANTICS_ADVERSARIAL and
 * PLAUSIBLE_FABRICATION below, which both fail specifically because the hardened gate does not
 * forgive a close-but-not-exact value.
 */
export const COMMERCIAL_INTENT =
  "A buyer paying for this wants the actual invoice number, vendor, amount, currency and due " +
  "date extracted from the source document, exactly — not a schema-shaped placeholder, not a " +
  "plausible-looking guess, and not whichever of several conflicting values happens to look " +
  "right on casual inspection of the raw submission text.";

export const SOURCE_DOCUMENT = `INVOICE
Invoice number: INV-4471
Vendor: Acme Bolts Ltd
Total amount: 128.50
Currency: USD
Due date: 2026-10-01
`;

const EXPECTED = {
  invoice_number: "INV-4471",
  vendor: "Acme Bolts Ltd",
  total_amount: 128.5,
  currency: "USD",
  due_date: "2026-10-01",
} as const;

const REQUIRED_KEYS = Object.keys(EXPECTED);

export const EXTRACT_REFERENCE: ReferenceTaskInstance = {
  taskClass: "extract",
  files: {
    "source-document.txt": SOURCE_DOCUMENT,
    "commercial-intent.txt": COMMERCIAL_INTENT,
  },
};

export const EXTRACT_KNOWN_GOOD: Submission = {
  files: { "answer.json": JSON.stringify(EXPECTED) },
};

/**
 * PATHOLOGICAL GUARDS, run before any real check, inside the sandbox (same wall-clock kill and
 * memory cap as the code executor — this is the boundary decision review asked to be resolved
 * deliberately: JSON validation is agent-authored-input handling, not "pure and safe," and gets
 * no in-process shortcut).
 *
 * A single global node-visit counter, checked first on every call, is the real defence — not per-
 * level width/depth caps alone. A balanced tree within generous per-level limits can still visit
 * an astronomical number of nodes (the actual "billion laughs" amplification); the global counter
 * bounds total work regardless of shape. MAX_DEPTH is also explicit and small (never inferred
 * from V8's own call-stack limit, which varies by Node version/flags/environment — depending on
 * it would make the same pathological input pass in one environment and fail in another, breaking
 * G5 determinism across time rather than just across three runs).
 */
const PATHOLOGICAL_GUARDS_SOURCE = `
const MAX_RAW_LENGTH = 20000;
const MAX_TOTAL_NODES = 5000;
const MAX_DEPTH = 20;
const MAX_STRING_LENGTH = 10000;

/** Checked before any JSON.parse at all — the cheapest possible rejection for a submission whose
 * raw text alone is already unreasonable for this domain (every real fixture here is well under
 * 1KB), so a large-but-parseable file never even reaches the parser. */
function checkRawLength(raw) {
  if (raw.length > MAX_RAW_LENGTH) return "submission file exceeds the raw size limit (" + MAX_RAW_LENGTH + " bytes)";
  return null;
}

/** Runs on the already-parsed value. A single global node-visit counter, checked first on every
 * call, is the real defence against amplification (the actual "billion laughs" shape) — per-level
 * width/depth caps alone don't bound total work for a balanced tree; MAX_DEPTH is explicit and
 * small rather than inferred from V8's own call-stack limit, which varies by environment and
 * would otherwise make the same input pass here and fail elsewhere. */
function checkPathological(value, depth, counter) {
  counter.n++;
  if (counter.n > MAX_TOTAL_NODES) return "submission exceeds the node-count limit (" + MAX_TOTAL_NODES + ")";
  if (depth > MAX_DEPTH) return "submission exceeds the nesting-depth limit (" + MAX_DEPTH + ")";
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return "a string value exceeds the length limit (" + MAX_STRING_LENGTH + ")";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = checkPathological(item, depth + 1, counter);
      if (err) return err;
    }
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const err = checkPathological(value[k], depth + 1, counter);
      if (err) return err;
    }
  }
  return null;
}

function parseGuarded(raw) {
  const lengthErr = checkRawLength(raw);
  if (lengthErr) return { error: lengthErr };
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { error: "invalid JSON: " + String(e) }; }
  const structErr = checkPathological(obj, 0, { n: 0 });
  if (structErr) return { error: structErr };
  return { value: obj };
}
`;

/** Gate 1 — trivial: every required key merely present, any value, any type. */
export const EXTRACT_GATE_1_TRIVIAL: GateSpec = {
  taskClass: "extract",
  source: `${PATHOLOGICAL_GUARDS_SOURCE}
import { readFileSync } from "node:fs";
const REQUIRED_KEYS = ${JSON.stringify(REQUIRED_KEYS)};

export async function gate({ submissionDir }) {
  const raw = readFileSync(submissionDir + "/answer.json", "utf-8");
  const parsed = parseGuarded(raw);
  if (parsed.error) return { accept: false, reason: parsed.error };
  const obj = parsed.value;
  const missing = REQUIRED_KEYS.filter((k) => !(k in obj));
  return {
    accept: missing.length === 0,
    reason: missing.length === 0 ? "all required keys present" : "missing keys: " + missing.join(", "),
  };
}
`,
};

/**
 * Gate 2 — naive text-scan: instead of checking the *parsed, resolved* value, it regex-scans the
 * raw submission text for the expected value appearing somewhere. This is the field-order-gaming
 * hole (spec §2.5): JSON permits duplicate keys, and JSON.parse resolves them last-key-wins — a
 * submission can put a correct-looking value first (satisfying a naive text scan) and a different
 * value last (what actually reaches a real downstream consumer that parses properly). Also
 * demonstrates why "right type, non-empty" alone (checked here too) still isn't enough: plausible
 * fabrication and null-semantics placeholders both satisfy it.
 */
export const EXTRACT_GATE_2_TEXT_SCAN: GateSpec = {
  taskClass: "extract",
  source: `${PATHOLOGICAL_GUARDS_SOURCE}
import { readFileSync } from "node:fs";
const EXPECTED = ${JSON.stringify(EXPECTED)};
const REQUIRED_KEYS = ${JSON.stringify(REQUIRED_KEYS)};

export async function gate({ submissionDir }) {
  const raw = readFileSync(submissionDir + "/answer.json", "utf-8");
  const parsed = parseGuarded(raw);
  if (parsed.error) return { accept: false, reason: parsed.error };
  const obj = parsed.value;

  for (const k of REQUIRED_KEYS) {
    const v = obj[k];
    if (typeof v === "string" ? v.trim().length === 0 : v === null || v === undefined) {
      return { accept: false, reason: k + " is empty or missing" };
    }
    if (typeof EXPECTED[k] === "number" && typeof v !== "number") {
      return { accept: false, reason: k + " has the wrong type" };
    }
  }

  // The vulnerability: checks whether the *raw text* contains the right value anywhere, not
  // whether the parsed object's *resolved* value (obj[k], already read above but unused here on
  // purpose) equals it.
  for (const k of REQUIRED_KEYS) {
    const needle = JSON.stringify(EXPECTED[k]);
    if (!raw.includes(needle)) {
      return { accept: false, reason: k + "'s expected value does not appear in the submission text" };
    }
  }
  return { accept: true, reason: "all required values found in the submission text" };
}
`,
};

/**
 * Gate 3 — hardened: proper JSON.parse (last-key-wins, closing the duplicate-key hole
 * structurally rather than by scanning text), key-based access only (never string/positional
 * comparison — closes field-order gaming a second, independent way), and exact-match comparison
 * against expected values derived from the reference document *at gate-runtime*.
 *
 * Rewritten 2026-09-23, G6 (types.ts's `HeldOutInstance` doc comment): the original version of
 * this gate baked `EXPECTED` in as a literal computed at fixture-authoring time — a real,
 * structural answer-key, not a verifier, exactly the same shape a real single-agent run
 * independently produced (see `EXTRACT_ANSWER_KEY_REGRESSION` below). It happened to pass G1-G5
 * because those checks never vary the reference document. This version reads
 * `referenceDir/source-document.txt` at runtime and derives its own expectations from that text
 * — it would produce the right answer for a different invoice it has never seen, which is the
 * property G6 actually tests.
 */
export const EXTRACT_GATE_3_HARDENED: GateSpec = {
  taskClass: "extract",
  source: `${PATHOLOGICAL_GUARDS_SOURCE}
import { readFileSync } from "node:fs";
const REQUIRED_KEYS = ${JSON.stringify(REQUIRED_KEYS)};

// Plain string search rather than a regex — the label text itself never contains regex
// metacharacters, and this avoids any risk of a mismatched escape between this generator and the
// generated source (found worth avoiding, not merely convenient, while writing this).
function extractField(text, label) {
  const marker = label + ":";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  const rest = text.slice(idx + marker.length);
  const newlineIdx = rest.indexOf("\\n");
  return (newlineIdx === -1 ? rest : rest.slice(0, newlineIdx)).trim();
}

export async function gate({ referenceDir, submissionDir }) {
  const docRaw = readFileSync(referenceDir + "/source-document.txt", "utf-8");
  const expected = {
    invoice_number: extractField(docRaw, "Invoice number"),
    vendor: extractField(docRaw, "Vendor"),
    total_amount: Number(extractField(docRaw, "Total amount")),
    currency: extractField(docRaw, "Currency"),
    due_date: extractField(docRaw, "Due date"),
  };

  const raw = readFileSync(submissionDir + "/answer.json", "utf-8");
  const parsed = parseGuarded(raw);
  if (parsed.error) return { accept: false, reason: parsed.error };
  const obj = parsed.value;

  // Key-based access on the already-resolved (last-key-wins) parsed object — never re-reads the
  // raw submission text, so a duplicate-key trick can't present a different value than the one
  // checked here.
  const wrong = REQUIRED_KEYS.filter((k) => obj[k] !== expected[k]); // exact match, stated policy
  return {
    accept: wrong.length === 0,
    reason: wrong.length === 0 ? "every field matches exactly" : "incorrect field(s): " + wrong.join(", "),
  };
}
`,
};

/**
 * G6: does the hardened gate above actually generalize to invoices it never saw, or does it
 * (like the original version of this same fixture) only recognize the one document it was
 * authored against? Four held-out invoices, each with real, distinct values and its own matching
 * known-good/adversarial pair — never shown to a gate author, only used to grade.
 */
interface HeldOutInvoice {
  invoiceNumber: string;
  vendor: string;
  totalAmount: number;
  currency: string;
  dueDate: string;
}

function buildHeldOutInvoice(invoice: HeldOutInvoice): HeldOutInstance {
  const document = `INVOICE
Invoice number: ${invoice.invoiceNumber}
Vendor: ${invoice.vendor}
Total amount: ${invoice.totalAmount.toFixed(2)}
Currency: ${invoice.currency}
Due date: ${invoice.dueDate}
`;
  const expected = {
    invoice_number: invoice.invoiceNumber,
    vendor: invoice.vendor,
    total_amount: invoice.totalAmount,
    currency: invoice.currency,
    due_date: invoice.dueDate,
  };
  const referenceInstance: ReferenceTaskInstance = {
    taskClass: "extract",
    files: {
      "source-document.txt": document,
      "commercial-intent.txt": COMMERCIAL_INTENT,
    },
  };
  const knownGoodSubmission: Submission = { files: { "answer.json": JSON.stringify(expected) } };
  const adversarialSubmission: Submission = {
    files: {
      "answer.json": JSON.stringify({
        invoice_number: "WRONG-0000",
        vendor: "Wrong Vendor Inc",
        total_amount: 0,
        currency: "XXX",
        due_date: "1970-01-01",
      }),
    },
  };
  return { referenceInstance, knownGoodSubmission, adversarialSubmissions: [adversarialSubmission] };
}

export const EXTRACT_HELD_OUT_INSTANCES: readonly [HeldOutInstance, ...HeldOutInstance[]] = [
  buildHeldOutInvoice({
    invoiceNumber: "INV-7812",
    vendor: "Blue River Textiles",
    totalAmount: 452.0,
    currency: "EUR",
    dueDate: "2026-11-15",
  }),
  buildHeldOutInvoice({
    invoiceNumber: "INV-2290",
    vendor: "Nordwind Logistics GmbH",
    totalAmount: 89.99,
    currency: "USD",
    dueDate: "2026-09-30",
  }),
  buildHeldOutInvoice({
    invoiceNumber: "INV-5567",
    vendor: "Cedar & Finch Supply Co",
    totalAmount: 1204.75,
    currency: "GBP",
    dueDate: "2026-12-01",
  }),
  buildHeldOutInvoice({
    invoiceNumber: "INV-0043",
    vendor: "Meridian Office Solutions",
    totalAmount: 15.0,
    currency: "USD",
    dueDate: "2026-10-20",
  }),
];

/**
 * Real, not hypothetical: the exact gate a single-agent measurement pass produced live,
 * 2026-09-23 (`data/gate-market/runs/extract-gate-authoring-2026-09-23T12-49-02-789Z/
 * metrics.json`) — gemini-3.1-pro-preview, given the source document and asked to author a
 * hardened extract gate from scratch. It passed G1-G5 in one turn, $0.005912, on the strength of
 * exactly the same answer-key structure `EXTRACT_GATE_3_HARDENED` itself had before this rewrite.
 * A permanent regression fixture: G6 must reject this, proving it catches the exact degenerate
 * strategy actually observed, not a hypothetical one — see extract.test.ts.
 */
export const EXTRACT_ANSWER_KEY_REGRESSION: GateSpec = {
  taskClass: "extract",
  source: `import fs from 'node:fs';
import path from 'node:path';

export async function gate({ submissionDir }) {
  try {
    const answerPath = path.join(submissionDir, 'answer.json');
    const content = fs.readFileSync(answerPath, 'utf8');
    const data = JSON.parse(content);

    if (data.invoice_number !== 'INV-4471') return { accept: false, reason: 'bad invoice_number' };
    if (data.vendor !== 'Acme Bolts Ltd') return { accept: false, reason: 'bad vendor' };
    if (String(data.total_amount) !== '128.50' && String(data.total_amount) !== '128.5') return { accept: false, reason: 'bad total_amount' };
    if (data.currency !== 'USD') return { accept: false, reason: 'bad currency' };
    if (data.due_date !== '2026-10-01') return { accept: false, reason: 'bad due_date' };

    return { accept: true, reason: 'pass' };
  } catch (e) {
    return { accept: false, reason: e.message };
  }
}
`,
};

/** Defeats Gate 1 (spec §2.5's "schema-valid but empty"): every key present, every value empty. */
export const SCHEMA_VALID_EMPTY: Submission = {
  files: {
    "answer.json": JSON.stringify({
      invoice_number: "",
      vendor: "",
      total_amount: 0,
      currency: "",
      due_date: "",
    }),
  },
};

/** Defeats Gate 1's keys-only check but not Gate 3 ("plausible fabrication"): right shape, right
 * types, entirely made up. Also correctly rejected by Gate 2 — found live, 2026-09-22: an earlier
 * version of this comment claimed it defeated Gate 2 too, which was wrong. Gate 2's text-scan
 * actually requires the *real* value to appear literally in the submission, so pure fabrication
 * (which never contains the real values at all) fails it — an incidental strength of that gate,
 * not a hole. */
export const PLAUSIBLE_FABRICATION: Submission = {
  files: {
    "answer.json": JSON.stringify({
      invoice_number: "INV-0001",
      vendor: "Some Other Company",
      total_amount: 99.99,
      currency: "EUR",
      due_date: "2099-01-01",
    }),
  },
};

/** Defeats Gate 1's keys-only check but not Gate 3 ("correct types with null semantics"):
 * technically non-empty, correctly typed, but sentinel/placeholder values carrying no real
 * extracted information. Also correctly rejected by Gate 2, same reason as
 * PLAUSIBLE_FABRICATION above — its text-scan requires the real value verbatim. */
export const NULL_SEMANTICS_ADVERSARIAL: Submission = {
  files: {
    "answer.json": JSON.stringify({
      invoice_number: "N/A",
      vendor: "N/A",
      total_amount: -1,
      currency: "N/A",
      due_date: "0000-00-00",
    }),
  },
};

/** Defeats Gate 2 specifically ("field-order gaming"): a duplicate `total_amount` key. The first
 * occurrence is the correct value (what a naive text scan finds); JSON.parse resolves the *last*
 * occurrence, which is wrong — exactly the parser-differential gap Gate 2 has and Gate 3 doesn't,
 * because Gate 3 only ever reads the resolved object, never the raw text. Written as a raw string
 * (not JSON.stringify, which can't produce duplicate keys) since this is the point of the fixture.
 */
export const FIELD_ORDER_GAMING: Submission = {
  files: {
    "answer.json":
      '{"invoice_number":"INV-4471","vendor":"Acme Bolts Ltd","total_amount":128.5,' +
      '"total_amount":9999,"currency":"USD","due_date":"2026-10-01"}',
  },
};

/** Permanent pathological fixtures (review, 2026-09-22): the extract class's execution boundary
 * is the same sandbox as code's, so these prove the *validator's own* guards, not just the
 * sandbox's OS-level caps (already proven generically in sandbox/hostile-fixture.test.ts).
 * Sized to clearly exceed the guards above (not literal multi-GB — see this constant's own
 * reasoning in extract.test.ts) while staying fast and cheap to stage in a test. */
export const PATHOLOGICAL_DEEP_NESTING: Submission = {
  files: {
    "answer.json": (() => {
      let value = "0";
      for (let i = 0; i < 100; i++) value = `[${value}]`;
      return value;
    })(),
  },
};

export const PATHOLOGICAL_WIDE_EXPANSION: Submission = {
  files: {
    // A flat array of single-digit numbers, deliberately low bytes-per-node: this isolates the
    // node-count guard from the raw-length guard (checked first, since it's cheaper) — a nested,
    // multi-key-object version of "wide" was tried and found live to trip the raw-length guard
    // instead, at 32KB for only 1,000 leaf nodes, which would have demonstrated the wrong guard.
    "answer.json": JSON.stringify({
      invoice_number: Array.from({ length: 5500 }, (_, i) => i % 10),
      vendor: "x",
      total_amount: 1,
      currency: "USD",
      due_date: "2026-10-01",
    }),
  },
};

export const PATHOLOGICAL_HUGE_STRING: Submission = {
  files: {
    "answer.json": JSON.stringify({
      invoice_number: "x".repeat(50_000),
      vendor: "Acme Bolts Ltd",
      total_amount: 128.5,
      currency: "USD",
      due_date: "2026-10-01",
    }),
  },
};
