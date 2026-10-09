import { describe, expect, it } from "vitest";
import { validateModelRegistryEntry } from "@touchstone/sdk";
import { loadRegistry } from "./load-data.js";

/** The published registry, read from disk: every constituent states its sampling, as docs/methodology.md (Sampling settings) says. */
describe("data/registry/models.json declares every constituent's sampling", () => {
  it("has a valid entry, with a declared temperature, for every model", async () => {
    const registry = await loadRegistry();
    expect(registry.length).toBeGreaterThanOrEqual(10);
    for (const entry of registry) {
      expect(validateModelRegistryEntry(entry).valid, entry.id).toBe(true);
      expect(entry.sampling, `${entry.id} declares no sampling`).toBeDefined();
    }
  });

  it("declares claude-sonnet-5 at the provider default and every other constituent at temperature 0", async () => {
    const registry = await loadRegistry();
    for (const entry of registry) {
      expect(entry.sampling?.temperature, entry.id).toBe(entry.id === "claude-sonnet-5" ? "provider-default" : 0);
    }
  });
});
