import { Hono, type Context } from "hono";
import { TOOL_PRICES, type createToolPaywall } from "../paywall.js";
import { PROFILES, type NetworkProfile } from "../networks.js";
import { toolArgumentsAreValid } from "../tools/schemas.js";
import { TASK_CLASSES } from "../tools/get-quote.js";
import { SUPPORTED_VERIFY_RECEIPT_CHAINS } from "../tools/verify-receipt.js";
import { runTool, type ToolDeps, type ToolName } from "../tools/run.js";
import { createNodeShim } from "./node-shim.js";
import { buildOpenApi } from "./openapi.js";
import { paymentFrom, type PaymentInfo } from "./record-call.js";

type Paywall = ReturnType<typeof createToolPaywall>;

/** Everything the routes need from the outside, so a test can hand in fakes and the Worker the real thing. */
export interface RestDeps<E> {
  profileFor(env: E): Promise<NetworkProfile>;
  paywallFor(profile: NetworkProfile, env: E): Paywall;
  toolDepsFor(env: E): ToolDeps;
  record(
    env: E,
    ctx: ExecutionContextLike,
    tool: string,
    payment: PaymentInfo | undefined,
    selfSettledNetworks: readonly string[],
  ): void;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** x402 v2: the signed payment rides in this header (Circle's middleware and ../self-settled.ts read the same one). */
const PAYMENT_HEADER = "payment-signature";
const PAYWALL_TIMEOUT_MS = 25_000;

const INVALID_ARGUMENTS: Record<ToolName, string> = {
  get_index: "get_index takes optional string parameters date and version.",
  get_quote: `get_quote needs task_class (one of ${[...TASK_CLASSES].join(", ")}) and model.`,
  convert: "convert needs model, and input_tokens and output_tokens as non-negative integers.",
  verify_receipt: `verify_receipt needs chain (one of ${SUPPORTED_VERIFY_RECEIPT_CHAINS.join(", ")}), tx_hash, and a valid touchstone-quote as quote.`,
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The named parameters that are present, as strings; a missing one stays missing so validation names it. */
function pick(query: Record<string, string>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** A query-string token count as the integer it spells; anything else stays text and fails validation. */
function tokenCount(text: string): number | string {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : text;
}

function queryArgs(tool: ToolName, query: Record<string, string>): Record<string, unknown> {
  switch (tool) {
    case "get_index":
      return pick(query, ["date", "version"]);
    case "get_quote":
      return pick(query, ["task_class", "model"]);
    case "convert": {
      const args = pick(query, ["model"]);
      for (const key of ["input_tokens", "output_tokens"]) {
        const value = query[key];
        if (value !== undefined) args[key] = tokenCount(value);
      }
      return args;
    }
    case "verify_receipt":
      return {};
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("paywall timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tool over HTTP. The same tool glue (../tools/run.ts) and the same paywall as the MCP route, so
 * the prices, the networks, Kite's lane and the settlement log are all unchanged; only the door is
 * different: a plain HTTP route that answers 402 on its own URL, which is what an x402 marketplace
 * lists and probes.
 *
 * Order matters. With no payment attached a paid route always answers 402: a marketplace checker
 * calls it unpaid and with no arguments, and a challenge costs the caller nothing. Once a payment is
 * attached, everything that can be known beforehand is checked BEFORE the paywall settles it, so a
 * call that cannot succeed is refused uncharged (the same rule the MCP route keeps): the arguments
 * and, for get_quote and convert, the answer itself, which is then served without computing it twice.
 * verify_receipt's chain read happens after payment, as on MCP.
 */
async function serve<E extends object>(
  d: RestDeps<E>,
  c: Context<{ Bindings: E }>,
  tool: ToolName,
  args: unknown,
): Promise<Response> {
  const profile = await d.profileFor(c.env);
  const config = PROFILES[profile];

  const unavailable = config.unavailableTools[tool];
  if (unavailable) return c.json({ error: unavailable, charged: false }, 501);

  const toolDeps = d.toolDepsFor(c.env);
  const selfSettled = config.selfSettled.map((n) => n.network);

  if (!Object.hasOwn(TOOL_PRICES, tool)) {
    try {
      const value = await runTool(tool, args, toolDeps);
      d.record(c.env, c.executionCtx, tool, undefined, selfSettled);
      return c.json(value as object);
    } catch (err) {
      return c.json({ error: message(err), charged: false }, 404);
    }
  }

  let precomputed: { value: unknown } | undefined;
  if (c.req.header(PAYMENT_HEADER) !== undefined) {
    if (!toolArgumentsAreValid(tool, args)) {
      return c.json({ error: INVALID_ARGUMENTS[tool], charged: false }, 400);
    }
    if (tool === "get_quote" || tool === "convert") {
      try {
        precomputed = { value: await runTool(tool, args, toolDeps) };
      } catch (err) {
        return c.json({ error: message(err), charged: false }, 422);
      }
    }
  }

  const shim = createNodeShim(c.req.raw, {
    jsonrpc: "2.0",
    id: null,
    method: "tools/call",
    params: { name: tool, arguments: args ?? {} },
  });
  d.paywallFor(profile, c.env)(shim.req, shim.res, shim.next);
  try {
    await withTimeout(shim.settled, PAYWALL_TIMEOUT_MS);
  } catch {
    return c.json(
      { error: "The payment service did not answer in time. Nothing was delivered." },
      504,
    );
  }

  if (!shim.nextCalled()) {
    const challenge = shim.getResult();
    return new Response(challenge?.body ?? "", {
      status: challenge?.status ?? 402,
      headers: { ...challenge?.headers, "x-touchstone-network-profile": profile },
    });
  }

  // The payment has cleared: it is recorded whether or not the tool then succeeds, as on MCP.
  d.record(c.env, c.executionCtx, tool, paymentFrom(shim.req), selfSettled);
  const receipt = shim.responseHeaders()["PAYMENT-RESPONSE"];
  if (receipt) c.header("PAYMENT-RESPONSE", receipt);
  c.header("Cache-Control", "no-store");

  try {
    const value = precomputed ? precomputed.value : await runTool(tool, args, toolDeps);
    return c.json(value as object);
  } catch (err) {
    return c.json({ error: message(err), charged: true }, 422);
  }
}

async function bodyArgs<E extends object>(c: Context<{ Bindings: E }>): Promise<unknown> {
  const body: unknown = await c.req.json().catch(() => undefined);
  return isRecord(body) ? body : undefined;
}

/**
 * The REST door to the four tools, plus the OpenAPI document describing it. Mounted next to the MCP
 * route by ./index.ts; nothing here changes how /mcp behaves.
 */
export function createRestApp<E extends object>(d: RestDeps<E>): Hono<{ Bindings: E }> {
  const app = new Hono<{ Bindings: E }>();

  app.get("/v1/index", (c) => serve(d, c, "get_index", queryArgs("get_index", c.req.query())));

  app.get("/v1/quote", (c) => serve(d, c, "get_quote", queryArgs("get_quote", c.req.query())));
  app.post("/v1/quote", async (c) => serve(d, c, "get_quote", await bodyArgs(c)));

  app.get("/v1/convert", (c) => serve(d, c, "convert", queryArgs("convert", c.req.query())));
  app.post("/v1/convert", async (c) => serve(d, c, "convert", await bodyArgs(c)));

  app.post("/v1/verify-receipt", async (c) => serve(d, c, "verify_receipt", await bodyArgs(c)));

  app.get("/openapi.json", async (c) => {
    const profile = await d.profileFor(c.env);
    c.header("Cache-Control", "public, max-age=60");
    return c.json(buildOpenApi({ profile, origin: new URL(c.req.url).origin }));
  });

  return app;
}
