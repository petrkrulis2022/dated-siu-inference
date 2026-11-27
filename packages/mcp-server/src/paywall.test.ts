import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  createDispatcher,
  extractToolCallArguments,
  extractToolCallName,
  TOOL_PRICES,
} from "./paywall.js";
import { toolArgumentsAreValid } from "./tools/schemas.js";
import { buildQuoteBody, signQuote } from "@touchstone/sdk";

/** A real signed touchstone-quote, built the same way verify-receipt.test.ts builds its fixture. */
const VALID_QUOTE = signQuote(
  buildQuoteBody({
    siu: "0.0676",
    pattern: "fixed",
    model: "anthropic-sonnet-5",
    rateUsdPerSiu: "1.0000",
    indexVersion: "SIU-2026a",
    printId: "2026-08-14",
    printHash: `0x${"cc".repeat(32)}`,
    sellerId: "erc8004:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    chain: "base-sepolia",
    expiresInSeconds: 3600,
  }),
  `0x${"33".repeat(32)}`,
);

function fakeReqRes(body: unknown) {
  const req = { body } as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe("extractToolCallName", () => {
  it("reads the tool name out of a tools/call request", () => {
    expect(extractToolCallName({ method: "tools/call", params: { name: "get_quote" } })).toBe(
      "get_quote",
    );
  });

  it("returns undefined for a non-tools/call method", () => {
    expect(extractToolCallName({ method: "initialize", params: {} })).toBeUndefined();
  });

  it("returns undefined for a malformed body", () => {
    expect(extractToolCallName(null)).toBeUndefined();
    expect(extractToolCallName("not an object")).toBeUndefined();
    expect(extractToolCallName({ method: "tools/call" })).toBeUndefined();
    expect(extractToolCallName({ method: "tools/call", params: { name: 42 } })).toBeUndefined();
  });
});

describe("toolArgumentsAreValid (the same schemas the MCP layer validates with)", () => {
  it("accepts a well-formed call for each paid tool", () => {
    expect(toolArgumentsAreValid("get_quote", { task_class: "T1", model: "m" })).toBe(true);
    expect(
      toolArgumentsAreValid("convert", { model: "m", input_tokens: 1, output_tokens: 0 }),
    ).toBe(true);
    expect(
      toolArgumentsAreValid("verify_receipt", {
        chain: "base-sepolia",
        tx_hash: "0x1",
        quote: VALID_QUOTE,
      }),
    ).toBe(true);
  });

  it("rejects what the tool's own first checks would refuse: a malformed quote, an unsupported chain, an unknown task class", () => {
    // the call found live: quote {} passes the MCP schema (any object) but not the published quote schema
    expect(
      toolArgumentsAreValid("verify_receipt", { chain: "base-sepolia", tx_hash: "0x1", quote: {} }),
    ).toBe(false);
    expect(
      toolArgumentsAreValid("verify_receipt", {
        chain: "ethereum",
        tx_hash: "0x1",
        quote: VALID_QUOTE,
      }),
    ).toBe(false);
    expect(toolArgumentsAreValid("get_quote", { task_class: "T9", model: "m" })).toBe(false);
  });

  it("rejects missing fields, wrong types and a missing arguments object", () => {
    expect(toolArgumentsAreValid("verify_receipt", { chain: "c", tx_hash: "0x1" })).toBe(false);
    expect(
      toolArgumentsAreValid("convert", { model: "m", input_tokens: -1, output_tokens: 0 }),
    ).toBe(false);
    expect(
      toolArgumentsAreValid("convert", { model: "m", input_tokens: 1.5, output_tokens: 0 }),
    ).toBe(false);
    expect(toolArgumentsAreValid("get_quote", { task_class: "T1" })).toBe(false);
    expect(toolArgumentsAreValid("get_quote", undefined)).toBe(false);
  });

  it("leaves a tool it doesn't know to someone else", () => {
    expect(toolArgumentsAreValid("not_a_tool", undefined)).toBe(true);
  });

  it("extractToolCallArguments returns the arguments exactly as sent", () => {
    expect(extractToolCallArguments({ params: { arguments: { a: 1 } } })).toEqual({ a: 1 });
    expect(extractToolCallArguments({ params: {} })).toBeUndefined();
    expect(extractToolCallArguments(null)).toBeUndefined();
  });
});

describe("createDispatcher", () => {
  it("routes each paid tool to its own priced middleware", () => {
    const seenPrices: string[] = [];
    const requireFn = vi.fn((price: string) => {
      seenPrices.push(price);
      return vi.fn((_req, _res, next: NextFunction) => next());
    });
    const dispatch = createDispatcher(requireFn);

    expect([...seenPrices].sort()).toEqual([...Object.values(TOOL_PRICES)].sort());

    for (const tool of Object.keys(TOOL_PRICES)) {
      const { req, res, next } = fakeReqRes({ method: "tools/call", params: { name: tool } });
      dispatch(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it("bypasses the paywall entirely for get_index (never in TOOL_PRICES)", () => {
    const requireFn = vi.fn(() => vi.fn());
    const dispatch = createDispatcher(requireFn);
    const { req, res, next } = fakeReqRes({ method: "tools/call", params: { name: "get_index" } });
    dispatch(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("bypasses the paywall for non-tools/call messages (initialize, tools/list, ...)", () => {
    const requireFn = vi.fn(() => vi.fn());
    const dispatch = createDispatcher(requireFn);
    const { req, res, next } = fakeReqRes({ method: "initialize" });
    dispatch(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("actually invokes the paid tool's middleware rather than calling next() directly", () => {
    const paidMiddleware = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const dispatch = createDispatcher(() => paidMiddleware);
    const { req, res, next } = fakeReqRes({ method: "tools/call", params: { name: "get_quote" } });
    dispatch(req, res, next);
    expect(paidMiddleware).toHaveBeenCalledWith(req, res, next);
  });

  it("a paid call whose arguments fail its schema is never charged — it goes through unpaid for the MCP layer's own validation error", () => {
    const paidMiddleware = vi.fn();
    const dispatch = createDispatcher(() => paidMiddleware, TOOL_PRICES, toolArgumentsAreValid);
    // the exact call found live on Arc Testnet: verify_receipt without its required `quote`
    const { req, res, next } = fakeReqRes({
      method: "tools/call",
      params: { name: "verify_receipt", arguments: { chain: "base-sepolia", tx_hash: "0xabc" } },
    });
    dispatch(req, res, next);
    expect(paidMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("a paid call with valid arguments still goes through the paywall", () => {
    const paidMiddleware = vi.fn();
    const dispatch = createDispatcher(() => paidMiddleware, TOOL_PRICES, toolArgumentsAreValid);
    const { req, res, next } = fakeReqRes({
      method: "tools/call",
      params: {
        name: "verify_receipt",
        arguments: { chain: "base-sepolia", tx_hash: "0xabc", quote: VALID_QUOTE },
      },
    });
    dispatch(req, res, next);
    expect(paidMiddleware).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("a paid middleware that never calls next() (an unpaid 402) means next() is never reached", () => {
    const rejecting = vi.fn(); // never calls next
    const dispatch = createDispatcher(() => rejecting);
    const { req, res, next } = fakeReqRes({
      method: "tools/call",
      params: { name: "verify_receipt" },
    });
    dispatch(req, res, next);
    expect(rejecting).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
