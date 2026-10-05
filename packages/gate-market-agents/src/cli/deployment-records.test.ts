import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadGateMarketDeployment, repoRoot } from "../chain/deployment.js";
import { validateModelAssignment } from "../pack/model-assignment.js";
import { instrumentOf } from "./instrument.js";

/**
 * Every deployment record the runner can be pointed at must give it everything it reads.
 *
 * The runner takes `--deployment <record>` and reads from it: the four contract addresses
 * (`loadGateMarketDeployment`), the instrument and topology (`instrumentOf`), each issuer's lot
 * figures (`capacityLots`) and the roster's model assignment (`roster.modelAssignment`). The sixth
 * trio's record was written with the first three and without the last, and the first launch died
 * at startup reading it — a field the record's author had checked one place and not another.
 * Asserted per record, for every record, so a seventh is held to the same list.
 */
const RECORDS = [
  "data/deployments/base-sepolia-gate-market.json",
  "data/deployments/base-sepolia-gate-market-single-issuer.json",
] as const;
const SEATS = ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "ISSUER-A", "ISSUER-B"] as const;
const registry = JSON.parse(readFileSync(join(repoRoot(), "data/registry/models.json"), "utf-8"));

describe.each(RECORDS)("deployment record %s", (file) => {
  const record = JSON.parse(readFileSync(join(repoRoot(), file), "utf-8"));

  it("gives the loader the four contract addresses", () => {
    const d = loadGateMarketDeployment(file);
    for (const key of ["usdc", "capacityBond", "claimRouter", "workClaim"] as const) {
      expect(d[key]?.address, key).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("gives the runner a model assignment for every seat, and that assignment validates", () => {
    const assignment = record.roster?.modelAssignment;
    expect(assignment, "roster.modelAssignment").toBeDefined();
    for (const seat of SEATS) expect(assignment[seat]?.reasoningModel, seat).toBeTypeOf("string");
    expect(() => validateModelAssignment(assignment, registry)).not.toThrow();
  });

  it("names an address for every seat", () => {
    for (const seat of SEATS) expect(record.roster?.addresses?.[seat], seat).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("states each issuer's lot figures, and the limit the pool check expects follows from them", () => {
    for (const issuer of ["ISSUER-A", "ISSUER-B"] as const) {
      const lot = record.capacityLots?.[issuer];
      expect(lot, issuer).toBeDefined();
      for (const field of ["measuredRateMilliSiuPerHour", "committedCapacityHours", "bondedUsdcPerClass", "issuanceLimitPerClass"]) {
        expect(typeof lot[field], `${issuer}.${field}`).toBe("number");
      }
      // hours x rate x 0.5, the contract's own issuance ratio
      expect(lot.issuanceLimitPerClass).toBe((lot.committedCapacityHours * lot.measuredRateMilliSiuPerHour) / 2);
    }
  });

  it("is a valid instrument", () => {
    expect(() => instrumentOf(record)).not.toThrow();
  });
});

describe("the single-issuer record reuses the fifth trio's roster rather than restating it", () => {
  it("has the same model assignment and the same seat addresses as the fifth", () => {
    const fifth = JSON.parse(readFileSync(join(repoRoot(), RECORDS[0]), "utf-8"));
    const sixth = JSON.parse(readFileSync(join(repoRoot(), RECORDS[1]), "utf-8"));
    expect(sixth.roster.modelAssignment).toEqual(fifth.roster.modelAssignment);
    expect(sixth.roster.addresses).toEqual(fifth.roster.addresses);
  });
});
