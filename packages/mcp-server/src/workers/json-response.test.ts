import { describe, expect, it } from "vitest";
import { singleReplyAsJson } from "./json-response.js";

const REPLY = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } };
const sse = (...events: string[]) =>
  new Response(events.map((e) => `event: message\ndata: ${e}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "mcp-session-id": "abc" },
  });
const ACCEPT_BOTH = "application/json, text/event-stream";

describe("singleReplyAsJson", () => {
  it("turns a one-event stream into plain JSON for a client that accepts JSON, keeping other headers", async () => {
    const out = await singleReplyAsJson(sse(JSON.stringify(REPLY)), ACCEPT_BOTH);
    expect(out.headers.get("content-type")).toBe("application/json");
    expect(out.headers.get("mcp-session-id")).toBe("abc");
    expect(await out.json()).toEqual(REPLY);
  });

  it("leaves the stream alone when the client did not ask for JSON", async () => {
    const original = sse(JSON.stringify(REPLY));
    const out = await singleReplyAsJson(original, "text/event-stream");
    expect(out).toBe(original);
    expect(await singleReplyAsJson(original, null)).toBe(original);
  });

  it("leaves a stream with more than one message alone — it is not a single reply", async () => {
    const original = sse(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }),
      JSON.stringify(REPLY),
    );
    expect(await singleReplyAsJson(original, ACCEPT_BOTH)).toBe(original);
  });

  it("leaves an unparseable payload alone rather than rewriting it", async () => {
    const original = sse("not json");
    expect(await singleReplyAsJson(original, ACCEPT_BOTH)).toBe(original);
  });

  it("never touches a non-stream response or an error status", async () => {
    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(await singleReplyAsJson(json, ACCEPT_BOTH)).toBe(json);
    const failed = new Response("data: {}\n\n", {
      status: 500,
      headers: { "content-type": "text/event-stream" },
    });
    expect(await singleReplyAsJson(failed, ACCEPT_BOTH)).toBe(failed);
  });

  it("joins a payload split over several data lines", async () => {
    const r = new Response('event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
    expect(await (await singleReplyAsJson(r, ACCEPT_BOTH)).json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
    });
  });
});
