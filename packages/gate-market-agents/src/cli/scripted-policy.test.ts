import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import { QuoteBoard } from "../loop/quote-board.js";
import { RedemptionTracker } from "../loop/redemption-tracker.js";
import { renderSettleableText } from "../loop/full-run.js";
import { claimFactsFor } from "./p5-shared.js";
import {
  EXPECTED_STEPS,
  SCRIPTED_SEATS,
  claimTransferred,
  openRequests,
  owedInUsdc,
  pendingRedemption,
  presentedAgainstMe,
  receivedQuotes,
  scriptedSeats,
  taskSpecHashIn,
  unsettledClaims,
  windowOf,
  type ScriptEnv,
  type ScriptedSeat,
} from "./scripted-policy.js";

const CODE_ID = "erc8004:0xCODE";
const EXTRACT_ID = "erc8004:0xEXTRACT";
const HASH = "0x" + "ab".repeat(32);

function body(seller: string, siu = "10"): QuoteBody {
  return {
    schema_version: "2.0",
    siu,
    pattern: "fixed",
    model: "m",
    rate_usd_per_siu: "0.001437",
    amount_usd_max: "0.0144",
    index_version: "SIU-2026a",
    print_id: "p",
    print_hash: "0x00",
    seller_id: seller,
    expiry: "2026-10-05T14:37:27.488Z",
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "14400" }],
  } as QuoteBody;
}
const signed = (seller: string): TouchstoneQuote => ({ ...body(seller), sig: "0xsig" }) as TouchstoneQuote;

const ENV: ScriptEnv = {
  sellerIds: { "WORKER-CODE": CODE_ID, "WORKER-EXTRACT": EXTRACT_ID },
  print: { printId: "2026-10-05-commodity", printHash: "0x00", rateUsdPerSiu: "0.001437", indexVersion: "SIU-2026a" },
  chain: "base-sepolia",
  sizes: { gate: "10", testing: "4" },
  quoteExpirySeconds: 180,
  pinnedGateSource: "export async function gate(){ return { accept: true, reason: 'pinned' }; }",
  attackSource: "export function dedupeSorted(a){ return a; }",
};

const win = (n: number): string => `THIS RUN HAS 3 WINDOWS. THIS IS WINDOW ${n}.\n`;
/** A prompt as the loop assembles one: a brief carrying the window marker, then each notice. */
const prompt = (window: number, ...sections: string[]): string =>
  [win(window), claimFactsFor(HASH), ...sections].join("\n\n");

describe("the cue parsers read the loop's own renderers, never a copy of their text", () => {
  it("reads the window a prompt belongs to", () => {
    expect(windowOf(win(2))).toBe(2);
    expect(windowOf("no marker here")).toBeUndefined();
  });

  it("reads a task-spec hash out of the claim facts a holder is given", () => {
    expect(taskSpecHashIn(claimFactsFor(HASH))).toBe(HASH);
  });

  it("keeps the board's back-to-back sections apart: quotes RECEIVED are not work OWED", () => {
    // WORKER-CODE is at once a seller that has been paid (qr-1), a buyer holding an unpaid quote
    // (qr-2) and a seller with an open request (qr-3). The board renders those three sections one
    // after another with no blank line between them.
    const board = new QuoteBoard();
    const r1 = board.postRequest("ORCHESTRATOR", body(CODE_ID));
    board.postIssuedQuote(r1.requestId, signed(CODE_ID));
    board.recordPaid(r1.requestId, "usdc");
    const r2 = board.postRequest("WORKER-CODE", body(EXTRACT_ID, "4"));
    board.postIssuedQuote(r2.requestId, signed(EXTRACT_ID));
    board.postRequest("ORCHESTRATOR", body(CODE_ID));
    const text = board.renderFor("WORKER-CODE", CODE_ID);

    expect(text).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
    expect(owedInUsdc(text)).toEqual(["qr-1"]);
    expect(receivedQuotes(text)).toEqual([{ requestId: "qr-2", seller: EXTRACT_ID }]);
    expect(openRequests(text)).toEqual([{ requestId: "qr-3", from: "ORCHESTRATOR", siu: "10" }]);
  });

  it("reads a transferred claim, and the quote it settles when it settles one", () => {
    const t = new RedemptionTracker();
    t.recordMint("777", "ISSUER-B", "10000");
    t.recordTransfer("WORKER-CODE", undefined, "qr-1");
    expect(claimTransferred(t.renderForHolder("WORKER-CODE", 0))).toEqual({
      tokenId: "777",
      quantity: "10000",
      settles: "qr-1",
    });
    expect(claimTransferred(t.renderForHolder("WORKER-EXTRACT", 0))).toBeUndefined();
  });

  it("reads what an issuer owes, and the exact values it is then to serve with", () => {
    const t = new RedemptionTracker();
    t.recordMint("777", "ISSUER-B", "10000");
    t.recordTransfer("WORKER-CODE");
    t.recordPresented("WORKER-CODE", "the task");
    expect(presentedAgainstMe(t.renderForIssuerAwaitingDelivery("ISSUER-B"))).toEqual({
      tokenId: "777",
      holder: "WORKER-CODE",
      quantity: "10000",
    });
    t.recordGraded(true, "0x" + "cd".repeat(32));
    expect(pendingRedemption(t.renderFor("ISSUER-B"))).toEqual({
      tokenId: "777",
      holder: "WORKER-CODE",
      quantity: "10000",
      passed: true,
      receiptRef: "0x" + "cd".repeat(32),
    });
    expect(presentedAgainstMe(t.renderFor("ISSUER-A"))).toBeUndefined();
  });

  it("reads what an earlier window left unsettled, and whether each claim was ever presented", () => {
    const text = renderSettleableText(
      [
        { tokenId: "11", holder: "0xa", holderAgentId: "WORKER-EXTRACT", issuerAgentId: "ISSUER-B", quantityMilliSiu: "2778", mintedInWindow: 1, everPresented: false },
        { tokenId: "22", holder: "0xb", holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-A", quantityMilliSiu: "10000", mintedInWindow: 2, everPresented: true },
        { tokenId: "33", holder: "0xc", mintedInWindow: 2 },
      ],
      true,
    );
    expect(unsettledClaims(text)).toEqual([
      { tokenId: "11", mintedInWindow: 1, issuer: "ISSUER-B", heldBy: "WORKER-EXTRACT", presented: false },
      { tokenId: "22", mintedInWindow: 2, issuer: "ISSUER-A", heldBy: "WORKER-CODE", presented: true },
      { tokenId: "33", mintedInWindow: 2, issuer: undefined, heldBy: undefined, presented: undefined },
    ]);
  });
});

/** Drives one seat through a sequence of prompts and returns what it decided each time. */
async function decide(seat: ScriptedSeat, seats: ReturnType<typeof scriptedSeats>, p: string): Promise<Record<string, unknown>> {
  const r = await seats.adapters[seat]("scripted", p, { temperature: 0, max_tokens: 1 });
  expect(r.usage).toEqual({ input: 0, output: 0, cached_input: 0, reasoning: 0 });
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe("the seats' scripts", () => {
  it("ORCHESTRATOR requests the job at the run's own size, pays in claims in windows 1 and 2 and in dollars in 3", async () => {
    for (const [w, expected] of [[1, "pay_with_claim"], [2, "pay_with_claim"], [3, "pay"]] as const) {
      const seats = scriptedSeats(ENV);
      const first = (await decide("ORCHESTRATOR", seats, prompt(w))) as { tool: string; args: Record<string, unknown> };
      expect(first.tool).toBe("request_quote");
      expect(first.args).toMatchObject({ siu: "10", sellerId: CODE_ID, expiresInSeconds: 180, pattern: "fixed" });
      // Nothing to pay yet: it waits, and does not leave while it still owes itself a payment.
      expect(await decide("ORCHESTRATOR", seats, prompt(w))).toEqual({ wait: true });
      const board = new QuoteBoard();
      const r = board.postRequest("ORCHESTRATOR", body(CODE_ID));
      board.postIssuedQuote(r.requestId, signed(CODE_ID));
      const pay = (await decide("ORCHESTRATOR", seats, prompt(w, board.renderFor("ORCHESTRATOR", "erc8004:0xORCH")))) as { tool: string; args: Record<string, unknown> };
      expect(pay.tool).toBe(expected);
      expect(pay.args.requestId).toBe("qr-1");
      expect(await decide("ORCHESTRATOR", seats, prompt(w))).toMatchObject({ done: true });
    }
  });

  it("WORKER-CODE, window 1: pays for testing out of the held claim IN PART, then redeems the remainder", async () => {
    const seats = scriptedSeats(ENV);
    const board = new QuoteBoard();
    const gate = board.postRequest("ORCHESTRATOR", body(CODE_ID));
    expect(await decide("WORKER-CODE", seats, prompt(1))).toEqual({ wait: true });
    expect(await decide("WORKER-CODE", seats, prompt(1, board.renderFor("WORKER-CODE", CODE_ID)))).toEqual({
      tool: "issue_quote",
      args: { requestId: gate.requestId },
    });
    board.postIssuedQuote(gate.requestId, signed(CODE_ID));
    board.recordPaid(gate.requestId, "fsiu");

    const tracker = new RedemptionTracker();
    tracker.recordMint("777", "ISSUER-B", "10000");
    tracker.recordTransfer("WORKER-CODE", undefined, gate.requestId);
    const holding = tracker.renderForHolder("WORKER-CODE", 0);
    expect(await decide("WORKER-CODE", seats, prompt(1, holding))).toMatchObject({
      tool: "request_quote",
      args: { siu: "4", sellerId: EXTRACT_ID },
    });

    const testing = board.postRequest("WORKER-CODE", body(EXTRACT_ID, "4"));
    board.postIssuedQuote(testing.requestId, signed(EXTRACT_ID));
    // The notice is gone by now — a later holder has the slot — so the script must remember the id.
    const onward = (await decide("WORKER-CODE", seats, prompt(1, board.renderFor("WORKER-CODE", CODE_ID)))) as { tool: string; args: Record<string, unknown> };
    expect(onward.tool).toBe("transfer_claim");
    expect(onward.args).toEqual({ agentId: "WORKER-EXTRACT", tokenId: "777", requestId: testing.requestId });
    expect("quantity" in onward.args, "a keyed transfer is sized from the quote, never by the holder").toBe(false);

    expect(await decide("WORKER-CODE", seats, prompt(1))).toEqual({
      tool: "redeem_claim",
      args: { tokenId: "777", taskSpecHash: HASH },
    });
    expect(await decide("WORKER-CODE", seats, prompt(1))).toMatchObject({ done: true });
  });

  it("ISSUER-B delivers with the pinned gate and then serves with exactly the values it is shown", async () => {
    const seats = scriptedSeats(ENV);
    const t = new RedemptionTracker();
    t.recordMint("777", "ISSUER-B", "10000");
    t.recordTransfer("WORKER-CODE");
    expect(await decide("ISSUER-B", seats, prompt(1))).toEqual({ wait: true });
    t.recordPresented("WORKER-CODE", "spec");
    expect(await decide("ISSUER-B", seats, prompt(1, t.renderForIssuerAwaitingDelivery("ISSUER-B")))).toEqual({
      tool: "submit_job",
      args: { source: ENV.pinnedGateSource },
    });
    t.recordGraded(true, "0x" + "cd".repeat(32));
    expect(await decide("ISSUER-B", seats, prompt(1, t.renderFor("ISSUER-B")))).toEqual({
      tool: "serve_redemption",
      args: { tokenId: "777", holder: "WORKER-CODE", quantity: "10000", passed: true, receiptRef: "0x" + "cd".repeat(32) },
    });
    // An issuer never leaves: it is owed a cue for as long as the window runs.
    expect(await decide("ISSUER-B", seats, prompt(1))).toEqual({ wait: true });
  });

  it("ISSUER-A never serves — it cannot, and the script does not pretend to", async () => {
    const seats = scriptedSeats(ENV);
    const t = new RedemptionTracker();
    t.recordMint("888", "ISSUER-A", "10000");
    t.recordTransfer("WORKER-CODE");
    t.recordPresented("WORKER-CODE", "spec");
    expect(await decide("ISSUER-A", seats, prompt(2, t.renderForIssuerAwaitingDelivery("ISSUER-A")))).toEqual({ wait: true });
  });

  it("settles only the claims its own seat holds, each once, and only the kind the walk expects", async () => {
    const seats = scriptedSeats(ENV);
    const text = renderSettleableText(
      [
        { tokenId: "11", holder: "0xa", holderAgentId: "WORKER-EXTRACT", issuerAgentId: "ISSUER-B", mintedInWindow: 1, everPresented: false },
        { tokenId: "22", holder: "0xb", holderAgentId: "WORKER-CODE", issuerAgentId: "ISSUER-A", mintedInWindow: 1, everPresented: true },
      ],
      true,
    );
    // WORKER-EXTRACT, window 2: its own never-presented claim — not WORKER-CODE's presented one.
    expect(await decide("WORKER-EXTRACT", seats, prompt(2, text))).toEqual({
      tool: "settle_window_close",
      // Its own seat is named, so the call is unambiguous when a token has more than one holder.
      args: { tokenId: "11", holder: "WORKER-EXTRACT" },
    });
    expect(await decide("WORKER-EXTRACT", seats, prompt(2, text))).toEqual({ wait: true });
  });

  it("WORKER-CODE settles the Default FIRST in window 3, so it still has turns in which to be shown the outcome", async () => {
    // A settlement is only checked for what its settler was told if the settler takes another turn.
    // Run 6 on the fork ended the window straight after WORKER-CODE's last step, which was this
    // settlement, so its prompt never carried the outcome. Anything left to do afterwards guarantees
    // a later turn, so the settlement is not left for last.
    const seats = scriptedSeats(ENV);
    const text = renderSettleableText(
      [{ tokenId: "22", holder: "0xb", holderAgentId: "WORKER-CODE" as const, issuerAgentId: "ISSUER-A" as const, mintedInWindow: 2, everPresented: true }],
      true,
    );
    expect(await decide("WORKER-CODE", seats, prompt(3, text))).toEqual({
      tool: "settle_window_close",
      args: { tokenId: "22", holder: "WORKER-CODE" },
    });
  });

  it("refuses a prompt it cannot place in a window, loudly, rather than guessing", async () => {
    const seats = scriptedSeats(ENV);
    await expect(decide("ORCHESTRATOR", seats, "a prompt with no window marker")).rejects.toThrow(/THIS IS WINDOW/);
  });

  it("reports every expected step and which of them were never issued", async () => {
    const seats = scriptedSeats(ENV);
    const before = seats.status();
    expect(before.length).toBe(
      SCRIPTED_SEATS.reduce((n, s) => n + Object.values(EXPECTED_STEPS[s]).reduce((m, ids) => m + ids.length, 0), 0),
    );
    expect(before.every((s) => !s.performed)).toBe(true);
    await decide("ORCHESTRATOR", seats, prompt(1));
    const done = seats.status().filter((s) => s.performed);
    expect(done).toEqual([{ seat: "ORCHESTRATOR", window: 1, step: "request_gate", performed: true }]);
  });
});

describe("nothing a scripted seat does can reach what any agent reads", () => {
  it("is imported by the flag path and its own verifier only — never by anything that builds a prompt", () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && /from\s+["'][^"']*scripted-policy(\.js)?["']/.test(readFileSync(full, "utf-8"))) {
          importers.push(path.relative(srcDir, full));
        }
      }
    };
    walk(srcDir);
    expect(importers.sort()).toEqual([
      "cli/p5-three-window-full-run.test.ts",
      "cli/p5-three-window-full-run.ts",
      "cli/scripted-policy.test.ts",
      "cli/scripted-verify.test.ts",
      "cli/scripted-verify.ts",
    ]);
  });

  it("states no instruction to hold, spend or redeem either asset anywhere it could be shown", () => {
    // The scripts never produce prompt text — they return tool calls. This pins that the module
    // contains no template literal addressed to an agent: every string it emits is a tool name, an
    // argument, or `wait`/`done`.
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "scripted-policy.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/skillPackText|buildTurnPrompt|renderFor\(/);
  });
});
