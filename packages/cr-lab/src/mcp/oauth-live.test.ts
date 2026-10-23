import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateGovernor, RateLimited } from "../data-desk/governor.js";
import { LiveMcp, MCP_GOVERNOR_GROUP, McpTransportFailure } from "./live-mcp.js";
import { LoginFailed, runLogin } from "./oauth-login.js";
import { TrialOAuthProvider } from "./oauth-store.js";
import { MCP_DATA_TOOLS } from "./types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-oauth-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("the OAuth store", () => {
  const make = () =>
    new TrialOAuthProvider({ redirectUrl: "http://127.0.0.1:8976/callback", dir: join(tmp, "o") });

  it("keeps the client, tokens and verifier as private files (0600, directory 0700) and returns them as saved", () => {
    const p = make();
    p.saveClientInformation({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:8976/callback"],
    } as never);
    p.saveTokens({ access_token: "AT-secret", token_type: "Bearer", refresh_token: "RT-secret" });
    p.saveCodeVerifier("verifier-secret");
    expect(p.tokens()?.access_token).toBe("AT-secret");
    expect(p.codeVerifier()).toBe("verifier-secret");
    for (const f of ["client.json", "tokens.json", "verifier.json"])
      expect(statSync(join(tmp, "o", f)).mode & 0o777).toBe(0o600);
    expect(statSync(join(tmp, "o")).mode & 0o777).toBe(0o700);
  });

  it("never shows a token when printed, serialised or described", () => {
    const p = make();
    p.saveTokens({ access_token: "AT-secret", token_type: "Bearer", refresh_token: "RT-secret" });
    for (const text of [String(p), JSON.stringify(p), JSON.stringify(p.describe()), `${p}`])
      expect(text).not.toMatch(/secret/);
    expect(p.describe()).toEqual({ registered: false, signedIn: true, hasRefreshToken: true });
  });

  it("does not reuse a registration made for a different redirect URL, and clears tokens on sign-out", () => {
    const a = make();
    a.saveClientInformation({
      client_id: "cid",
      redirect_uris: ["http://127.0.0.1:8976/callback"],
    } as never);
    expect(a.clientInformation()?.client_id).toBe("cid");
    const b = new TrialOAuthProvider({
      redirectUrl: "http://127.0.0.1:9999/callback",
      dir: join(tmp, "o"),
    });
    expect(b.clientInformation()).toBeUndefined();
    a.saveTokens({ access_token: "x", token_type: "Bearer" });
    a.clearTokens();
    expect(a.tokens()).toBeUndefined();
  });

  it("asks for no secret: a public client that uses PKCE, refresh tokens and our own redirect URL", () => {
    expect(make().clientMetadata).toMatchObject({
      redirect_uris: ["http://127.0.0.1:8976/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });
});

/** A small OAuth authorization server shaped like the live one (discovery, dynamic registration, authorization code with PKCE, tokens). */
function oauthServer() {
  const seen = { register: [] as Record<string, unknown>[], token: [] as URLSearchParams[] };
  let base = "";
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const server: HttpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base || "http://127.0.0.1");
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(200, {
        resource: base,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      const b = JSON.parse(await body(req)) as Record<string, unknown>;
      seen.register.push(b);
      return json(201, { ...b, client_id: "client-xyz" });
    }
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      seen.token.push(new URLSearchParams(await body(req)));
      return json(200, {
        access_token: "access-123",
        token_type: "Bearer",
        refresh_token: "refresh-123",
        expires_in: 3600,
      });
    }
    res.writeHead(404).end();
  });
  return {
    seen,
    async start(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
      return base;
    },
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("the one-time browser sign-in", () => {
  /** What the owner's browser does after signing in: follow the redirect back with a code and the state it was given. */
  const browser =
    (code: string, mutate: (state: string) => string = (s) => s) =>
    async (url: URL) => {
      const redirect = url.searchParams.get("redirect_uri") as string;
      const state = mutate(url.searchParams.get("state") as string);
      await fetch(`${redirect}?code=${code}&state=${state}`);
    };

  it("registers, sends the owner to sign in with PKCE, checks the state, exchanges the code, and stores tokens privately", async () => {
    const o = oauthServer();
    const base = await o.start();
    try {
      const opened: URL[] = [];
      const provider = await runLogin({
        serverUrl: `${base}/mcp`,
        port: 0,
        dir: join(tmp, "o"),
        open: async (u) => {
          opened.push(u);
          await browser("code-1")(u);
        },
      });
      expect(provider.describe()).toEqual({
        registered: true,
        signedIn: true,
        hasRefreshToken: true,
      });
      expect(provider.tokens()?.access_token).toBe("access-123");
      // registered as a public client for our own redirect URL
      expect(o.seen.register[0]).toMatchObject({ token_endpoint_auth_method: "none" });
      expect((o.seen.register[0]?.redirect_uris as string[])[0]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
      );
      // the sign-in URL: authorization code with PKCE (S256), our client and redirect
      const u = opened[0] as URL;
      expect(u.origin + u.pathname).toBe(`${base}/oauth/authorize`);
      expect(u.searchParams.get("response_type")).toBe("code");
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("client_id")).toBe("client-xyz");
      // the code exchange carries the code and the PKCE verifier
      const t = o.seen.token[0] as URLSearchParams;
      expect(t.get("grant_type")).toBe("authorization_code");
      expect(t.get("code")).toBe("code-1");
      expect((t.get("code_verifier") ?? "").length).toBeGreaterThanOrEqual(43);
      expect(statSync(join(tmp, "o", "tokens.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(tmp, "o", "tokens.json"), "utf-8")).toContain("access-123");
    } finally {
      await o.stop();
    }
  });

  it("refuses a redirect whose state is not the one it issued, and stores no tokens", async () => {
    const o = oauthServer();
    const base = await o.start();
    try {
      await expect(
        runLogin({
          serverUrl: `${base}/mcp`,
          port: 0,
          dir: join(tmp, "o"),
          open: browser("code-1", () => "forged-state"),
        }),
      ).rejects.toThrow(LoginFailed);
      expect(o.seen.token).toHaveLength(0);
      expect(
        new TrialOAuthProvider({
          redirectUrl: "http://127.0.0.1:1/callback",
          dir: join(tmp, "o"),
        }).tokens(),
      ).toBeUndefined();
    } finally {
      await o.stop();
    }
  });

  it("fails clearly when the server refuses the sign-in, and when nothing arrives in time", async () => {
    const o = oauthServer();
    const base = await o.start();
    try {
      await expect(
        runLogin({
          serverUrl: `${base}/mcp`,
          port: 0,
          dir: join(tmp, "a"),
          open: async (u) =>
            void (await fetch(`${u.searchParams.get("redirect_uri")}?error=access_denied`)),
        }),
      ).rejects.toThrow(/refused the sign-in/);
      await expect(
        runLogin({
          serverUrl: `${base}/mcp`,
          port: 0,
          dir: join(tmp, "b"),
          open: () => undefined,
          timeoutMs: 80,
        }),
      ).rejects.toThrow(/before the timeout/);
    } finally {
      await o.stop();
    }
  });
});

/** how many more calls to the tool "limited" the fake server refuses with its rate-limit error result */
let limitedLeft = 0;

describe("the live MCP client", () => {
  async function connected(governor?: RateGovernor) {
    const server = new Server(
      { name: "fake-blockworks", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const calls: { name: string; args: unknown }[] = [];
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "timeseries_data",
          description: "read",
          inputSchema: { type: "object", properties: { model: { type: "string" } } },
        },
        {
          name: "tabular_catalog",
          description: "list",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search_documents",
          description: "articles",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      calls.push({ name: req.params.name, args: req.params.arguments });
      if (req.params.name === "tabular_catalog")
        return { isError: true, content: [{ type: "text", text: "no such table" }] };
      if (req.params.name === "search_documents")
        return { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
      if (req.params.name === "bad_args")
        throw new McpError(ErrorCode.InvalidParams, "no such model");
      if (req.params.name === "limited") {
        if (limitedLeft-- > 0)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: RATE_LIMITED: too many requests, wait before retrying (request ID 1)\n\nIf this result looks wrong or incomplete, report it.",
              },
            ],
          };
        return { content: [{ type: "text", text: "served" }] };
      }
      return {
        content: [
          { type: "text", text: '{"data":{"series":[]}}' },
          { type: "text", text: "more" },
        ],
      };
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const live = await LiveMcp.connect({
      transport: clientT,
      ...(governor !== undefined ? { governor } : {}),
    });
    return { live, calls };
  }

  it("lists the server's whole tool list, with the schemas, and marks which ones a model will be offered", async () => {
    const { live } = await connected();
    const tools = await live.tools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "search_documents",
      "tabular_catalog",
      "timeseries_data",
    ]);
    expect(tools.find((t) => t.name === "timeseries_data")?.inputSchema).toMatchObject({
      properties: { model: { type: "string" } },
    });
    expect(
      tools
        .filter((t) => MCP_DATA_TOOLS.includes(t.name))
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tabular_catalog", "timeseries_data"]);
    await live.close();
  });

  it("relays a tool's text as the model will see it, an error as an error, and anything that is not text as omitted", async () => {
    const { live, calls } = await connected();
    expect(await live.call("timeseries_data", { model: "x" })).toEqual({
      isError: false,
      text: '{"data":{"series":[]}}\nmore',
    });
    expect(calls[0]).toEqual({ name: "timeseries_data", args: { model: "x" } });
    expect(await live.call("tabular_catalog", {})).toEqual({
      isError: true,
      text: "no such table",
    });
    expect(await live.call("search_documents", { query: "q" })).toEqual({
      isError: false,
      text: "[image content omitted]",
    });
    await live.close();
  });

  it("relays a protocol error about the call (bad arguments) to the model as an error result, but reports no answer at all as a service failure that is not relayed", async () => {
    const { live } = await connected();
    // the server answered, with a refusal: the model's to handle
    expect(await live.call("bad_args", {})).toMatchObject({ isError: true });
    expect((await live.call("bad_args", {})).text).toContain("no such model");
    // the connection is gone: nothing answered, so nothing is relayed (D116)
    await live.close();
    const failed = await live.call("timeseries_data", { model: "x" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(McpTransportFailure);
    // only the class is kept, never the message
    expect((failed as Error).message).not.toContain("Not connected");
    expect((failed as McpTransportFailure).errorClass).toBe("Error");
  });

  it("treats the MCP's RATE_LIMITED error result as a 429: backs off and retries, so the model never sees it (7 of 22 sessions did, 20 to 23 October)", async () => {
    const governor = new RateGovernor({
      overrides: {
        [MCP_GOVERNOR_GROUP]: {
          minIntervalMs: 0,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
          maxRetries: 4,
        },
      },
    });
    const { live } = await connected(governor);
    limitedLeft = 2;
    expect(await live.call("limited", {})).toEqual({ isError: false, text: "served" });
    const r = governor.report().find((x) => x.group === MCP_GOVERNOR_GROUP);
    expect(r?.requestsToday).toBe(3); // two refused, one served
    expect(r?.tooManyRequests).toBe(2);
    await live.close();
  });

  it("and when the limit outlasts the retries it throws RateLimited, which is a service failure, not an error result for the model", async () => {
    const governor = new RateGovernor({
      overrides: {
        [MCP_GOVERNOR_GROUP]: {
          minIntervalMs: 0,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
          maxRetries: 2,
        },
      },
    });
    const { live } = await connected(governor);
    limitedLeft = 100;
    await expect(live.call("limited", {})).rejects.toBeInstanceOf(RateLimited);
    limitedLeft = 0;
    await live.close();
  });

  it("does not mistake a different error result for a rate limit", async () => {
    const governor = new RateGovernor({
      overrides: { [MCP_GOVERNOR_GROUP]: { minIntervalMs: 0 } },
    });
    const { live } = await connected(governor);
    expect(await live.call("tabular_catalog", {})).toEqual({
      isError: true,
      text: "no such table",
    });
    expect(governor.report().find((x) => x.group === MCP_GOVERNOR_GROUP)?.tooManyRequests).toBe(0);
    await live.close();
  });

  it("paces every call through the rate governor's mcp group, and counts them", async () => {
    let t = 1_000_000;
    const slept: number[] = [];
    const governor = new RateGovernor({
      overrides: { [MCP_GOVERNOR_GROUP]: { minIntervalMs: 2_000 } },
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    const { live } = await connected(governor);
    await live.call("timeseries_data", { model: "x" });
    await live.call("timeseries_data", { model: "x" });
    await live.call("timeseries_data", { model: "x" });
    expect(governor.report().find((r) => r.group === MCP_GOVERNOR_GROUP)?.requestsToday).toBe(3);
    expect(slept.length).toBeGreaterThanOrEqual(2); // the second and third calls waited for the spacing
    await live.close();
  });
});
