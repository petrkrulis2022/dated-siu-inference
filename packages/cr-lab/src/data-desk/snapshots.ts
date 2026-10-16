/**
 * Snapshots: what Blockworks sent, kept byte for byte so every answer can be recomputed later, and the day's manifest of their hashes.
 *
 * Two homes (D71). The response bytes and their metadata (including the query text, which names what we asked about) are private: `data/private/blockworks/snapshots/`. The
 * MANIFEST is committed and holds hashes only: for each snapshot a hash of the query (never its text), the sha256 of the body, its size, when it was fetched, and which backend
 * produced it. Anyone with the private files can check them against the committed manifest; nobody without them learns anything from it.
 *
 * Fixture snapshots live in their own private tree and their manifests are never committed, so synthetic data can never be mistaken for the real record. A stored snapshot
 * whose bytes no longer match their hash is an integrity failure and throws; the desk never quietly refetches over it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CR_PUBLIC_DIR, pathWithin, privatePath } from "../paths.js";
import { isDate } from "./dates.js";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const TAG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[0-9a-f]{64}$/;

export function assertWindowAndTag(window: string, tag: string): void {
  if (!isDate(window))
    throw new TypeError(`window must be a calendar date YYYY-MM-DD, got ${JSON.stringify(window)}`);
  if (!TAG.test(tag))
    throw new TypeError(
      `tag must be lowercase letters, digits and hyphens, got ${JSON.stringify(tag)}`,
    );
}

/** What is kept beside each snapshot, privately. */
export interface SnapshotMeta {
  queryId: string;
  /** The canonical query text. Private: it names what we asked about. */
  query: string;
  window: string;
  tag: string;
  fetchedAt: string;
  backend: "fixtures" | "live";
  httpStatus: number;
  bodySha256: string;
  bytes: number;
  headers: Record<string, string>;
}

/** One line of the committed manifest: hashes and sizes only. */
export interface ManifestEntry {
  tag: string;
  queryId: string;
  bodySha256: string;
  bytes: number;
  fetchedAt: string;
  backend: "fixtures" | "live";
  httpStatus: number;
}

export interface Manifest {
  window: string;
  /** The public OpenAPI `info.version` of each API, noted once per window because responses carry no version of their own. */
  specVersions: Record<string, string>;
  entries: ManifestEntry[];
}

export class SnapshotCorrupt extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCorrupt";
  }
}

function atomicWrite(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export interface SnapshotStoreOptions {
  /** Where bodies and metadata go. Must be under `data/private/` unless a test passes a temporary directory. */
  privateRoot: string;
  /** Where manifests go. */
  manifestDir: string;
  backend: "fixtures" | "live";
}

/** The default locations for a backend: live data under the private tree with committed manifests; fixtures wholly private. */
export function defaultStoreOptions(backend: "fixtures" | "live"): SnapshotStoreOptions {
  return backend === "live"
    ? {
        privateRoot: privatePath("snapshots"),
        manifestDir: pathWithin(CR_PUBLIC_DIR, "manifests"),
        backend,
      }
    : {
        privateRoot: privatePath("fixtures", "snapshots"),
        manifestDir: privatePath("fixtures", "manifests"),
        backend,
      };
}

export class SnapshotStore {
  readonly #opts: SnapshotStoreOptions;

  constructor(opts: SnapshotStoreOptions) {
    this.#opts = opts;
  }

  #files(window: string, tag: string, queryId: string): { body: string; meta: string } {
    assertWindowAndTag(window, tag);
    if (!ID.test(queryId))
      throw new TypeError(`queryId must be a sha256 hex, got ${JSON.stringify(queryId)}`);
    return {
      body: pathWithin(this.#opts.privateRoot, window, tag, `${queryId}.body`),
      meta: pathWithin(this.#opts.privateRoot, window, tag, `${queryId}.meta.json`),
    };
  }

  #manifestPath(window: string): string {
    assertWindowAndTag(window, "daily");
    return pathWithin(this.#opts.manifestDir, `${window}.json`);
  }

  /** The stored snapshot, or undefined if there is none. Throws `SnapshotCorrupt` if its bytes no longer match its hash or it came from another backend. */
  read(
    window: string,
    tag: string,
    queryId: string,
  ): { meta: SnapshotMeta; body: Uint8Array } | undefined {
    const f = this.#files(window, tag, queryId);
    if (!existsSync(f.meta) || !existsSync(f.body)) return undefined;
    const meta = JSON.parse(readFileSync(f.meta, "utf-8")) as SnapshotMeta;
    const body = new Uint8Array(readFileSync(f.body));
    if (meta.backend !== this.#opts.backend)
      throw new SnapshotCorrupt(
        `snapshot ${queryId.slice(0, 12)} was fetched by the ${meta.backend} backend but this store is ${this.#opts.backend}'s`,
      );
    if (sha256Hex(body) !== meta.bodySha256 || body.length !== meta.bytes)
      throw new SnapshotCorrupt(
        `snapshot ${queryId.slice(0, 12)} (${window}/${tag}) no longer matches its recorded hash`,
      );
    return { meta, body };
  }

  /** Stores a snapshot and records it in the window's manifest. */
  write(meta: SnapshotMeta, body: Uint8Array): void {
    if (meta.backend !== this.#opts.backend)
      throw new TypeError(
        `a ${meta.backend} snapshot cannot go in the ${this.#opts.backend} store`,
      );
    if (sha256Hex(body) !== meta.bodySha256 || body.length !== meta.bytes)
      throw new TypeError("snapshot meta does not describe the body given");
    const f = this.#files(meta.window, meta.tag, meta.queryId);
    atomicWrite(f.body, body);
    atomicWrite(f.meta, `${JSON.stringify(meta, null, 2)}\n`);
    const manifest = this.manifest(meta.window) ?? {
      window: meta.window,
      specVersions: {},
      entries: [],
    };
    const entry: ManifestEntry = {
      tag: meta.tag,
      queryId: meta.queryId,
      bodySha256: meta.bodySha256,
      bytes: meta.bytes,
      fetchedAt: meta.fetchedAt,
      backend: meta.backend,
      httpStatus: meta.httpStatus,
    };
    const entries = [
      ...manifest.entries.filter((e) => !(e.tag === entry.tag && e.queryId === entry.queryId)),
      entry,
    ].sort((a, b) => (a.tag + a.queryId).localeCompare(b.tag + b.queryId));
    this.#writeManifest({ ...manifest, entries });
  }

  manifest(window: string): Manifest | undefined {
    const p = this.#manifestPath(window);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Manifest) : undefined;
  }

  /** Notes the APIs' public spec versions for the window, once; a later call leaves the first note in place. */
  setSpecVersions(window: string, versions: Record<string, string>): boolean {
    const manifest = this.manifest(window) ?? { window, specVersions: {}, entries: [] };
    if (Object.keys(manifest.specVersions).length > 0) return false;
    this.#writeManifest({ ...manifest, specVersions: versions });
    return true;
  }

  #writeManifest(m: Manifest): void {
    atomicWrite(this.#manifestPath(m.window), `${JSON.stringify(m, null, 2)}\n`);
  }
}
