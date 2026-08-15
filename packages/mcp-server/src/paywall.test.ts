import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createDispatcher, extractToolCallName, TOOL_PRICES } from "./paywall.js";

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
