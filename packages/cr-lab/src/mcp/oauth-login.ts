/**
 * The one-time browser sign-in to the live Blockworks MCP (D91). It starts a tiny server on 127.0.0.1 to catch the redirect, asks the SDK to begin the authorization (which registers us with the
 * server if we are not yet registered and builds the sign-in URL), hands that URL to `open` (the owner opens it, signs in and enters the Blockworks API key on Blockworks' own page), checks the
 * `state` the browser brings back, and exchanges the code for tokens, which the provider stores privately. Nothing secret is printed or logged; the callback page says nothing but "done".
 */
import { createServer, type Server } from "node:http";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { DEFAULT_LOGIN_PORT, TrialOAuthProvider } from "./oauth-store.js";

export interface LoginOptions {
  /** the MCP server's URL, e.g. https://mcp.blockworks.com/mcp */
  serverUrl: string;
  port?: number;
  /** state directory, for tests */
  dir?: string;
  /** shown the URL to open; the real command prints it and tries to open a browser */
  open: (url: URL) => void | Promise<void>;
  /** how long to wait for the browser, default ten minutes */
  timeoutMs?: number;
}

export class LoginFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginFailed";
  }
}

interface Callback {
  code?: string;
  state?: string;
  error?: string;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : port);
    });
  });
}

export async function runLogin(opts: LoginOptions): Promise<TrialOAuthProvider> {
  let deliver!: (c: Callback) => void;
  const callback = new Promise<Callback>((r) => (deliver = r));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Done. You can close this window and go back to the terminal.");
    deliver({
      ...(u.searchParams.get("code") !== null
        ? { code: u.searchParams.get("code") as string }
        : {}),
      ...(u.searchParams.get("state") !== null
        ? { state: u.searchParams.get("state") as string }
        : {}),
      ...(u.searchParams.get("error") !== null
        ? { error: u.searchParams.get("error") as string }
        : {}),
    });
  });
  const port = await listen(server, opts.port ?? DEFAULT_LOGIN_PORT);
  const provider = new TrialOAuthProvider({
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
    onRedirect: opts.open,
  });
  try {
    const started = await auth(provider as OAuthClientProvider, { serverUrl: opts.serverUrl });
    if (started === "AUTHORIZED") return provider; // already signed in, or the stored tokens refreshed
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new LoginFailed("no sign-in arrived before the timeout")),
        opts.timeoutMs ?? 600_000,
      ).unref(),
    );
    const back = await Promise.race([callback, timeout]);
    if (back.error !== undefined)
      throw new LoginFailed(`the server refused the sign-in (${back.error.slice(0, 40)})`);
    if (back.code === undefined) throw new LoginFailed("the redirect carried no code");
    if (back.state !== provider.expectedState())
      throw new LoginFailed("the redirect's state did not match: not trusting it");
    const done = await auth(provider as OAuthClientProvider, {
      serverUrl: opts.serverUrl,
      authorizationCode: back.code,
    });
    if (done !== "AUTHORIZED") throw new LoginFailed("the code was not accepted");
    return provider;
  } finally {
    server.close();
  }
}
