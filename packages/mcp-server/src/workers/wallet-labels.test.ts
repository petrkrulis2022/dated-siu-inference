import { describe, expect, it } from "vitest";
import {
  WALLET_LABELS,
  WALLET_LABELS_SCHEMA,
  labelForPayer,
  trafficSummary,
  walletLabelsSyncSql,
  type LabelledWallet,
} from "./wallet-labels.js";

const TREASURY = "0xB514882859f43DbF3df664C899D707f649E0CF4A";
const TEST_BUYER = "0x22e2F3427FfBf5d453649824C7bfCB6c8F12d743";
const OUTSIDE = "0x1111111111111111111111111111111111111111";
const FOUNDRY_DEFAULT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("WALLET_LABELS", () => {
  it("lists each Touchstone-controlled wallet once, as a valid address with a reason", () => {
    const seen = new Set<string>();
    for (const w of WALLET_LABELS) {
      expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(["internal", "campaign"]).toContain(w.label);
      expect(w.note.length).toBeGreaterThan(3);
      expect(w.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(seen.has(w.address.toLowerCase())).toBe(false);
      seen.add(w.address.toLowerCase());
    }
    expect(seen.has(TEST_BUYER.toLowerCase())).toBe(true);
    expect(seen.has(TREASURY.toLowerCase())).toBe(true);
  });

  it("leaves out Foundry's public test account: anyone holds its key, so it is not Touchstone's", () => {
    expect(labelForPayer(FOUNDRY_DEFAULT)).toBe("organic");
  });
});

describe("labelForPayer", () => {
  it("labels by the paying wallet, in any letter case", () => {
    expect(labelForPayer(TEST_BUYER)).toBe("internal");
    expect(labelForPayer(TEST_BUYER.toLowerCase())).toBe("internal");
    expect(labelForPayer(OUTSIDE)).toBe("organic");
  });

  it("knows campaign wallets apart from internal ones", () => {
    const labels: LabelledWallet[] = [
      ...WALLET_LABELS,
      {
        address: OUTSIDE,
        label: "campaign",
        note: "allowance-funded test agent",
        since: "2026-12-01",
      },
    ];
    expect(labelForPayer(OUTSIDE, labels)).toBe("campaign");
  });
});

describe("trafficSummary", () => {
  it("counts a payment from an outside wallet to the treasury as organic, although the treasury is internal", () => {
    // Internal means the PAYER. The treasury receives every payment; excluding on it would
    // exclude all revenue. A row carries only the payer, and that is all that is consulted.
    const s = trafficSummary([{ payer: OUTSIDE, network: "eip155:8453", amount: "1000" }]);
    expect(s.organic).toEqual({ payments: 1, amountByNetwork: { "eip155:8453": "1000" } });
    expect(s.internal.payments).toBe(0);
  });

  it("reports internal and campaign payments separately from organic ones, never dropping them", () => {
    const labels: LabelledWallet[] = [
      ...WALLET_LABELS,
      { address: OUTSIDE, label: "campaign", note: "bounty-funded agent", since: "2026-12-01" },
    ];
    const other = "0x2222222222222222222222222222222222222222";
    const s = trafficSummary(
      [
        { payer: TEST_BUYER.toLowerCase(), network: "eip155:8453", amount: "1000" },
        { payer: TEST_BUYER, network: "eip155:5042", amount: "1000" },
        { payer: OUTSIDE, network: "eip155:8453", amount: "1000" },
        { payer: other, network: "eip155:8453", amount: "1000" },
        { payer: other, network: "eip155:8453", amount: "10000" },
      ],
      labels,
    );
    expect(s.internal).toEqual({
      payments: 2,
      amountByNetwork: { "eip155:8453": "1000", "eip155:5042": "1000" },
    });
    expect(s.campaign).toEqual({ payments: 1, amountByNetwork: { "eip155:8453": "1000" } });
    expect(s.organic).toEqual({ payments: 2, amountByNetwork: { "eip155:8453": "11000" } });
  });
});

describe("the D1 side", () => {
  it("classifies in SQL by the payer alone, lowercased, defaulting to organic", () => {
    expect(WALLET_LABELS_SCHEMA).toMatch(/lower\(s\.payer\)/);
    expect(WALLET_LABELS_SCHEMA).toMatch(/'organic'/);
    expect(WALLET_LABELS_SCHEMA).not.toMatch(/pay_?to|payee|treasury/i);
  });

  it("syncs the list into D1 with lowercased addresses, quoting safely", () => {
    const sql = walletLabelsSyncSql([
      {
        address: TEST_BUYER,
        label: "internal",
        note: "test buyer's 'own' wallet",
        since: "2026-11-26",
      },
    ]);
    expect(sql).toContain(`'${TEST_BUYER.toLowerCase()}'`);
    expect(sql).toContain("'test buyer''s ''own'' wallet'");
    expect(sql).toMatch(/^DELETE FROM wallet_labels;/);
  });
});
