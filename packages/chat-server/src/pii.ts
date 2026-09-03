/**
 * Strips anything that looks like a secret or personal data from chat content before it's ever
 * written to D1 — never stored even transiently, per the widget spec's own guardrail. Deliberately
 * simple pattern matching, not a full PII-detection model: the goal is to catch the two concrete
 * things a visitor might paste into a chat box (an API key, an email address), not to build a
 * general-purpose redaction service.
 */

// API-key-shaped strings: long runs of base64url/hex-ish characters, the shape every major
// provider's key format shares (sk-..., 0x..., a bare 32+ char token). Matches liberally on
// purpose — a false positive here costs nothing (a redacted non-key), a false negative costs a
// real leaked credential sitting in the database.
const KEY_LIKE = /\b(?:[A-Za-z0-9_-]{20,}|0x[0-9a-fA-F]{16,})\b/g;
const EMAIL_LIKE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function stripSensitive(content: string): string {
  return content.replace(EMAIL_LIKE, "[redacted-email]").replace(KEY_LIKE, "[redacted-key]");
}
