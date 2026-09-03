const UUID_V4_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The widget generates session ids with crypto.randomUUID() — validated on the way in so a
 * malformed or hostile sessionId can never become a D1/KV key built from arbitrary input. */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_LIKE.test(value);
}
