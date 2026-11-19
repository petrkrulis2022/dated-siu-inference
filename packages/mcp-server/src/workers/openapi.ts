import { TOOL_PRICES } from "../paywall.js";
import { PROFILES, type NetworkProfile } from "../networks.js";
import { TASK_CLASSES } from "../tools/get-quote.js";
import { SUPPORTED_VERIFY_RECEIPT_CHAINS } from "../tools/verify-receipt.js";
import type { ToolName } from "../tools/run.js";

export type OpenApiDocument = Record<string, unknown>;

type Schema = Record<string, unknown>;

const str = (description: string): Schema => ({ type: "string", description });
const object = (properties: Record<string, Schema>, required: string[]): Schema => ({
  type: "object",
  properties,
  required,
});

const ERROR_SCHEMA: Schema = object(
  {
    error: str("What went wrong, in words."),
    charged: { type: "boolean", description: "Whether this call was charged." },
  },
  ["error", "charged"],
);

const OUTPUT_SCHEMAS: Record<ToolName, Schema> = {
  get_index: {
    type: "object",
    description:
      "The signed print (schema: print.schema.json in the repository). `_meta` appears only on the latest print.",
    additionalProperties: true,
  },
  get_quote: object(
    {
      siu_per_call: str("SIU for one call of this task class on this model, a decimal string."),
      usd_per_call: str("The same call in USD, a decimal string."),
      usd_per_siu: str("The model's price per SIU in the print, a decimal string."),
      index_version: str("The basket version, e.g. SIU-2026a."),
      print_id: str("The print the quote was computed from."),
      print_hash: str("Hash of that print's body."),
    },
    ["siu_per_call", "usd_per_call", "usd_per_siu", "index_version", "print_id", "print_hash"],
  ),
  convert: object(
    {
      siu: str("The call's cost in SIU, a decimal string."),
      usd: str("The call's cost in USD, a decimal string."),
    },
    ["siu", "usd"],
  ),
  verify_receipt: {
    type: "object",
    description:
      "A signed receipt (schema: receipt.schema.json in the repository): what was quoted, what was paid, and whether they match.",
    properties: {
      schema_version: { type: "string" },
      quote_hash: { type: "string" },
      chain: { type: "string" },
      tx_ref: { type: "string" },
      matched: { type: "boolean" },
      print_ref: { type: "string" },
    },
    required: [
      "schema_version",
      "quote_hash",
      "chain",
      "tx_ref",
      "amount_quoted_usd",
      "amount_paid_usd",
      "matched",
      "print_ref",
      "signature",
      "public_key",
    ],
    additionalProperties: true,
  },
};

const jsonContent = (schema: Schema) => ({ "application/json": { schema } });

const usd = (tool: ToolName): string => (TOOL_PRICES[tool] ?? "").replace(/^\$/, "");

function paidResponses(tool: ToolName): Record<string, unknown> {
  return {
    "200": {
      description: "The result. The PAYMENT-RESPONSE header carries the settlement receipt.",
      headers: { "PAYMENT-RESPONSE": { schema: { type: "string" } } },
      content: jsonContent(OUTPUT_SCHEMAS[tool]),
    },
    "400": {
      description:
        "The arguments are invalid. Arguments are checked once a payment is attached, and nothing is charged.",
      content: jsonContent(ERROR_SCHEMA),
    },
    "402": {
      description:
        "Payment required. The PAYMENT-REQUIRED header carries the x402 challenge: the price, the networks accepted and the address paid. Retry with the signed payment in the PAYMENT-SIGNATURE header.",
      headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } },
    },
    "422": {
      description:
        "The arguments are well formed but the tool cannot answer them (for example a model the print excludes). Nothing is charged for get_quote and convert.",
      content: jsonContent(ERROR_SCHEMA),
    },
  };
}

function paidDescription(tool: ToolName, summary: string, profile: NetworkProfile): string {
  const floors = PROFILES[profile].selfSettled.map(
    (n) => `${n.name} (${n.network}) charges at least $${n.minimumPriceUsd}`,
  );
  const floorText =
    floors.length > 0 ? ` Networks settled one transaction per call: ${floors.join("; ")}.` : "";
  return `${summary} Price: $${usd(tool)} in USDC per call.${floorText}`;
}

const quoteParams = (): Schema[] => [
  {
    name: "task_class",
    in: "query",
    required: true,
    description: "Which task class of the basket.",
    schema: { type: "string", enum: [...TASK_CLASSES] },
  },
  {
    name: "model",
    in: "query",
    required: true,
    description: "A model id as listed in the print's exchange-rate table.",
    schema: { type: "string" },
  },
];

const convertParams = (): Schema[] => [
  {
    name: "model",
    in: "query",
    required: true,
    description: "A model id as listed in the print's exchange-rate table.",
    schema: { type: "string" },
  },
  {
    name: "input_tokens",
    in: "query",
    required: true,
    description: "Input tokens of the call.",
    schema: { type: "integer", minimum: 0 },
  },
  {
    name: "output_tokens",
    in: "query",
    required: true,
    description: "Output tokens of the call.",
    schema: { type: "integer", minimum: 0 },
  },
];

const quoteBody: Schema = object(
  {
    task_class: { type: "string", enum: [...TASK_CLASSES] },
    model: { type: "string" },
  },
  ["task_class", "model"],
);

const convertBody: Schema = object(
  {
    model: { type: "string" },
    input_tokens: { type: "integer", minimum: 0 },
    output_tokens: { type: "integer", minimum: 0 },
  },
  ["model", "input_tokens", "output_tokens"],
);

const verifyReceiptBody: Schema = object(
  {
    chain: { type: "string", enum: [...SUPPORTED_VERIFY_RECEIPT_CHAINS] },
    tx_hash: str("Transaction hash of the settlement."),
    quote: {
      type: "object",
      description:
        "The full signed touchstone-quote the settlement is claimed to be for (docs/datum-quote.md).",
      additionalProperties: true,
    },
  },
  ["chain", "tx_hash", "quote"],
);

/**
 * The OpenAPI 3.1 description of the REST routes (./rest.ts), for the x402 marketplaces that list
 * a paid HTTP route by reading its schema. Hand-written from the same tool shapes rather than
 * generated, so it adds no dependency; ./openapi.test.ts fails if the two drift. Built per profile:
 * it names only the networks and routes that profile can really deliver, so a spec fetched while
 * the service is on testnet never claims mainnet, and a tool a profile holds back is left out.
 */
export function buildOpenApi(options: {
  profile: NetworkProfile;
  origin: string;
}): OpenApiDocument {
  const { profile, origin } = options;
  const config = PROFILES[profile];
  const networks = [...config.circle.networks, ...config.selfSettled.map((n) => n.network)];
  const offered = (tool: ToolName) => !Object.hasOwn(config.unavailableTools, tool);

  const paths: Record<string, unknown> = {
    "/v1/index": {
      get: {
        operationId: "getIndex",
        summary: "The signed Dated SIU print (free)",
        description:
          "Returns the latest signed print, or the print for a date or a basket version. Free.",
        parameters: [
          {
            name: "date",
            in: "query",
            required: false,
            description: "A print date, YYYY-MM-DD.",
            schema: { type: "string" },
          },
          {
            name: "version",
            in: "query",
            required: false,
            description: "A basket version such as SIU-2026a; returns its latest print.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": { description: "The print.", content: jsonContent(OUTPUT_SCHEMAS.get_index) },
          "404": { description: "No such print.", content: jsonContent(ERROR_SCHEMA) },
        },
      },
    },
  };

  if (offered("get_quote")) {
    const description = paidDescription(
      "get_quote",
      "SIU price, exchange rate and index references for one task class and model.",
      profile,
    );
    paths["/v1/quote"] = {
      get: {
        operationId: "getQuote",
        summary: "Quote one task class on one model",
        description,
        "x-price-usd": usd("get_quote"),
        parameters: quoteParams(),
        responses: paidResponses("get_quote"),
      },
      post: {
        operationId: "postQuote",
        summary: "Quote one task class on one model",
        description,
        "x-price-usd": usd("get_quote"),
        requestBody: { required: true, content: jsonContent(quoteBody) },
        responses: paidResponses("get_quote"),
      },
    };
  }

  if (offered("convert")) {
    const description = paidDescription(
      "convert",
      "Convert a model call's token counts into SIU and USD.",
      profile,
    );
    paths["/v1/convert"] = {
      get: {
        operationId: "getConvert",
        summary: "Convert token counts into SIU and USD",
        description,
        "x-price-usd": usd("convert"),
        parameters: convertParams(),
        responses: paidResponses("convert"),
      },
      post: {
        operationId: "postConvert",
        summary: "Convert token counts into SIU and USD",
        description,
        "x-price-usd": usd("convert"),
        requestBody: { required: true, content: jsonContent(convertBody) },
        responses: paidResponses("convert"),
      },
    };
  }

  if (offered("verify_receipt")) {
    paths["/v1/verify-receipt"] = {
      post: {
        operationId: "verifyReceipt",
        summary: "Verify an on-chain settlement against a quote",
        description: paidDescription(
          "verify_receipt",
          "Reads an on-chain settlement and returns a signed receipt saying whether it matches the quote.",
          profile,
        ),
        "x-price-usd": usd("verify_receipt"),
        requestBody: { required: true, content: jsonContent(verifyReceiptBody) },
        responses: {
          ...paidResponses("verify_receipt"),
          "422": {
            description:
              "No such settlement, or the quote does not match it. The payment has already been taken.",
            content: jsonContent(ERROR_SCHEMA),
          },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Touchstone Assay: Dated SIU",
      version: "1.0.0",
      description:
        "Touchstone Assay publishes Dated SIU, the benchmark price of AI inference work, as a signed daily print. " +
        "GET /v1/index returns the print and is free. The other routes are paid per call in USDC over x402: until a payment is attached they answer HTTP 402 with the price and the networks accepted. " +
        "The same four tools are also served over MCP at /mcp.",
      "x-touchstone-networks": networks,
      "x-touchstone-network-profile": profile,
    },
    servers: [{ url: origin }],
    paths,
  };
}
