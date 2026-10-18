/**
 * Sign in to the live Blockworks MCP, once, in a browser (D91), and list the tools it offers.
 *
 *   pnpm --filter @touchstone/cr-lab run mcp-login               open the sign-in page; you sign in and enter your Blockworks API key THERE, on Blockworks' own page
 *   pnpm --filter @touchstone/cr-lab run mcp-login -- --check    no browser: use the stored login and list the tools (the daily login check); exit 1 if it no longer works
 *   ... -- --check --alert                                      the same, and email an alert if the login no longer works
 *
 * It sends no data request: signing in is an OAuth exchange, and listing the tools is the MCP's own tool listing. The tokens are kept privately and never printed. The tool list (names,
 * descriptions, input schemas) is written to the private directory, and its names are printed with the ones a model will be offered marked.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { privatePath } from "../paths.js";
import {
  CompositeAlertSink,
  FileAlertSink,
  ToastAlertSink,
  emailSinkFromEnv,
} from "../ops/alert.js";
import { LiveMcp, McpLoginRequired, BLOCKWORKS_MCP_URL } from "../mcp/live-mcp.js";
import { runLogin } from "../mcp/oauth-login.js";
import { DEFAULT_LOGIN_PORT, TrialOAuthProvider } from "../mcp/oauth-store.js";
import { MCP_DATA_TOOLS } from "../mcp/types.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = opt("port") !== undefined ? Number(opt("port")) : DEFAULT_LOGIN_PORT;

function openBrowser(url: URL): void {
  // WSL: hand the URL to Windows' default browser. Single quotes in PowerShell, so the & in the query string is not read as a separator.
  const ps = `Start-Process '${url.toString().replaceAll("'", "''")}'`;
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
  });
  p.on("error", () => undefined);
}

async function listTools(provider: TrialOAuthProvider): Promise<void> {
  const mcp = await LiveMcp.connect({ url: BLOCKWORKS_MCP_URL, provider });
  try {
    const tools = await mcp.tools();
    const file = privatePath("mcp-tools.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), tools }, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(
      `signed in: the server offers ${tools.length} tools (full list kept privately in data/private/blockworks/mcp-tools.json)`,
    );
    for (const t of tools) {
      const props = Object.keys(
        ((t.inputSchema as { properties?: object }).properties ?? {}) as object,
      );
      console.log(
        `  ${MCP_DATA_TOOLS.includes(t.name) ? "OFFERED  " : "withheld "} ${t.name}(${props.join(", ")})`,
      );
    }
  } finally {
    await mcp.close();
  }
}

if (flag("check")) {
  const provider = new TrialOAuthProvider({ redirectUrl: `http://127.0.0.1:${port}/callback` });
  const state = provider.describe();
  console.log(
    `stored login: registered ${state.registered}, signed in ${state.signedIn}, refresh token ${state.hasRefreshToken}`,
  );
  try {
    if (!state.signedIn) throw new McpLoginRequired();
    await listTools(provider);
  } catch (e) {
    const why =
      e instanceof McpLoginRequired
        ? e.message
        : `could not reach the MCP (${e instanceof Error ? e.name : "error"})`;
    console.log(`LOGIN CHECK FAILED: ${why}`);
    if (flag("alert")) {
      const email = emailSinkFromEnv();
      await new CompositeAlertSink(
        [
          new FileAlertSink(),
          ...(email.sink !== undefined ? [email.sink] : []),
          new ToastAlertSink(),
        ],
        (sink, reason) => console.log(`alert sink ${sink} failed: ${reason}`),
      ).send({
        at: new Date().toISOString(),
        kind: "mcp-login-failed",
        window: new Date().toISOString().slice(0, 10),
        message: `the Blockworks MCP login check failed: ${why}`,
      });
    }
    process.exit(1);
  }
} else {
  console.log(
    "Signing in to the Blockworks MCP. A browser window should open; if it does not, open the address printed below.",
  );
  const provider = await runLogin({
    serverUrl: BLOCKWORKS_MCP_URL,
    port,
    open: (url) => {
      console.log(
        `\nOpen this address, sign in, and enter your Blockworks API key when it asks:\n\n  ${url.toString()}\n`,
      );
      if (!flag("no-open")) openBrowser(url);
    },
  });
  await listTools(provider);
}
