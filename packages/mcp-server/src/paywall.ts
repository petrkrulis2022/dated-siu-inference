import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type { NextFunction, Request, Response } from "express";
import { loadSellerAddressFromEnv } from "./env.js";
import {
  withSelfSettledNetworks,
  type SelfSettledNetwork,
  type SelfSettler,
} from "./self-settled.js";
import { toolArgumentsAreValid } from "./tools/schemas.js";

/**
 * build1-spec.md §9's three paid-tool prices. get_index is deliberately absent — it is never
 * looked up here, which is what keeps it free (see ../tools/get-index.ts's header comment).
 */
export const TOOL_PRICES: Record<string, string> = {
  get_quote: "$0.001",
  convert: "$0.001",
  verify_receipt: "$0.01",
};

export interface PaywallOptions {
  sellerAddress?: string;
  networks?: string | string[];
  facilitatorUrl?: string;
  /** Extra headers sent on every request to Circle's Gateway (e.g. an Authorization header). */
  headers?: Record<string, string>;
  /**
   * Networks Circle's Gateway does not cover (Kite), settled by this server itself — see
   * ./self-settled.ts. Absent means the paywall is exactly Circle's, unchanged.
   */
  selfSettled?: { networks: SelfSettledNetwork[]; settlers: Record<string, SelfSettler> };
}

export type ToolMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/** Reads the tool name out of a parsed JSON-RPC `tools/call` request body, or undefined for
 * anything else (a malformed body, a different method, a missing/non-string tool name). */
export function extractToolCallName(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (record.method !== "tools/call") {
    return undefined;
  }
  const params = record.params;
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

/** The `params.arguments` of a JSON-RPC `tools/call`, exactly as sent (undefined if absent). */
export function extractToolCallArguments(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const params = (body as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null) return undefined;
  return (params as Record<string, unknown>).arguments;
}

/**
 * Every MCP tool call is the same JSON-RPC shape hitting one POST /mcp route — the tool being
 * called is `params.name` inside the body, not the URL — so `gateway.require(price)` (Circle's
 * per-route Express middleware) can't be bound to a route per tool the way its own docs show.
 * Instead: build one priced middleware per paid tool up front, and dispatch to the right one (or
 * to neither) by inspecting the already-parsed JSON-RPC body before the MCP transport ever sees
 * the request. A `tools/call` for an unpriced tool (get_index) or any non-tools/call message
 * (initialize, tools/list, ...) skips payment checking entirely.
 *
 * Takes `requireFn` as a parameter — the dispatch *routing* logic (which tool needs which
 * middleware, and the free-tool bypass) is what's actually worth unit-testing precisely;
 * `paywall.test.ts` injects a fake `requireFn` so those tests never touch Circle's real gateway
 * client. `createToolPaywall` below is the thin production wiring that supplies the real one.
 *
 * `argumentsAreValid` (production: ./tools/schemas.ts) keeps a buyer from paying for a call the
 * MCP layer will reject: a paid tool whose arguments fail its schema goes through unpaid, and the
 * MCP layer answers with its own validation error — no tool work runs, so nothing is given away.
 */
export function createDispatcher(
  requireFn: (price: string) => ToolMiddleware,
  prices: Record<string, string> = TOOL_PRICES,
  argumentsAreValid: (tool: string, args: unknown) => boolean = () => true,
) {
  const middlewareByTool = new Map(
    Object.entries(prices).map(([tool, price]) => [tool, requireFn(price)] as const),
  );

  return function dispatchPaywall(req: Request, res: Response, next: NextFunction): void {
    const toolName = extractToolCallName(req.body);
    const middleware = toolName ? middlewareByTool.get(toolName) : undefined;
    if (!middleware || !argumentsAreValid(toolName as string, extractToolCallArguments(req.body))) {
      next();
      return;
    }
    void middleware(req, res, next);
  };
}

/**
 * `argumentsAreValid` defaults to the tools' own schemas (./tools/schemas.ts), so an MCP call that
 * would be rejected goes through unpaid. The REST routes (./workers/rest.ts) pass `() => true`: they
 * do that check themselves, and only once a payment is attached, because a marketplace's checker
 * calls a paid route unpaid and with no arguments and must still be shown the 402 challenge.
 */
export function createToolPaywall(
  options: PaywallOptions = {},
  argumentsAreValid: (tool: string, args: unknown) => boolean = toolArgumentsAreValid,
) {
  const sellerAddress = options.sellerAddress ?? loadSellerAddressFromEnv();
  const gateway = createGatewayMiddleware({
    sellerAddress,
    networks: options.networks,
    facilitatorUrl: options.facilitatorUrl,
    headers: options.headers,
    description: "Touchstone Assay — Dated SIU pricing tools (build1-spec.md §9)",
  });

  const circle = (price: string) => gateway.require(price) as ToolMiddleware;
  const selfSettled = options.selfSettled;
  if (!selfSettled || selfSettled.networks.length === 0) {
    return createDispatcher(circle, TOOL_PRICES, argumentsAreValid);
  }
  return createDispatcher(
    (price) =>
      withSelfSettledNetworks(price, circle(price), {
        networks: selfSettled.networks,
        settlers: selfSettled.settlers,
        payTo: sellerAddress,
      }),
    TOOL_PRICES,
    argumentsAreValid,
  );
}
