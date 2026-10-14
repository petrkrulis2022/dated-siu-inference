import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { printBodyHashHex, printBodyOf } from "@touchstone/print";
import type { Print } from "@touchstone/sdk";
// @ts-expect-error: a plain JavaScript file, published as a script people download and run; it has no type declarations on purpose.
import { CHAINS, EXCLUDED_FIELDS, bodyHashOf, canonicalJson, findPrintPosted, keccak256Hex } from "../static/verify-print.mjs";
import { EXCLUDED_FIELDS as RECIPE_FIELDS } from "./verify-recipe.js";

const REPO = resolve(process.cwd(), "..");
const PRINTS = join(REPO, "data/prints");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("verify-print.mjs: the script anyone downloads and runs", () => {
  it("is keccak256 (the original padding), not SHA3-256: it matches the published test vectors", () => {
    expect(keccak256Hex(utf8(""))).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256Hex(utf8("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    // Longer than one 136-byte block, and exactly one block, so the multi-block and padding-edge paths run.
    expect(keccak256Hex(utf8("a".repeat(136)))).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keccak256Hex(utf8("a".repeat(200)))).not.toBe(keccak256Hex(utf8("a".repeat(201))));
  });

  it("canonicalises like RFC 8785 for what a print holds: keys sorted, no whitespace, nested", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0.5, y: "é" } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":0.5}}');
  });

  it("reproduces the body hash of EVERY published print exactly as packages/print computes it", () => {
    const files = readdirSync(PRINTS).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const print = JSON.parse(readFileSync(join(PRINTS, f), "utf-8")) as Print;
      expect(bodyHashOf(print), f).toBe(printBodyHashHex(print));
    }
  });

  it("removes exactly the five fields the code removes, and the page and verify.json list the same five", () => {
    const marked = Object.fromEntries(EXCLUDED_FIELDS.map((f: string) => [f, "x"]));
    const body = printBodyOf({ ...marked, keep: 1 } as unknown as Print) as unknown as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["keep"]);
    expect([...EXCLUDED_FIELDS].sort()).toEqual([...RECIPE_FIELDS].sort());
  });

  it("carries the same contract table as the deployment records", () => {
    for (const slug of ["base-sepolia", "arc-testnet"]) {
      const d = JSON.parse(readFileSync(join(REPO, "data/deployments", `${slug}.json`), "utf-8"));
      const c = CHAINS[slug];
      expect(c.contract).toBe(d.contracts.TouchstoneAttestation.address);
      expect(c.publisher).toBe(d.contracts.TouchstoneAttestation.constructorArgs.publisher_);
      expect(c.explorer).toBe(d.network.explorer);
      expect(c.chainId).toBe(d.network.chainId);
    }
  });

  it("finds a PrintPosted event for the hash in an explorer's logs, and only from the contract", () => {
    const hash = "0x1bc31661ace7ee155ae5e2fd4d1a7e4a6a47c844457abea9c5ee1f3ff0bcaa5a";
    const logs = {
      items: [
        { address: { hash: "0xAAAA" }, block_number: 1, decoded: { parameters: [{ name: "bodyHash", value: hash }] } },
        { address: { hash: "0xf60701793ed168ffd6e818e1dccb600393297190" }, block_number: 48085622, decoded: { parameters: [{ name: "bodyHash", value: hash.toUpperCase().replace("0X", "0x") }, { name: "version", value: "SIU-2026a" }, { name: "timestamp", value: "1791939532" }] } },
      ],
    };
    expect(findPrintPosted(logs, CHAINS["base-sepolia"].contract, hash)).toEqual({ block: 48085622, version: "SIU-2026a", timestamp: 1791939532 });
    expect(findPrintPosted(logs, CHAINS["arc-testnet"].contract, hash)).toBeUndefined();
    expect(findPrintPosted(logs, CHAINS["base-sepolia"].contract, "0x" + "00".repeat(32))).toBeUndefined();
    expect(findPrintPosted({}, CHAINS["base-sepolia"].contract, hash)).toBeUndefined();
  });
});
