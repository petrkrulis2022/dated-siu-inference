import { describe, expect, it } from "vitest";
import { validateRunManifest } from "./run-manifest.js";

describe("validateRunManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validateRunManifest({
      print_id: "2026-08-25",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: ["040a4ce0-c2ff-49a5-8cc2-f6cb4b174cec.json"],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts an empty run_records list", () => {
    const result = validateRunManifest({
      print_id: "2026-08-25",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: [],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a manifest missing a required field", () => {
    const result = validateRunManifest({
      print_id: "2026-08-25",
      basket_version: "SIU-2026a",
      run_records: [],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an unknown field", () => {
    const result = validateRunManifest({
      print_id: "2026-08-25",
      basket_version: "SIU-2026a",
      methodology_version: "v0-draft",
      run_records: [],
      extra: "not allowed",
    });
    expect(result.valid).toBe(false);
  });
});
