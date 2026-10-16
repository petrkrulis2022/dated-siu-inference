import { describe, expect, it } from "vitest";
import { Secret } from "../keys.js";
import {
  API_BASE_URL,
  KEY_HEADER,
  LiveBackend,
  SPEC_URLS,
  liveBackendFromEnv,
  queryString,
} from "./live.js";
import { catalog } from "./queries.js";

const KEY = "bw-live-0123456789abcdef";
const secret = () => new Secret("CR_BLOCKWORKS_API_KEY", KEY);

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url));
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const header = (c: Call, name: string): string | undefined =>
  (c.init.headers as Record<string, string>)[name];

describe("LiveBackend requests", () => {
  it("sends the key in one header, to the API host, with sorted parameters and literal commas, and never puts it in the URL", async () => {
    const { fn, calls } = fakeFetch(() => json({ error: null, data: [] }));
    const b = new LiveBackend({ key: secret, fetch: fn });
    await b.get(catalog.perpVolume(["a", "b"], "2026-09-01", "2026-10-01"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${API_BASE_URL}/query/timeseries/perp-dex-protocols/1d?end=2026-10-01&selections=volumeUSD&series=a,b&start=2026-09-01`,
    );
    expect(header(calls[0]!, KEY_HEADER)).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("does not follow redirects, and treats one as an error, so the key cannot be sent to another host", async () => {
    const { fn, calls } = fakeFetch(
      () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    );
    const b = new LiveBackend({ key: secret, fetch: fn });
    expect(calls.length).toBe(0);
    await expect(b.get(catalog.perpVenues())).rejects.toThrow(
      /redirect \(302\).*never sent anywhere else/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("gives every request a timeout", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    await new LiveBackend({ key: secret, fetch: fn, timeoutMs: 5 }).get(catalog.perpVenues());
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns an error status as a response for the desk to judge, keeping only the headers worth keeping", async () => {
    const { fn } = fakeFetch(() =>
      json({ error: "slow down", data: null }, 429, {
        "retry-after": "7",
        "set-cookie": "session=secret",
        "x-request-id": "req-1",
        server: "x",
      }),
    );
    const r = await new LiveBackend({ key: secret, fetch: fn }).get(catalog.perpVenues());
    expect(r.status).toBe(429);
    expect(r.headers).toEqual({
      "retry-after": "7",
      "x-request-id": "req-1",
      "content-type": "text/plain;charset=UTF-8",
    });
    expect(new TextDecoder().decode(r.body)).toContain("slow down");
  });

  it("keeps the exact bytes it received", async () => {
    const raw = '{"error":null,"data":{"v":0.1000000000000000055511151231257827}}';
    const { fn } = fakeFetch(() => new Response(raw, { status: 200 }));
    const r = await new LiveBackend({ key: secret, fetch: fn }).get(catalog.perpVenues());
    expect(new TextDecoder().decode(r.body)).toBe(raw);
  });

  it("never lets the key into an error message, even if the transport echoed it", async () => {
    const { fn } = fakeFetch(() => {
      throw new Error(`connect failed for header ${KEY_HEADER}: ${KEY}`);
    });
    const err = await new LiveBackend({ key: secret, fetch: fn })
      .get(catalog.perpVenues())
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("[redacted CR_BLOCKWORKS_API_KEY]");
  });

  it("refuses to send a path the catalog could not have built", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const b = new LiveBackend({ key: secret, fetch: fn });
    await expect(b.get({ api: "data", path: "/admin/keys", params: {} })).rejects.toThrow(
      TypeError,
    );
    await expect(
      b.get({ api: "data", path: "/query/tabular/../../x", params: {} }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("is reached over https only", () => {
    expect(() => new LiveBackend({ key: secret, baseUrl: "http://api.blockworks.com" })).toThrow(
      /https only/,
    );
  });
});

describe("queryString", () => {
  it("sorts, encodes, and leaves commas literal", () => {
    expect(queryString({ b: "x y", a: "1,2", c: "a&b=c" })).toBe("a=1,2&b=x%20y&c=a%26b%3Dc");
    expect(queryString({})).toBe("");
  });
});

describe("specVersions", () => {
  it("reads each public spec's version, from the docs host, WITHOUT the key", async () => {
    const { fn, calls } = fakeFetch((url) =>
      json({ info: { version: url.includes("token-unlocks") ? "1.0.0" : "0.1.0" } }),
    );
    const v = await new LiveBackend({ key: secret, fetch: fn }).specVersions();
    expect(v).toEqual({ "data-api": "0.1.0", "token-unlocks": "1.0.0" });
    expect(calls.map((c) => c.url).sort()).toEqual(Object.values(SPEC_URLS).sort());
    for (const c of calls) expect(JSON.stringify(c.init.headers ?? {})).not.toContain(KEY);
  });

  it("records an unreachable or odd spec as unavailable instead of failing the pull", async () => {
    const { fn } = fakeFetch((url) =>
      url.includes("token-unlocks") ? json({ nothing: 1 }) : json({}, 500),
    );
    expect(await new LiveBackend({ key: secret, fetch: fn }).specVersions()).toEqual({
      "data-api": "unavailable",
      "token-unlocks": "unavailable",
    });
    const thrower = fakeFetch(() => {
      throw new Error("offline");
    });
    expect(await new LiveBackend({ key: secret, fetch: thrower.fn }).specVersions()).toEqual({
      "data-api": "unavailable",
      "token-unlocks": "unavailable",
    });
  });
});

describe("liveBackendFromEnv", () => {
  it("fails at once, naming the variable, when the key is not set", () => {
    expect(() => liveBackendFromEnv({})).toThrow(/CR_BLOCKWORKS_API_KEY/);
    expect(() => liveBackendFromEnv({ CR_BLOCKWORKS_API_KEY: "" })).toThrow(
      /CR_BLOCKWORKS_API_KEY/,
    );
    expect(liveBackendFromEnv({ CR_BLOCKWORKS_API_KEY: KEY }).name).toBe("live");
  });
});
