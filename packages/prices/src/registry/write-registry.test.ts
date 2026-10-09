import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import { writeRegistry } from "./seed.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "touchstone-registry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (over: Partial<ModelRegistryEntry> = {}): ModelRegistryEntry => ({
  id: "m",
  provider: "openrouter",
  endpoint: "https://example.test/v1",
  model_string: "x/m",
  tier: "mid",
  open_weights: true,
  host: "h",
  ...over,
});

describe("writeRegistry", () => {
  it("keeps a declared sampling when the model is re-seeded without one", async () => {
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify([entry({ sampling: { temperature: "provider-default" } })]));
    await writeRegistry(path, [entry({ host: "h2" })]);
    const [e] = JSON.parse(await readFile(path, "utf-8")) as ModelRegistryEntry[];
    expect(e.host).toBe("h2");
    expect(e.sampling).toEqual({ temperature: "provider-default" });
  });

  it("takes a new declaration when the seed carries one, and adds a new model as it is", async () => {
    const path = join(dir, "models.json");
    await writeFile(path, JSON.stringify([entry({ sampling: { temperature: 0 } })]));
    await writeRegistry(path, [entry({ sampling: { temperature: 0.2 } }), entry({ id: "n" })]);
    const out = JSON.parse(await readFile(path, "utf-8")) as ModelRegistryEntry[];
    expect(out.find((e) => e.id === "m")?.sampling).toEqual({ temperature: 0.2 });
    expect(out.find((e) => e.id === "n")?.sampling).toBeUndefined();
  });
});
