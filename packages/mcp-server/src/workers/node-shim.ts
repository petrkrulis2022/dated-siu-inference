import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from "express";

/**
 * A minimal Node `http.IncomingMessage`/`ServerResponse`-shaped pair — just enough to run
 * `../paywall.ts`'s already-tested `createDispatcher`/`createToolPaywall` (built on Circle's
 * `gateway.require(price)`, itself Express middleware) against a Workers `Request`, without
 * pulling in Express or a full Node-compat HTTP server. Confirmed by reading
 * `@circle-fin/x402-batching`'s compiled output directly rather than guessing: the paid-path
 * logic touches only `req.headers`/`req.url`/`req.method`/`req.body` and
 * `res.statusCode`/`res.setHeader`/`res.end` — the plain `http` API, not any Express convenience
 * method — so that's all this shim implements. Every other line of paywall.ts, and the whole
 * payment protocol (verify/settle against Circle's real Gateway), is unchanged, untouched,
 * exactly the code path server.ts's Express deployment already runs and already tests.
 */
export interface ShimResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function createNodeShim(
  request: Request,
  parsedBody: unknown,
): {
  req: ExpressRequest;
  res: ExpressResponse;
  next: NextFunction;
  /** Resolves once the middleware reaches a terminal state — either `res.end()` (a 402 or other
   * terminal response) or `next()` (payment cleared, or the tool is free). `../paywall.ts`'s
   * `dispatchPaywall` calls the real Circle Gateway middleware as `void middleware(req, res,
   * next)` — fire-and-forget, since Express itself doesn't need the promise, it just waits for
   * `res` to actually complete. Awaiting `paywall(req, res, next)`'s own return value resolves
   * immediately, before the async verify/settle call against Circle's Gateway has done anything
   * — found live, not guessed: the first real deploy returned an empty 402 with no
   * PAYMENT-REQUIRED header because of exactly this. This promise is what the caller must await
   * instead. */
  settled: Promise<void>;
  /** Non-null once the middleware called `res.end()` (a 402 or other terminal response) rather
   * than `next()` — the caller should return this directly and never reach the MCP layer. */
  getResult: () => ShimResult | null;
  /** True once `next()` was called — the caller should proceed, carrying the settlement
   * response header (e.g. PAYMENT-RESPONSE on a cleared payment) onto whatever response it
   * ultimately returns. */
  nextCalled: () => boolean;
  responseHeaders: () => Record<string, string>;
} {
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    requestHeaders[key.toLowerCase()] = value;
  });

  const url = new URL(request.url);
  const req = {
    url: `${url.pathname}${url.search}`,
    method: request.method,
    headers: requestHeaders,
    body: parsedBody,
  } as unknown as ExpressRequest;

  let statusCode = 200;
  const headersOut: Record<string, string> = {};
  let ended = false;
  let endBody = "";
  let nextWasCalled = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader(name: string, value: string) {
      headersOut[name] = String(value);
      return res;
    },
    getHeader(name: string) {
      return headersOut[name];
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        endBody = chunk;
      }
      ended = true;
      resolveSettled();
    },
  } as unknown as ExpressResponse;

  const next: NextFunction = () => {
    nextWasCalled = true;
    resolveSettled();
  };

  return {
    req,
    res,
    next,
    settled,
    getResult: () => (ended ? { status: statusCode, headers: headersOut, body: endBody } : null),
    nextCalled: () => nextWasCalled,
    responseHeaders: () => headersOut,
  };
}
