/**
 * Phase 2 item 6 of the v3a build (docs/v2-code-check.md item 7b): the studio CLI takes its params file explicitly, and the roster's starting balances are what genesis()
 * itself gives, never a static echo of the config. Written before the fix and run against the unfixed code first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadParams } from "../economy/params.js";
import { loadCrPrint } from "../economy/runner.js";
import { CR_PUBLIC_DIR, REPO_ROOT } from "../paths.js";
import { buildRoster } from "./roster.js";

const V2 = join(CR_PUBLIC_DIR, "economy-params.v2.json");

describe("Phase 2 item 6: the studio's starting balances come from genesis itself, and its params file is never a silent default", () => {
  it("derives every starting wallet by running genesis: v2's hedger starts with 0.050000 USDC and 3.760779 AGU-lab, exactly as the v2 run's own genesis logged it", () => {
    const r = buildRoster(loadParams(V2), "counted-2026-11-08", loadCrPrint());
    const byId = new Map(r.agents.map((a) => [a.id, a]));
    expect(byId.get("HEDGER")?.startingUsdc).toBe("0.050000");
    expect(byId.get("HEDGER")?.startingAgu).toBe("3.760779");
    expect(byId.get("RESEARCH-1")?.startingUsdc).toBe("0.050000");
    expect(byId.get("DEMAND-1")?.startingUsdc).toBe("0.100000");
    expect(byId.get("DEMAND-1")?.startingAgu).toBe("0.000000");
    // the participant's own inventory: the nine 1.0 AGU-lab creations of the v2 log's seq 7-15, less the 3.760779 it sold the hedger at seq 16
    expect(byId.get("PARTICIPANT")?.startingAgu).toBe("5.239221");
  });

  it("the studio CLI refuses to run without --params, rather than silently reading the v1 file", () => {
    const out = join(mkdtempSync(join(tmpdir(), "studio-")), "agents.html");
    const r = spawnSync(
      join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [
        join(REPO_ROOT, "packages", "cr-lab", "src", "cli", "studio.ts"),
        "--seed",
        "counted-2026-11-08",
        "--out",
        out,
      ],
      { encoding: "utf-8", cwd: REPO_ROOT },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--params <path> is required/);
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});
