import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertNoNetworkImports } from "@touchstone/task-pack-sdk";
import { TRIVIAL_ACCEPT_PACK } from "./pack.js";

describe("trivial-accept TaskPack", () => {
  it("accepts its own known-good fixture", async () => {
    const result = await TRIVIAL_ACCEPT_PACK.gate(TRIVIAL_ACCEPT_PACK.fixtures.knownGood, TRIVIAL_ACCEPT_PACK.fixtures.reference);
    expect(result.accept).toBe(true);
  });

  it("rejects its own adversarial fixture", async () => {
    const result = await TRIVIAL_ACCEPT_PACK.gate(TRIVIAL_ACCEPT_PACK.fixtures.adversarial[0], TRIVIAL_ACCEPT_PACK.fixtures.reference);
    expect(result.accept).toBe(false);
  });

  it("accepts any submission containing the required substring, rejects any that doesn't", async () => {
    expect((await TRIVIAL_ACCEPT_PACK.gate({ text: "xAPPROVEDx" }, TRIVIAL_ACCEPT_PACK.fixtures.reference)).accept).toBe(true);
    expect((await TRIVIAL_ACCEPT_PACK.gate({ text: "nope" }, TRIVIAL_ACCEPT_PACK.fixtures.reference)).accept).toBe(false);
  });
});

describe("pack.ts's own gate-exporting module", () => {
  it("imports no network/client library (spec §14.2 rule 3)", () => {
    const path = fileURLToPath(new URL("./pack.ts", import.meta.url));
    const source = readFileSync(path, "utf-8");
    expect(() => assertNoNetworkImports(source, path)).not.toThrow();
  });
});
