import { DATED_SIU_PHRASE } from "@touchstone/print";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_PRICES } from "../paywall.js";
import { PROFILES, type NetworkProfile } from "../networks.js";
import { TOOL_INPUT_SHAPES } from "../tools/schemas.js";
import { TASK_CLASSES } from "../tools/get-quote.js";
import { SUPPORTED_VERIFY_RECEIPT_CHAINS } from "../tools/verify-receipt.js";
import { buildOpenApi } from "./openapi.js";

type Operation = {
  operationId: string;
  "x-price-usd"?: string;
  description: string;
  parameters?: { name: string; in: string; required: boolean; schema: Record<string, unknown> }[];
  requestBody?: {
    content: {
      "application/json": { schema: { properties: Record<string, unknown>; required: string[] } };
    };
  };
  responses: Record<string, unknown>;
};
type Doc = {
  openapi: string;
  info: Record<string, unknown> & { description: string };
  servers: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
};

const doc = (profile: NetworkProfile): Doc =>
  buildOpenApi({ profile, origin: "https://mcp.example" }) as unknown as Doc;

const keysOf = (tool: keyof typeof TOOL_INPUT_SHAPES) =>
  Object.keys(TOOL_INPUT_SHAPES[tool]).sort();
const requiredOf = (tool: keyof typeof TOOL_INPUT_SHAPES) =>
  Object.entries(TOOL_INPUT_SHAPES[tool])
    .filter(([, schema]) => !(schema as z.ZodTypeAny).isOptional())
    .map(([key]) => key)
    .sort();

describe("buildOpenApi", () => {
  it("is an OpenAPI 3.1 document served from the origin it was asked for", () => {
    const d = doc("testnet");
    expect(d.openapi).toBe("3.1.0");
    expect(d.servers).toEqual([{ url: "https://mcp.example" }]);
  });

  describe("agrees with the tools' own input shapes, so the spec cannot drift from what is validated", () => {
    it.each([
      ["/v1/quote", "get_quote"],
      ["/v1/convert", "convert"],
    ] as const)(
      "%s: query parameters and body properties are exactly the tool's arguments",
      (path, tool) => {
        const ops = doc("testnet").paths[path] as Record<string, Operation>;
        const get = ops.get as Operation;
        const post = ops.post as Operation;
        expect((get.parameters ?? []).map((p) => p.name).sort()).toEqual(keysOf(tool));
        expect(
          (get.parameters ?? [])
            .filter((p) => p.required)
            .map((p) => p.name)
            .sort(),
        ).toEqual(requiredOf(tool));
        const body = post.requestBody?.content["application/json"].schema;
        expect(Object.keys(body?.properties ?? {}).sort()).toEqual(keysOf(tool));
        expect([...(body?.required ?? [])].sort()).toEqual(requiredOf(tool));
      },
    );

    it("/v1/index: optional date and version, as get_index takes", () => {
      const get = doc("testnet").paths["/v1/index"]?.get as Operation;
      expect((get.parameters ?? []).map((p) => p.name).sort()).toEqual(keysOf("get_index"));
      expect((get.parameters ?? []).every((p) => !p.required)).toBe(true);
    });

    it("/v1/verify-receipt: the body is chain, tx_hash and quote, all required", () => {
      const post = doc("testnet").paths["/v1/verify-receipt"]?.post as Operation;
      const body = post.requestBody?.content["application/json"].schema;
      expect(Object.keys(body?.properties ?? {}).sort()).toEqual(keysOf("verify_receipt"));
      expect([...(body?.required ?? [])].sort()).toEqual(requiredOf("verify_receipt"));
    });

    it("lists the task classes and receipt chains the tools accept, no more and no fewer", () => {
      const d = doc("testnet");
      const taskParam = (d.paths["/v1/quote"]?.get as Operation).parameters?.find(
        (p) => p.name === "task_class",
      );
      expect(taskParam?.schema.enum).toEqual([...TASK_CLASSES]);
      const chain = ((d.paths["/v1/verify-receipt"]?.post as Operation).requestBody?.content[
        "application/json"
      ].schema.properties.chain ?? {}) as { enum: string[] };
      expect(chain.enum).toEqual([...SUPPORTED_VERIFY_RECEIPT_CHAINS]);
    });
  });

  it("states each paid route's price as the paywall charges it", () => {
    const d = doc("testnet");
    expect(d.paths["/v1/quote"]?.get?.["x-price-usd"]).toBe(
      TOOL_PRICES.get_quote?.replace("$", ""),
    );
    expect(d.paths["/v1/convert"]?.post?.["x-price-usd"]).toBe(
      TOOL_PRICES.convert?.replace("$", ""),
    );
    expect(d.paths["/v1/verify-receipt"]?.post?.["x-price-usd"]).toBe(
      TOOL_PRICES.verify_receipt?.replace("$", ""),
    );
    expect(d.paths["/v1/index"]?.get?.["x-price-usd"]).toBeUndefined();
  });

  it("documents the 402 challenge on every paid operation and not on the free one", () => {
    const d = doc("testnet");
    for (const [path, method] of [
      ["/v1/quote", "get"],
      ["/v1/quote", "post"],
      ["/v1/convert", "get"],
      ["/v1/convert", "post"],
      ["/v1/verify-receipt", "post"],
    ] as const) {
      expect(d.paths[path]?.[method]?.responses).toHaveProperty("402");
    }
    expect(d.paths["/v1/index"]?.get?.responses).not.toHaveProperty("402");
  });

  describe("names only what the profile can deliver", () => {
    it("testnet: every route, and exactly the testnet networks", () => {
      const d = doc("testnet");
      expect(Object.keys(d.paths).sort()).toEqual([
        "/v1/convert",
        "/v1/index",
        "/v1/quote",
        "/v1/verify-receipt",
      ]);
      expect(d.info["x-touchstone-networks"]).toEqual([
        ...PROFILES.testnet.circle.networks,
        ...PROFILES.testnet.selfSettled.map((n) => n.network),
      ]);
    });

    it("mainnet: no verify-receipt, and exactly the mainnet networks", () => {
      const d = doc("mainnet");
      expect(Object.keys(d.paths).sort()).toEqual(["/v1/convert", "/v1/index", "/v1/quote"]);
      expect(d.info["x-touchstone-networks"]).toEqual([
        ...PROFILES.mainnet.circle.networks,
        ...PROFILES.mainnet.selfSettled.map((n) => n.network),
      ]);
    });

    it("never lets a testnet spec name a mainnet network, or the reverse", () => {
      const mainnetIds = [
        ...PROFILES.mainnet.circle.networks,
        ...PROFILES.mainnet.selfSettled.map((n) => n.network),
      ];
      const testnetIds = [
        ...PROFILES.testnet.circle.networks,
        ...PROFILES.testnet.selfSettled.map((n) => n.network),
      ];
      const testnet = doc("testnet").info["x-touchstone-networks"] as string[];
      const mainnet = doc("mainnet").info["x-touchstone-networks"] as string[];
      expect(testnet.some((n) => mainnetIds.includes(n))).toBe(false);
      expect(mainnet.some((n) => testnetIds.includes(n))).toBe(false);
    });

    it("says what Kite's per-call floor is, from the same constant the paywall uses", () => {
      const kite = PROFILES.testnet.selfSettled[0];
      expect(doc("testnet").paths["/v1/quote"]?.get?.description).toContain(
        `charges at least $${kite?.minimumPriceUsd}`,
      );
    });

    it("on mainnet, where Kite is held back, mentions no Kite network or floor", () => {
      const text = JSON.stringify(doc("mainnet"));
      expect(text).not.toMatch(/Kite|eip155:2366/);
    });
  });

  it("never uses a word CLAUDE.md bans from listings and docs", () => {
    for (const profile of ["testnet", "mainnet", "base-sepolia"] as const) {
      expect(JSON.stringify(doc(profile))).not.toMatch(
        /backed by|\bpeg\b|invest|real-time|oracle|AIXD/i,
      );
    }
  });
});

describe("the OpenAPI description agents and Circle's reviewers read", () => {
  it("says verified AI work, from the shared phrase, never AI inference", () => {
    for (const p of ["mainnet", "testnet"] as const) {
      expect(doc(p).info.description).toContain(DATED_SIU_PHRASE);
      expect(doc(p).info.description).not.toMatch(/AI inference/);
    }
  });
});
