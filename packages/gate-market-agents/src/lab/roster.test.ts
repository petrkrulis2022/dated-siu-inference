import { LAB_ASSET_DESCRIPTION } from "./asset-text.js";
import { describe, expect, it } from "vitest";
import type { Adapter } from "@touchstone/harness";
import { assembleContext } from "../context/assemble.js";
import { addressDirectory } from "../loop/full-run.js";
import { validateAgentContext } from "../pack/validate.js";
import { ISSUER_SEAT, LAB_TRADERS, SEAT_OF, buildEconomy } from "./economy.js";
import {
  LAB_ALIASES,
  LAB_MODELS,
  LAB_TRADER_TOOLS,
  buildLabRoster,
  labDisplayName,
  type LabRosterInput,
} from "./roster.js";

const seats = [...LAB_TRADERS.map((t) => SEAT_OF[t]), ISSUER_SEAT];
const addresses = Object.fromEntries(seats.map((s, i) => [s, `0x${String(i + 1).padStart(40, "a")}`]));
const keys = Object.fromEntries(seats.map((s) => [s, `key-${s}`]));
const noAdapter: Adapter = async () => {
  throw new Error("no model is called in this test");
};

const input = (over: Partial<LabRosterInput> = {}): LabRosterInput => ({
  economy: buildEconomy(9),
  print: { printId: "print-illustrative", rateUsdPerSiu: "0.001437" },
  opening: { fsiuMilliSiu: 4_516n, usdcMinor: 8_583n },
  claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-06", untilIso: "2026-10-07" },
  maxTurns: 40,
  chain: "base-sepolia",
  rpcUrl: "http://localhost:8545",
  adapters: Object.fromEntries(LAB_TRADERS.map((t) => [t, noAdapter])) as LabRosterInput["adapters"],
  prices: {
    "claude-haiku-4-5": { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" },
    "deepseek-v3.2": { priceInUsdPer1M: "0.28", priceOutUsdPer1M: "0.4" },
  },
  keys,
  addresses,
  providerOf: (m) => (m.startsWith("claude") ? "anthropic" : "openrouter"),
  ...over,
});

describe("the lab roster", () => {
  const roster = buildLabRoster(input());

  it("seats four traders in label order, then the issuer service", () => {
    expect(roster.map((r) => r.agentId)).toEqual([...LAB_TRADERS.map((t) => SEAT_OF[t]), ISSUER_SEAT]);
  });

  it("runs two traders on each of two families again: haiku on TRADER-1 and TRADER-3, deepseek-v3.2 on TRADER-2 and TRADER-4 (D42)", () => {
    const models = LAB_TRADERS.map((t) => LAB_MODELS[t]);
    expect(models).toEqual(["claude-haiku-4-5", "deepseek-v3.2", "claude-haiku-4-5", "deepseek-v3.2"]);
    expect(models.filter((m) => m === "claude-haiku-4-5")).toHaveLength(2);
    expect(models.filter((m) => m === "deepseek-v3.2")).toHaveLength(2);
    expect(roster.slice(0, 4).map((r) => r.modelString)).toEqual(models);
    expect(roster.slice(0, 4).map((r) => r.provider)).toEqual(["anthropic", "openrouter", "anthropic", "openrouter"]);
  });

  it("grants the traders the same seven tools, none of them capacity, redemption, minting or escrow tools", () => {
    for (const r of roster.slice(0, 4)) expect(r.availableTools).toEqual(LAB_TRADER_TOOLS);
    for (const absent of ["redeem_claim", "reserve_for_work", "mint_claim", "pay_with_claim", "settle_split", "settle_escrow", "check_headroom", "whoami", "submit_job", "submit_attack"]) {
      expect(LAB_TRADER_TOOLS).not.toContain(absent);
    }
    expect(LAB_TRADER_TOOLS).toHaveLength(7);
    expect(LAB_TRADER_TOOLS).not.toContain("get_print"); // it reads the published print, which is not the lab's (D41)
  });

  it("gives the issuer service only the one tool it uses, no model, and no cost", () => {
    const issuer = roster[4];
    expect(issuer.availableTools).toEqual(["issue_quote"]);
    expect(issuer.prices).toEqual({ priceInUsdPer1M: "0", priceOutUsdPer1M: "0" });
    expect(issuer.provider).toBe("lab-service");
  });

  it("passes every seat's text through the context validator, the service's too", () => {
    for (const r of roster) expect(() => validateAgentContext(assembleContext(r.agentId, r.skillPackText, []), LAB_ASSET_DESCRIPTION)).not.toThrow();
  });

  it("puts each trader's own label, address and skill in its brief, and addresses each counterparty by its seat's identity", () => {
    const e = buildEconomy(9);
    LAB_TRADERS.forEach((t, i) => {
      const r = roster[i];
      expect(r.skillPackText).toContain(`YOU ARE ${t}.`);
      expect(r.skillPackText).toContain(`YOUR ADDRESS: ${addresses[SEAT_OF[t]]}`);
      expect(r.skillPackText).toContain(`you deliver ${e.skillOf[t]} jobs`);
      expect(r.skillPackText).toContain(`sellerId "erc8004:${addresses[SEAT_OF[t]]}"`);
      expect(r.erc8004Id).toBe(`erc8004:${addresses[SEAT_OF[t]]}`);
    });
    expect(roster[0].skillPackText).toContain(`ISSUER-B: sellerId "erc8004:${addresses[ISSUER_SEAT]}"`);
  });

  it("wakes traders only when something has arrived for them, and sets deciding agents' temperature above zero", () => {
    for (const r of roster.slice(0, 4)) {
      expect(r.waitsFor).toBe("inbox");
      expect(r.temperature).toBe(0.7);
    }
    expect(roster[4].temperature).toBe(0);
  });

  it("says nothing different about a model: briefs are identical across the two families", () => {
    const shared = (text: string) => text.slice(text.indexOf("\n\nTHE LAB\n"));
    const [a, b] = [roster[0], roster[1]].map((r) => shared(r.skillPackText));
    expect(a).toBe(b);
  });

  it("refuses to build without a price, a key or an address — never a silent default", () => {
    expect(() => buildLabRoster(input({ prices: {} }))).toThrow(/no price for claude-haiku-4-5/);
    expect(() => buildLabRoster(input({ keys: { ...keys, "WORKER-CODE": undefined } }))).toThrow(/no key for WORKER-CODE/);
    expect(() => buildLabRoster(input({ addresses: { ...addresses, "ISSUER-B": undefined } }))).toThrow(/no address for ISSUER-B/);
  });
});

describe("the names an agent is shown", () => {
  it("has an alias for every trader label, standing for its seat, and resolves each to that seat's address through the loop's own directory", () => {
    const roster = buildLabRoster(input());
    const directory = addressDirectory(roster, LAB_ALIASES);
    for (const t of LAB_TRADERS) {
      expect(LAB_ALIASES[t]).toBe(SEAT_OF[t]);
      expect(directory[t as never]).toBe(addresses[SEAT_OF[t]]);
    }
    expect(directory["ISSUER-B"]).toBe(addresses["ISSUER-B"]); // the issuer is shown under its seat name
  });

  it("names a trader's seat by its label on the board, and anything else as it is", () => {
    expect(labDisplayName("ORCHESTRATOR")).toBe("TRADER-1");
    expect(labDisplayName("ISSUER-A")).toBe("TRADER-4");
    expect(labDisplayName("ISSUER-B")).toBe("ISSUER-B");
  });
});
