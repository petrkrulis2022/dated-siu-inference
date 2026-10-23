/**
 * The data desk (§16.5): the one way anything in the trial reads Blockworks. `pull` returns the window's snapshot of a query: from the store if it was already pulled this window
 * (each query is pulled **once per window**), otherwise through the governor from the backend, then stored with its hash. Models never see this: they get task prompts built from
 * snapshots, and the MCP harness forwards their tool calls through it (B4).
 *
 * A pull that fails is never stored: not a non-200, not an error body, not something that is not JSON. What the desk logs is hashes and sizes, never a query's text or any of the data.
 */
import { RateGovernor, type GovernedResult } from "./governor.js";
import { type Json, parseJsonDecimal } from "./json-decimal.js";
import { canonicalQuery, governorGroup, queryId, validateQuery } from "./queries.js";
import {
  type SnapshotStore,
  assertWindowAndTag,
  sha256Hex,
  type SnapshotMeta,
} from "./snapshots.js";
import type { DataBackend, Query } from "./types.js";

export class DataDeskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DataDeskError";
  }
}

export interface Snapshot {
  queryId: string;
  window: string;
  tag: string;
  bodySha256: string;
  bytes: number;
  fetchedAt: string;
  /** True when it was already stored for this window and nothing was requested. */
  fromStore: boolean;
  /** The exact response text. Private data: do not log it. */
  text: string;
  /** Parsed with every number kept as its source text. */
  json: Json;
}

export interface PullOptions {
  /** The window's date: one window per real day (UTC). */
  window: string;
  /** `daily` for the window's shared snapshot; other tags (`before-…`, `after-…`) for MCP sessions' own pulls. */
  tag?: string;
}

const retryAfter = (v: string | undefined): number | undefined => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export class DataDesk {
  readonly #backend: DataBackend;
  readonly #store: SnapshotStore;
  readonly #governor: RateGovernor;
  readonly #groupFor: (query: Query) => string;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #inFlight = new Map<string, Promise<Snapshot>>();

  constructor(opts: {
    backend: DataBackend;
    store: SnapshotStore;
    governor?: RateGovernor;
    /**
     * Which governor group paces a query. Default: the query's own (`data-api`, `token-unlocks`). A caller that talks to the provider by two routes at once can pass one group for both, so the two
     * share one spacing, one back-off and one hourly count: the provider's limit is on the account's requests, not on the route (the MCP session and its REST answer key, D122).
     */
    groupFor?: (query: Query) => string;
    now?: () => Date;
    log?: (line: string) => void;
  }) {
    this.#backend = opts.backend;
    this.#store = opts.store;
    this.#governor = opts.governor ?? new RateGovernor();
    this.#groupFor = opts.groupFor ?? governorGroup;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? (() => undefined);
  }

  get governor(): RateGovernor {
    return this.#governor;
  }

  /** Notes the APIs' public spec versions in the window's manifest, once per window. */
  async recordSpecVersions(window: string): Promise<void> {
    assertWindowAndTag(window, "daily");
    if (
      this.#store.manifest(window) !== undefined &&
      Object.keys(this.#store.manifest(window)?.specVersions ?? {}).length > 0
    )
      return;
    this.#store.setSpecVersions(window, await this.#backend.specVersions());
  }

  pull(query: Query, opts: PullOptions): Promise<Snapshot> {
    const tag = opts.tag ?? "daily";
    validateQuery(query);
    assertWindowAndTag(opts.window, tag);
    const id = queryId(query);
    const key = `${opts.window}|${tag}|${id}`;
    const running = this.#inFlight.get(key);
    if (running !== undefined) return running; // the same pull asked for twice at once is one request
    const p = this.#pull(query, id, opts.window, tag).finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, p);
    return p;
  }

  async #pull(query: Query, id: string, window: string, tag: string): Promise<Snapshot> {
    const stored = this.#store.read(window, tag, id);
    if (stored !== undefined) return this.#snapshot(stored.meta, stored.body, true);

    const res = await this.#governor.run(
      this.#groupFor(query),
      async (): Promise<GovernedResult<Awaited<ReturnType<DataBackend["get"]>>>> => {
        const r = await this.#backend.get(query);
        const ra = retryAfter(r.headers["retry-after"]);
        return {
          status: r.status,
          ...(ra === undefined ? {} : { retryAfterSeconds: ra }),
          value: r,
        };
      },
    );

    const text = new TextDecoder("utf-8", { fatal: false }).decode(res.body);
    if (res.status !== 200)
      throw new DataDeskError(this.#describeFailure(res.status, text), res.status);
    let parsed: Json;
    try {
      parsed = parseJsonDecimal(text);
    } catch {
      throw new DataDeskError("the response was 200 but not JSON, so it was not stored", 200);
    }
    const err =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed
        ? (parsed as { error?: Json }).error
        : null;
    if (err !== null && err !== undefined)
      throw new DataDeskError(
        "the response was 200 but its error field is set, so it was not stored",
        200,
      );

    const meta: SnapshotMeta = {
      queryId: id,
      query: canonicalQuery(query),
      window,
      tag,
      fetchedAt: this.#now().toISOString(),
      backend: this.#backend.name,
      httpStatus: res.status,
      bodySha256: sha256Hex(res.body),
      bytes: res.body.length,
      headers: { ...res.headers },
    };
    this.#store.write(meta, res.body);
    this.#log(
      `pulled ${id.slice(0, 12)} ${meta.bytes}B sha256 ${meta.bodySha256.slice(0, 12)} (${window}/${tag})`,
    );
    return this.#snapshot(meta, res.body, false);
  }

  #describeFailure(status: number, text: string): string {
    if (status === 401) return "Blockworks answered 401: no key was accepted as present";
    if (status === 403)
      return "Blockworks answered 403: the key is invalid or lacks permission for this dataset";
    // The error text is Blockworks' own message, not data; it is cut short and never logged with the query.
    let detail = "";
    try {
      const j = parseJsonDecimal(text) as { error?: Json };
      detail = typeof j?.error === "string" ? `: ${j.error.slice(0, 160)}` : "";
    } catch {
      /* not JSON: say only the status */
    }
    return `Blockworks answered ${status}${detail}`;
  }

  #snapshot(meta: SnapshotMeta, body: Uint8Array, fromStore: boolean): Snapshot {
    const text = new TextDecoder().decode(body);
    return {
      queryId: meta.queryId,
      window: meta.window,
      tag: meta.tag,
      bodySha256: meta.bodySha256,
      bytes: meta.bytes,
      fetchedAt: meta.fetchedAt,
      fromStore,
      text,
      json: parseJsonDecimal(text),
    };
  }
}
