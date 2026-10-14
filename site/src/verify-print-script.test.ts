import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { printBodyHashHex, printBodyOf } from "@touchstone/print";
import type { Print } from "@touchstone/sdk";
// @ts-expect-error: a plain JavaScript file, published as a script people download and run; it has no type declarations on purpose.
import { CHAINS, EXCLUDED_FIELDS, bodyHashOf, canonicalJson, checkAnchors, findPrintPosted, keccak256Hex } from "../static/verify-print.mjs";
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

  describe("checkAnchors: every chain the print carries", () => {
    const hash = "0x1bc31661ace7ee155ae5e2fd4d1a7e4a6a47c844457abea9c5ee1f3ff0bcaa5a";
    const BASE_TX = "0x" + "ba".repeat(32);
    const ARC_TX = "0x" + "ac".repeat(32);
    const logsFor = (contract: string, bodyHash: string) => ({
      items: [{ address: { hash: contract }, block_number: 7, decoded: { parameters: [{ name: "bodyHash", value: bodyHash }, { name: "version", value: "SIU-2026a" }, { name: "timestamp", value: "1791939532" }] } }],
    });
    /** A fake explorer: answers by host and transaction, and records which URLs were asked for. */
    const fakeFetch = (answers: Record<string, unknown>) => {
      const asked: string[] = [];
      const fn = async (url: string) => {
        asked.push(url);
        const hit = Object.entries(answers).find(([k]) => url.includes(k));
        if (!hit) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => hit[1] };
      };
      return { fn, asked };
    };
    const base = (extra: Record<string, unknown> = {}) => ({ chain: "base-sepolia", status: "anchored", tx_hash: BASE_TX, ...extra });
    const arcAnchored = { chain: "arc-testnet", status: "anchored", tx_hash: ARC_TX };

    it("checks both chains, each against its own explorer and contract, and passes when both carry the hash", async () => {
      const { fn, asked } = fakeFetch({
        [`${CHAINS["base-sepolia"].explorer}/api/v2/transactions/${BASE_TX}`]: logsFor(CHAINS["base-sepolia"].contract, hash),
        [`${CHAINS["arc-testnet"].explorer}/api/v2/transactions/${ARC_TX}`]: logsFor(CHAINS["arc-testnet"].contract, hash),
      });
      const r = await checkAnchors({ anchor: base({ additional_anchors: [arcAnchored] }) }, hash, fn);
      expect(r.verified).toBe(2);
      expect(r.problems).toEqual([]);
      expect(asked).toHaveLength(2);
      expect(r.lines.join("\n")).toContain("ANCHORED on Base Sepolia");
      expect(r.lines.join("\n")).toContain("ANCHORED on Arc Testnet");
    });

    it("does not accept an Arc event emitted by the wrong contract, or carrying another hash", async () => {
      const wrongContract = fakeFetch({ [ARC_TX]: logsFor(CHAINS["base-sepolia"].contract, hash), [BASE_TX]: logsFor(CHAINS["base-sepolia"].contract, hash) });
      const a = await checkAnchors({ anchor: base({ additional_anchors: [arcAnchored] }) }, hash, wrongContract.fn);
      expect(a.verified).toBe(1);
      expect(a.problems).toEqual(["Arc Testnet: not found"]);
      const otherHash = fakeFetch({ [ARC_TX]: logsFor(CHAINS["arc-testnet"].contract, "0x" + "00".repeat(32)), [BASE_TX]: logsFor(CHAINS["base-sepolia"].contract, hash) });
      const b = await checkAnchors({ anchor: base({ additional_anchors: [arcAnchored] }) }, hash, otherHash.fn);
      expect(b.problems).toEqual(["Arc Testnet: not found"]);
    });

    it("prints a further chain recorded as failed or skipped as recorded, and is not an error: that chain is best-effort", async () => {
      const { fn } = fakeFetch({ [BASE_TX]: logsFor(CHAINS["base-sepolia"].contract, hash) });
      for (const status of ["failed", "skipped"]) {
        const r = await checkAnchors({ anchor: base({ additional_anchors: [{ chain: "arc-testnet", status, notes: "rpc down" }] }) }, hash, fn);
        expect(r.verified).toBe(1);
        expect(r.problems).toEqual([]);
        expect(r.lines.join("\n")).toContain(`recorded as ${status} (rpc down)`);
      }
    });

    it("does not pass on an unchecked claim alone: 'already-anchored' with no transaction is printed, never counted as verified", async () => {
      const r = await checkAnchors({ anchor: { chain: "arc-testnet", status: "already-anchored" } }, hash, fakeFetch({}).fn);
      expect(r.verified).toBe(0);
      expect(r.lines.join("\n")).toContain("postedAt(bodyHash)");
    });

    it("fails when the print's own (first) anchor is missing or not anchored, even if a further chain verified", async () => {
      const { fn } = fakeFetch({ [ARC_TX]: logsFor(CHAINS["arc-testnet"].contract, hash) });
      const none = await checkAnchors({}, hash, fn);
      expect(none.problems).toEqual(["no anchor"]);
      const pending = await checkAnchors({ anchor: { chain: "base-sepolia", status: "failed", notes: "x", additional_anchors: [arcAnchored] } }, hash, fn);
      expect(pending.verified).toBe(1);
      expect(pending.problems).toEqual(["Base Sepolia: not anchored"]);
    });

    it("reports an explorer outage, whether it answers with an error or throws, as a problem rather than a pass", async () => {
      const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
      const a = await checkAnchors({ anchor: base() }, hash, down);
      expect(a.problems).toEqual(["Base Sepolia: lookup failed"]);
      const throws = async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      };
      const b = await checkAnchors({ anchor: base() }, hash, throws);
      expect(b.problems).toEqual(["Base Sepolia: lookup failed"]);
      expect(b.lines.join("\n")).toContain("ENOTFOUND");
    });

    it("an older print with no additional_anchors is checked on its one chain exactly as before", async () => {
      const { fn, asked } = fakeFetch({ [BASE_TX]: logsFor(CHAINS["base-sepolia"].contract, hash) });
      const r = await checkAnchors({ anchor: base() }, hash, fn);
      expect(r.verified).toBe(1);
      expect(r.problems).toEqual([]);
      expect(asked).toHaveLength(1);
    });
  });
});
