/**
 * The Messages API client reads an event stream (D123): a request that generates for minutes cannot be sent non-streaming, because Node's fetch gives up after 300 s without response headers.
 * The stream is assembled into the message a non-streaming call returns, so nothing downstream changes; these tests pin what must survive the assembly.
 */
import { describe, expect, it } from "vitest";
import { Secret } from "../keys.js";
import { anthropicMessagesApi, readMessageStream } from "./anthropic-loop.js";

const ev = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** a whole message: a thinking block with its signature, a text block with a non-ASCII character, a tool call whose arguments arrive in two pieces */
const FULL = [
  ev("message_start", {
    message: {
      id: "msg_1",
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 400,
        output_tokens: 1,
      },
    },
  }),
  ev("content_block_start", {
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  }),
  ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Sum the " } }),
  ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "volumes." } }),
  ev("content_block_delta", {
    index: 0,
    delta: { type: "signature_delta", signature: "SIG-abc123" },
  }),
  ev("content_block_stop", { index: 0 }),
  ev("ping", {}),
  ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
  ev("content_block_delta", {
    index: 1,
    delta: { type: "text_delta", text: "Reading the data, é" },
  }),
  ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: " now." } }),
  ev("content_block_stop", { index: 1 }),
  ev("content_block_start", {
    index: 2,
    content_block: { type: "tool_use", id: "toolu_1", name: "timeseries_data", input: {} },
  }),
  ev("content_block_delta", {
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"model":"perp-' },
  }),
  ev("content_block_delta", {
    index: 2,
    delta: { type: "input_json_delta", partial_json: 'volume","limit":3}' },
  }),
  ev("content_block_stop", { index: 2 }),
  ev("message_delta", {
    delta: { stop_reason: "tool_use" },
    usage: { output_tokens: 4321, input_tokens: null },
  }),
  ev("message_stop", {}),
].join("");

const streamOf = (text: string, chunkBytes: number): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunkBytes));
      at += chunkBytes;
    },
  });
};

describe("readMessageStream", () => {
  it("assembles the message a non-streaming call returns: blocks, thinking signature, tool input, stop reason, usage", async () => {
    const r = await readMessageStream(streamOf(FULL, 1_000_000));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      content: [
        { type: "thinking", thinking: "Sum the volumes.", signature: "SIG-abc123" },
        { type: "text", text: "Reading the data, é now." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "timeseries_data",
          input: { model: "perp-volume", limit: 3 },
        },
      ],
      stop_reason: "tool_use",
      // the input side is from message_start, the output side from the last message_delta, and a null in a delta does not erase a count
      usage: {
        input_tokens: 1200,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 400,
        output_tokens: 4321,
      },
    });
  });

  it("gives the same message however the bytes are cut, including inside a multi-byte character and inside an event", async () => {
    const whole = await readMessageStream(streamOf(FULL, 1_000_000));
    for (const n of [1, 2, 3, 7, 64]) {
      expect(await readMessageStream(streamOf(FULL, n))).toEqual(whole);
    }
  });

  it("reads events separated by CRLF and one with no blank line after the last", async () => {
    const crlf = FULL.replace(/\n/g, "\r\n").replace(/\r\n\r\n$/, "");
    expect(await readMessageStream(streamOf(crlf, 5))).toEqual(
      await readMessageStream(streamOf(FULL, 5)),
    );
  });

  it("a stream that ends before message_stop is thrown as a TypeError: no answer reached us, not a result", async () => {
    const cut = FULL.slice(0, FULL.indexOf("event: message_delta"));
    await expect(readMessageStream(streamOf(cut, 50))).rejects.toBeInstanceOf(TypeError);
  });

  it("an error event inside the stream becomes the status a retry understands, with only its type kept", async () => {
    const overloaded =
      ev("message_start", { message: { usage: { input_tokens: 5 } } }) +
      ev("error", {
        error: { type: "overloaded_error", message: "a detail that must not be kept" },
      });
    const r = await readMessageStream(streamOf(overloaded, 20));
    expect(r).toEqual({ status: 529, json: { error: { type: "overloaded_error" } } });
  });
});

describe("the client over an event stream", () => {
  const KEY = new Secret("CR_ANTHROPIC_API_KEY", "test-key-value-123");
  const sse = (text: string): Response =>
    new Response(streamOf(text, 40), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  it("asks for a stream, and returns the assembled message with how many tries it took", async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sse(FULL);
    }) as unknown as typeof fetch;
    const r = await anthropicMessagesApi(KEY, { fetchImpl: f }).send({
      model: "m",
      max_tokens: 40000,
    });
    expect(bodies[0]).toMatchObject({ model: "m", max_tokens: 40000, stream: true });
    expect(r).toMatchObject({ status: 200, attempts: 1 });
    expect((r.json as { stop_reason: string }).stop_reason).toBe("tool_use");
  });

  it("retries an overload that arrives inside the stream, as it retries one that arrives as a status", async () => {
    const overloaded = ev("error", { error: { type: "overloaded_error" } });
    const replies = [overloaded, FULL];
    const slept: number[] = [];
    const f = (async () => sse(replies.shift() as string)) as unknown as typeof fetch;
    const r = await anthropicMessagesApi(KEY, {
      fetchImpl: f,
      sleep: async (ms) => void slept.push(ms),
      delaysMs: [10, 20],
    }).send({});
    expect(r).toMatchObject({ status: 200, attempts: 2 });
    expect(slept).toEqual([10]);
  });

  it("an error status with a JSON body is still read as JSON", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const r = await anthropicMessagesApi(KEY, { fetchImpl: f }).send({});
    expect(r).toEqual({
      status: 400,
      json: { error: { type: "invalid_request_error" } },
      attempts: 1,
    });
  });
});
