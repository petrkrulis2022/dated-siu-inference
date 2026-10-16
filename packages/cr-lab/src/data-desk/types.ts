/** One read-only request to Blockworks, in a form that is the same for every backend and has one canonical text (so it can be hashed and pulled once per window). */
export type Api = "data" | "token-unlocks";

export interface Query {
  api: Api;
  /** A path, starting with `/query/timeseries/`, `/query/tabular/` or `/token-unlocks/v1/`. */
  path: string;
  /** Query-string parameters, values as plain text. */
  params: Readonly<Record<string, string>>;
}

export interface BackendResponse {
  status: number;
  /** The exact bytes received. The snapshot's hash is of these. */
  body: Uint8Array;
  /** The few response headers worth keeping (`cache-control`, `cache-status`, `x-request-id`, `date`, `retry-after`), lower-cased. */
  headers: Readonly<Record<string, string>>;
}

export interface DataBackend {
  readonly name: "fixtures" | "live";
  get(query: Query): Promise<BackendResponse>;
  /** The public OpenAPI `info.version` of each API, recorded once per window because responses carry no version of their own. */
  specVersions(): Promise<Record<string, string>>;
}
