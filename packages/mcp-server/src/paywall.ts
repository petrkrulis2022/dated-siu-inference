import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type { NextFunction, Request, Response } from "express";
import { loadSellerAddressFromEnv } from "./env.js";

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
 */
export function createDispatcher(
  requireFn: (price: string) => ToolMiddleware,
  prices: Record<string, string> = TOOL_PRICES,
) {
  const middlewareByTool = new Map(
    Object.entries(prices).map(([tool, price]) => [tool, requireFn(price)] as const),
  );

  return function dispatchPaywall(req: Request, res: Response, next: NextFunction): void {
    const toolName = extractToolCallName(req.body);
    const middleware = toolName ? middlewareByTool.get(toolName) : undefined;
    if (!middleware) {
      next();
      return;
    }
    void middleware(req, res, next);
  };
}

export function createToolPaywall(options: PaywallOptions = {}) {
  const sellerAddress = options.sellerAddress ?? loadSellerAddressFromEnv();
  const gateway = createGatewayMiddleware({
    sellerAddress,
    networks: options.networks,
    facilitatorUrl: options.facilitatorUrl,
    description: "Touchstone Assay — Dated SIU pricing tools (build1-spec.md §9)",
  });

  return createDispatcher((price) => gateway.require(price) as ToolMiddleware);
}
