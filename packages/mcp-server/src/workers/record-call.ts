import { logToolCall } from "./analytics.js";
import { logSettlement, routeFor } from "./settlement-log.js";
import type { WorkerEnv } from "./worker-env.js";

/** What a cleared payment leaves on the request: set by Circle's middleware, or by ../self-settled.ts. */
export interface PaymentInfo {
  payer?: string;
  amount?: string;
  network?: string;
  transaction?: string;
}

/** The payment a paywall attached to the (shimmed) request, if any. */
export function paymentFrom(req: unknown): PaymentInfo | undefined {
  return (req as { payment?: PaymentInfo }).payment;
}

/**
 * Observability for one served call, shared by the MCP route and the REST routes: a usage data point
 * for every call, and a settlement-log row for every PAID one. It must never be able to break the
 * actual service — a write failure, or a binding being unavailable at all, is logged and swallowed,
 * never thrown. The settlement row is written after the response is on its way (waitUntil).
 */
export function recordCall(
  env: Pick<WorkerEnv, "USAGE" | "SETTLEMENTS">,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  tool: string,
  payment: PaymentInfo | undefined,
  selfSettledNetworks: readonly string[],
): void {
  try {
    logToolCall(env.USAGE, tool, payment?.payer);
  } catch (err) {
    console.error("usage logging failed:", err);
  }

  if (payment?.network) {
    ctx.waitUntil(
      logSettlement(
        env.SETTLEMENTS,
        {
          tool,
          network: payment.network,
          route: routeFor(payment.network, selfSettledNetworks),
          amount: payment.amount ?? "",
          payer: payment.payer ?? "",
          reference: payment.transaction ?? "",
          at: new Date().toISOString(),
        },
        (err) => console.error("settlement log write failed:", err),
      ),
    );
  }
}
