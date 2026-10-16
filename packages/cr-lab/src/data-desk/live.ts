/**
 * The live backend: read-only requests to the Blockworks Data API and Token Unlocks API with the trial's key. Nothing here has run against Blockworks yet (the key has not
 * arrived); it is tested against a fake `fetch`, and day 1's calibration is its first real run.
 *
 * What it guarantees: the key goes in one header (`X-Blockworks-API-Key`) and only to the API host (never to the docs host, never in a URL); redirects are NOT followed, so the
 * key can never be sent to a host the API redirects to; only paths the catalog can build are sent; every request has a timeout; and no error message carries the key.
 * It is the only module besides `keys.ts` that names the Blockworks key (the isolation test allows `data-desk/` and nothing else).
 */
import type { Secret } from "../keys.js";
import { blockworksKey } from "../keys.js";
import { validateQuery } from "./queries.js";
import type { BackendResponse, DataBackend, Query } from "./types.js";

export const API_BASE_URL = "https://api.blockworks.com";
/** The public OpenAPI specs, on the docs host: no key is sent there. */
export const SPEC_URLS: Readonly<Record<string, string>> = {
  "data-api": "https://docs.blockworks.com/api-reference/data-api/openapi.json",
  "token-unlocks": "https://docs.blockworks.com/api-reference/token-unlocks/openapi.json",
};
export const KEY_HEADER = "X-Blockworks-API-Key";
const KEEP_HEADERS = [
  "cache-control",
  "cache-status",
  "x-request-id",
  "date",
  "retry-after",
  "content-type",
];

type FetchFn = typeof fetch;

export interface LiveBackendOptions {
  key: () => Secret;
  fetch?: FetchFn;
  baseUrl?: string;
  timeoutMs?: number;
}

/** The query string: sorted, values percent-encoded except commas, which the API takes literally in lists. */
export function queryString(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k] as string).replace(/%2C/gi, ",")}`)
    .join("&");
}

export class LiveBackend implements DataBackend {
  readonly name = "live" as const;
  readonly #key: () => Secret;
  readonly #fetch: FetchFn;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(opts: LiveBackendOptions) {
    this.#key = opts.key;
    this.#fetch = opts.fetch ?? fetch;
    this.#base = (opts.baseUrl ?? API_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    if (!this.#base.startsWith("https://"))
      throw new TypeError(`the Blockworks API is reached over https only, got ${this.#base}`);
  }

  /** `text` with the key's value, if it appears, replaced: for an error that may have echoed a request. */
  #clean(text: string): string {
    const v = this.#key().reveal();
    return v.length >= 8 ? text.split(v).join(`[redacted ${this.#key().name}]`) : text;
  }

  async get(query: Query): Promise<BackendResponse> {
    validateQuery(query);
    const qs = queryString(query.params);
    const url = `${this.#base}${query.path}${qs === "" ? "" : `?${qs}`}`;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        method: "GET",
        headers: { [KEY_HEADER]: this.#key().reveal(), accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // The original error is deliberately NOT attached as `cause`: a transport error can echo the request, and so the key, and loggers print a `cause`.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        this.#clean(
          `request to ${query.path} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `${query.path} answered a redirect (${res.status}); redirects are not followed, so the key is never sent anywhere else`,
      );
    }
    const headers: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers };
  }

  /** The `info.version` of each public spec. An unreachable spec is recorded as "unavailable", not an error: the version is a note on the snapshot, not a precondition. */
  async specVersions(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [api, url] of Object.entries(SPEC_URLS)) {
      try {
        const res = await this.#fetch(url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        const v = ((await res.json()) as { info?: { version?: unknown } }).info?.version;
        out[api] = res.ok && typeof v === "string" ? v : "unavailable";
      } catch {
        out[api] = "unavailable";
      }
    }
    return out;
  }
}

/** The live backend with the key from `.env`. Throws `MissingKeyError` if `CR_BLOCKWORKS_API_KEY` is unset. */
export function liveBackendFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LiveBackend {
  blockworksKey(env); // fail now, with the variable's name, rather than on the first request
  return new LiveBackend({ key: () => blockworksKey(env) });
}
