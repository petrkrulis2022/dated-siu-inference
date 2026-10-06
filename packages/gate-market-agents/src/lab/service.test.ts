import { beforeEach, describe, expect, it } from "vitest";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, ISSUER_SEAT, LAB_TRADERS, SEAT_OF, buildEconomy, type Economy, type TraderLabel } from "./economy.js";
import { LabService, type LabServiceDeps } from "./service.js";
import type { WorkExecutor } from "./jobs.js";
import type { AgentId } from "../identity/resolve.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};
const pass: WorkExecutor = async () => ({ passed: true, usage: { input: 1, output: 1 }, costUsd: "0.002" });
const fail: WorkExecutor = async () => ({ passed: false, reason: "the output did not match the record", usage: { input: 1, output: 1 }, costUsd: "0.003" });

describe("LabService", () => {
  let economy: Economy;
  let books: LabBooks;
  let rebates: { seller: AgentId; minor: bigint }[];
  let costs: string[];
  let rounds: number[];
  let executor: WorkExecutor;
  let svc: LabService;

  const build = (): LabService => {
    const deps: LabServiceDeps = {
      books,
      guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS },
      seed: 4,
      executorFor: () => executor,
      rebate: async (seller, minor) => {
        rebates.push({ seller, minor });
        return { txHash: "0xrebate" };
      },
      escrowFeeBps: 50,
      recordWorkCost: (usd) => costs.push(usd),
      onRoundOpened: async (r) => void rounds.push(r),
    };
    return new LabService(deps);
  };

  beforeEach(() => {
    economy = buildEconomy(4);
    books = new LabBooks(economy, ids);
    rebates = [];
    costs = [];
    rounds = [];
    executor = pass;
    svc = build();
  });

  const need1 = () => economy.needs.find((n) => n.round === 1)!;
  const seat = (t: TraderLabel): AgentId => SEAT_OF[t];
  const ev = (agentId: AgentId, tool: string, extra: Record<string, unknown> = {}) =>
    ({ agentId, turn: 1, tool, intentArgs: {}, builtArgs: {}, result: {}, ...extra }) as never;

  /** Takes a need all the way to paid, as the loop would report it. */
  async function payNeed(requestId: string, asset: "pay" | "pay_with_claim" | "transfer_claim" = "pay_with_claim") {
    const n = need1();
    await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId, result: { seller_id: ids.traders[n.seller] } }));
    await svc.afterToolCall(ev(seat(n.seller), "issue_quote", { intentArgs: { requestId } }));
    await svc.afterToolCall(ev(seat(n.buyer), asset, { intentArgs: { requestId } }));
    return n;
  }
  async function buyUnit(trader: TraderLabel, requestId: string, tool = "pay") {
    await svc.afterToolCall(ev(seat(trader), "request_quote", { requestId, result: { seller_id: ids.issuer } }));
    await svc.afterToolCall(ev(ISSUER_SEAT, "issue_quote", { intentArgs: { requestId } }));
    await svc.afterToolCall(ev(seat(trader), tool, { intentArgs: { requestId } }));
  }

  describe("following the loop's calls", () => {
    it("turns a request, an answer and a payment into a paid job, whichever asset paid", async () => {
      for (const tool of ["pay", "pay_with_claim", "transfer_claim", "settle_split"]) {
        books = new LabBooks(economy, ids);
        svc = build();
        const n = await payNeed("qr-1", tool as never);
        expect(books.sale("qr-1")).toMatchObject({ paid: true, buyer: n.buyer, seller: n.seller });
      }
    });

    it("records the asset that paid", async () => {
      await payNeed("qr-1", "pay");
      expect(books.sale("qr-1")?.paidAsset).toBe("usdc");
    });

    it("does not count a transfer that names no quote as a payment", async () => {
      const n = need1();
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-1", result: { seller_id: ids.traders[n.seller] } }));
      await svc.afterToolCall(ev(seat(n.buyer), "transfer_claim", { intentArgs: { agentId: "WORKER-CODE", tokenId: "1", quantity: "1" } }));
      expect(books.sale("qr-1")?.paid).toBe(false);
    });

    it("credits a unit of raw work when the issuer's quote is paid", async () => {
      await buyUnit("TRADER-1", "qr-7");
      expect(books.unitsOf("TRADER-1")).toBe(1);
    });

    it("ignores the issuer's own calls except to follow its quotes, and ignores unknown seats", async () => {
      await svc.afterToolCall(ev("HEDGER", "pay", { intentArgs: { requestId: "qr-1" } }));
      await svc.afterToolCall(ev(ISSUER_SEAT, "request_quote", { requestId: "qr-2", result: { seller_id: ids.issuer } }));
      expect(books.sale("qr-1")).toBeUndefined();
      expect(books.sale("qr-2")).toBeUndefined();
    });
  });

  describe("the fee rebate", () => {
    it("gives the seller back exactly the fee the escrow took, and logs it", async () => {
      await svc.afterToolCall(ev("WORKER-CODE", "settle_escrow", { settledRequestId: "qr-4", result: { settledMinorUnits: "1725" } }));
      expect(rebates).toEqual([{ seller: "WORKER-CODE", minor: 8n }]);
      expect(svc.operatorActions).toEqual([
        { kind: "fee_rebate", seller: "WORKER-CODE", requestId: "qr-4", settledMinorUnits: "1725", rebatedMinorUnits: "8", txHash: "0xrebate" },
      ]);
    });

    it("rebates the issuer too, so neither side of a dollar payment carries a fee", async () => {
      await svc.afterToolCall(ev(ISSUER_SEAT, "settle_escrow", { settledRequestId: "qr-5", result: { settledMinorUnits: "1437" } }));
      expect(rebates).toEqual([{ seller: "ISSUER-B", minor: 7n }]);
    });

    it("rebates nothing when nothing was settled", async () => {
      await svc.afterToolCall(ev("WORKER-CODE", "settle_escrow", { settledRequestId: "qr-4", result: { settledMinorUnits: "0" } }));
      expect(rebates).toEqual([]);
    });

    it("lets a failed rebate surface to the loop, which records it as the harness's", async () => {
      svc = new LabService({
        books,
        guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS },
        seed: 4,
        executorFor: () => executor,
        escrowFeeBps: 50,
        rebate: async () => {
          throw new Error("operator out of funds");
        },
      });
      await expect(svc.afterToolCall(ev("WORKER-CODE", "settle_escrow", { settledRequestId: "qr-4", result: { settledMinorUnits: "1725" } }))).rejects.toThrow("operator out of funds");
    });
  });

  describe("deliver_job", () => {
    it("delivers a paid job with a unit of raw work, meets the need and spends the unit", async () => {
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const result = (await svc.deliverJob(seat(n.seller), "qr-1")) as Record<string, unknown>;
      expect(result).toEqual({ delivered: true, requestId: "qr-1", buyer: n.buyer, unitsLeft: 0 });
      expect(books.needsMet(n.buyer)).toBe(1);
      expect(costs).toEqual(["0.002"]);
      expect(svc.workLog).toHaveLength(1);
    });

    it("keeps the unit and allows a retry when the extraction fails, up to three attempts", async () => {
      executor = fail;
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const first = (await svc.deliverJob(seat(n.seller), "qr-1")) as Record<string, unknown>;
      expect(first).toMatchObject({ delivered: false, attemptsLeft: 2 });
      expect(books.unitsOf(n.seller)).toBe(1);
      expect(books.needsMet(n.buyer)).toBe(0);
      await svc.deliverJob(seat(n.seller), "qr-1");
      await svc.deliverJob(seat(n.seller), "qr-1");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has had its 3 attempts");
      executor = pass;
    });

    it("costs what the work cost, pass or fail", async () => {
      executor = fail;
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      await svc.deliverJob(seat(n.seller), "qr-1");
      expect(costs).toEqual(["0.003"]);
    });

    it("refuses, in plain sentences, everything it should", async () => {
      const n = need1();
      const other = LAB_TRADERS.find((t) => t !== n.seller && t !== n.buyer)!;
      await expect(svc.deliverJob("ISSUER-B", "qr-1")).rejects.toThrow("only a trader delivers jobs");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("there is no request qr-1");
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-1", result: { seller_id: ids.traders[n.seller] } }));
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has not been paid yet");
      await svc.afterToolCall(ev(seat(n.buyer), "pay", { intentArgs: { requestId: "qr-1" } }));
      await expect(svc.deliverJob(seat(other), "qr-1")).rejects.toThrow("is not a job you sold");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("you hold no unit of raw work");
      await buyUnit(n.seller, "qr-2");
      await expect(svc.deliverJob(seat(n.seller), "qr-2")).rejects.toThrow("is not a job; it is a unit of raw work");
      await svc.deliverJob(seat(n.seller), "qr-1");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has already been delivered");
    });

    it("never puts the expected answer in what it returns", async () => {
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const out = JSON.stringify(await svc.deliverJob(seat(n.seller), "qr-1"));
      expect(out).not.toMatch(/tracking_id|origin_city|expected/);
    });
  });

  describe("rounds", () => {
    it("opens the next round and tells the runner, until there is none", async () => {
      expect(await svc.advanceRound()).toBe(true);
      expect(await svc.advanceRound()).toBe(true);
      expect(await svc.advanceRound()).toBe(false);
      expect(rounds).toEqual([2, 3]);
      expect(svc.operatorActions.filter((a) => a.kind === "round_opened")).toHaveLength(2);
    });
  });

  describe("the hooks the loop calls", () => {
    it("shows a trader the board and the issuer nothing, and refuses by the guard", () => {
      expect(svc.infoTextFor("ORCHESTRATOR")).toContain("THE LAB");
      expect(svc.infoTextFor(ISSUER_SEAT)).toBe("");
      expect(svc.actionTextFor(ISSUER_SEAT)).toBe("");
      expect(svc.guard("ORCHESTRATOR", "request_quote", { siu: "1" })).toBe("request_quote needs a sellerId.");
      expect(svc.guard("HEDGER", "request_quote", { siu: "1" })).toBeNull();
    });
  });
});
