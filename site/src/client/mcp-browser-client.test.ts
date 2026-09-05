import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { fetchLatestPrint as FetchLatestPrint } from "./mcp-browser-client.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers });
}

function toolCallResult(text: string, isError = false) {
  return { jsonrpc: "2.0", id: 2, result: { isError, content: [{ type: "text", text }] } };
}

/** fetchLatestPrint memoizes in a module-level variable — fresh-import the module per test
 * (rather than reusing one import across the file) so one test's memoized result can never leak
 * into the next. */
async function freshFetchLatestPrint(): Promise<typeof FetchLatestPrint> {
  vi.resetModules();
  const mod = await import("./mcp-browser-client.js");
  return mod.fetchLatestPrint;
}

describe("fetchLatestPrint", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes a session, then calls get_index with it, and returns the parsed print", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { "mcp-session-id": "session-abc" }))
      .mockResolvedValueOnce(jsonResponse(toolCallResult(JSON.stringify({ dated_siu: "0.0073" }))));

    const print = await fetchLatestPrint();

    expect(print).toEqual({ dated_siu: "0.0073" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallHeaders = fetchMock.mock.calls[1]![1]?.headers as Record<string, string>;
    expect(secondCallHeaders["mcp-session-id"]).toBe("session-abc");
  });

  it("parses an SSE-framed tools/call response the same way", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    const sseBody = `event: message\ndata: ${JSON.stringify(toolCallResult(JSON.stringify({ dated_siu: "0.0073" })))}\n`;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { "mcp-session-id": "session-abc" }))
      .mockResolvedValueOnce(new Response(sseBody));

    const print = await fetchLatestPrint();
    expect(print).toEqual({ dated_siu: "0.0073" });
  });

  it("throws when initialize returns no session id", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchLatestPrint()).rejects.toThrow(/session id/);
  });

  it("throws when the tool call itself reports an error", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { "mcp-session-id": "session-abc" }))
      .mockResolvedValueOnce(jsonResponse(toolCallResult("boom", true)));
    await expect(fetchLatestPrint()).rejects.toThrow(/get_index failed/);
  });

  it("memoizes: a second call while the first is in flight makes no additional fetch", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    let resolveInit!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveInit = resolve; }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(toolCallResult(JSON.stringify({ dated_siu: "0.0073" }))));

    const first = fetchLatestPrint();
    const second = fetchLatestPrint();
    resolveInit(jsonResponse({}, { "mcp-session-id": "session-abc" }));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the memo on failure, so a later call genuinely retries", async () => {
    const fetchLatestPrint = await freshFetchLatestPrint();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({})); // no session id -> rejects
    await expect(fetchLatestPrint()).rejects.toThrow();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, { "mcp-session-id": "session-abc" }))
      .mockResolvedValueOnce(jsonResponse(toolCallResult(JSON.stringify({ dated_siu: "0.0073" }))));
    const print = await fetchLatestPrint();
    expect(print).toEqual({ dated_siu: "0.0073" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
