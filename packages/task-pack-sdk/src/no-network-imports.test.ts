import { describe, expect, it } from "vitest";
import { assertNoNetworkImports, findDisallowedImports } from "./no-network-imports.js";

describe("findDisallowedImports", () => {
  it("finds a Node network builtin import", () => {
    expect(findDisallowedImports('import { request } from "node:http";')).toEqual(["node:http"]);
  });

  it("finds a known HTTP client library import", () => {
    expect(findDisallowedImports('import axios from "axios";')).toEqual(["axios"]);
  });

  it("finds a known DB client library import", () => {
    expect(findDisallowedImports('import { Pool } from "pg";')).toEqual(["pg"]);
  });

  it("finds nothing in a clean gate module's real import list", () => {
    const source = [
      'import { readFile } from "node:fs/promises";',
      'import { join } from "node:path";',
      'import type { GateResult } from "@touchstone/task-pack-sdk";',
      'import { runGateHardeningChecks } from "./gate/executor.js";',
    ].join("\n");
    expect(findDisallowedImports(source)).toEqual([]);
  });
});

describe("assertNoNetworkImports", () => {
  it("throws with the offending specifier named, when a disallowed import is present", () => {
    expect(() => assertNoNetworkImports('import fetch from "node-fetch";', "gate.ts")).toThrow(
      /gate\.ts imports a disallowed network\/client module: node-fetch/,
    );
  });

  it("does not throw for a clean module", () => {
    expect(() => assertNoNetworkImports('import { join } from "node:path";', "gate.ts")).not.toThrow();
  });
});
