import type { AnalyticsEngineDataset } from "@cloudflare/workers-types";

/**
 * Usage evidence for adoption tracking — call counts per tool, distinct callers — nothing else.
 * No request/response bodies, no prompt content, no IP addresses. For the three paid tools the
 * caller dimension is the settled payment's payer wallet address: already public on-chain (it's
 * the account that just paid), already the correct unit of "who" for this system, and it avoids
 * any IP-hashing/PII question entirely — a better adoption metric than distinct NAT'd browsers
 * would be, not a compromise. `get_index` is free and unauthenticated, so it's logged as a call
 * count with no caller dimension: there is no payment to attribute it to.
 */
export function logToolCall(
  usage: AnalyticsEngineDataset,
  tool: string,
  payerAddress?: string,
): void {
  usage.writeDataPoint({
    blobs: [tool, payerAddress ?? ""],
    doubles: [1],
    indexes: [payerAddress ?? tool],
  });
}
