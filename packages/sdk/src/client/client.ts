import type { Print } from "../types/generated/print.schema.js";
import type { Receipt } from "../types/generated/receipt.schema.js";
import { validatePrint } from "../validation/print.js";
import { validateReceipt } from "../validation/receipt.js";

/**
 * A typed client for the four MCP tools (build1-spec.md §9). Takes an **injected transport**
 * rather than owning one: the MCP server is P12 and does not exist yet, and
 * `@circle-fin/x402-batching` (the paywall gateway named in §9) is unverified as the real
 * current package (docs/plan.md:50) — wiring a concrete transport now would be a speculative
 * dependency on both. `callTool` is whatever P12's real MCP/x402 client ends up being; this
 * package only owns the shared type contract both mcp-server and agents build against.
 *
 * This inverts docs/plan.md's stated layering (a client living in Layer 0 `sdk`, the server it
 * calls in Layer 4 `mcp-server`) — acceptable because what's here is a type contract, not a
 * running client, but worth stating plainly rather than leaving implicit.
 */
export type CallToolFn = (toolName: string, args: object) => Promise<unknown>;

export interface DatumClientOptions {
  callTool: CallToolFn;
}

export interface GetIndexParams {
  version?: string;
  date?: string;
}

export interface GetQuoteParams {
  task_class: string;
  model: string;
}

/** "SIU price, exchange rate, index refs" per §9's tool table — index_version/print_id/
 * print_hash reuse the same "index refs" field names §8's datum-quote already carries, rather
 * than inventing new ones for the same concept. */
export interface GetQuoteResult {
  siu_per_call: string;
  usd_per_siu: string;
  index_version: string;
  print_id: string;
  print_hash: string;
}

export interface ConvertParams {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface ConvertResult {
  siu: string;
  usd: string;
}

export interface VerifyReceiptParams {
  chain: string;
  tx_hash: string;
}

function assertShape(
  value: unknown,
  fields: Record<string, "string" | "number">,
  toolName: string,
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${toolName} returned a non-object result`);
  }
  const record = value as Record<string, unknown>;
  for (const [field, type] of Object.entries(fields)) {
    if (typeof record[field] !== type) {
      throw new Error(`${toolName} returned a malformed result: "${field}" is not a ${type}`);
    }
  }
}

/**
 * No JSON Schema exists for get_quote/convert's responses (only the six core record types do —
 * see packages/sdk/schemas). Shape-checking them here, rather than skipping validation or
 * inventing a new schema unasked, keeps the client honest about malformed server output without
 * expanding schema scope beyond what P11 was asked to build.
 */
export function createDatumClient(options: DatumClientOptions) {
  return {
    async getIndex(params: GetIndexParams = {}): Promise<Print> {
      const raw = await options.callTool("get_index", params);
      const result = validatePrint(raw);
      if (!result.valid) {
        throw new Error(`get_index returned a malformed print: ${result.errors.join("; ")}`);
      }
      return result.data;
    },

    async getQuote(params: GetQuoteParams): Promise<GetQuoteResult> {
      const raw = await options.callTool("get_quote", params);
      assertShape(
        raw,
        {
          siu_per_call: "string",
          usd_per_siu: "string",
          index_version: "string",
          print_id: "string",
          print_hash: "string",
        },
        "get_quote",
      );
      return raw as GetQuoteResult;
    },

    async convert(params: ConvertParams): Promise<ConvertResult> {
      const raw = await options.callTool("convert", params);
      assertShape(raw, { siu: "string", usd: "string" }, "convert");
      return raw as ConvertResult;
    },

    async verifyReceipt(params: VerifyReceiptParams): Promise<Receipt> {
      const raw = await options.callTool("verify_receipt", params);
      const result = validateReceipt(raw);
      if (!result.valid) {
        throw new Error(`verify_receipt returned a malformed receipt: ${result.errors.join("; ")}`);
      }
      return result.data;
    },
  };
}

export type DatumClient = ReturnType<typeof createDatumClient>;
