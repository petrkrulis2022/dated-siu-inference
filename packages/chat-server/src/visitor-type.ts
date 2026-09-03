/**
 * A heuristic guess at whether a chat visitor is a human or an agent — never treated as a strong
 * signal anywhere it's read (the D1 schema's own column comment says so, and every surface that
 * displays it should too). Two real, per-request signals — nothing that would need cross-service
 * state this Worker doesn't have (an earlier draft assumed knowledge of whether the visitor's IP
 * had recently fetched /mcp.json, which is served as a static file by a different Cloudflare
 * Pages project entirely and logs nothing this Worker could read; dropped rather than shipped as
 * a signal that silently never fires):
 *
 * 1. User-agent shape — a real browser UA is a long, specific string naming an engine and OS; a
 *    generic HTTP client (node, curl, undici, python-httpx, Go-http-client, or empty) is not.
 *    Confirmed live this session (real Cloudflare traffic analysis against mcp.touchstoneassay.com)
 *    that this exact set of generic-client strings is what automated MCP-ecosystem traffic
 *    actually presents as.
 * 2. Whether the request carries an Origin/Referer matching the site the widget is embedded on —
 *    the browser-injected widget script always sends one (it's a same-context fetch from a page
 *    the visitor navigated to); a direct API-style call to /chat, bypassing the widget entirely,
 *    has no reason to.
 */

export type VisitorType = "human" | "agent" | "unknown";

const GENERIC_CLIENT_UA = /^(node|curl|undici|python-(httpx|requests)|go-http-client)/i;
const BROWSER_UA = /Mozilla\/5\.0.*(AppleWebKit|Gecko)/i;

export function classifyVisitor(input: {
  userAgent: string | null;
  originOrReferer: string | null;
  expectedOrigin: string;
}): VisitorType {
  const ua = input.userAgent ?? "";
  if (!ua || GENERIC_CLIENT_UA.test(ua)) return "agent";

  const fromExpectedOrigin = input.originOrReferer?.startsWith(input.expectedOrigin) ?? false;
  if (BROWSER_UA.test(ua)) {
    return fromExpectedOrigin ? "human" : "unknown";
  }
  return "unknown";
}
