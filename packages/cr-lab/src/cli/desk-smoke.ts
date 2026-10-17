/**
 * Runs the data desk end to end on the FIXTURES backend: pulls one query from each dataset family the four tasks use, shows the hashes, then pulls them all again and checks
 * that nothing was requested twice. Uses the real desk, governor, store and manifest, in a fresh temporary directory each run (a store left over from an older version of the
 * fixtures would be served as if it were current). Spends nothing, reads no key, calls no network. `pnpm --filter @touchstone/cr-lab run desk-smoke [YYYY-MM-DD]`
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeMonthsWindow, quarterWindow } from "../data-desk/dates.js";
import { DataDesk, type Snapshot } from "../data-desk/desk.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import { RateGovernor } from "../data-desk/governor.js";
import { catalog } from "../data-desk/queries.js";
import { SnapshotStore } from "../data-desk/snapshots.js";
import type { Json } from "../data-desk/json-decimal.js";
import { addDays } from "../data-desk/dates.js";
import type { Query } from "../data-desk/types.js";

const window = process.argv[2] ?? FIXTURE_AS_OF;
const backend = new FixtureBackend();
const root = mkdtempSync(join(tmpdir(), "cr-desk-smoke-"));
const store = new SnapshotStore({
  privateRoot: join(root, "snapshots"),
  manifestDir: join(root, "manifests"),
  backend: "fixtures",
});
// Fixtures have no real rate limit, so no spacing; the live desk keeps the governor's defaults.
const governor = new RateGovernor({
  overrides: { "data-api": { minIntervalMs: 0 }, "token-unlocks": { minIntervalMs: 0 } },
});
const desk = new DataDesk({ backend, store, governor, log: (line) => console.log(`  ${line}`) });

const rows = (s: Snapshot): Record<string, Json>[] =>
  (s.json as { data: Record<string, Json>[] }).data;
const str = (v: Json | undefined): string => String(v);

async function pullAll(): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const pull = async (q: Query) => {
    const s = await desk.pull(q, { window });
    out.push(s);
    return s;
  };
  // CR-VS: venues, then three venues' daily volume over the last 12 complete months
  const venues = rows(await pull(catalog.perpVenues())).map((r) => str(r.id));
  const months = completeMonthsWindow(window);
  await pull(catalog.perpVolume(venues.slice(0, 3), months.start, months.end));
  // CR-PL: lending protocols, then one protocol's last complete quarter
  const protocols = rows(await pull(catalog.lendingProtocols())).map((r) => str(r.id));
  const q = quarterWindow(
    Number(window.slice(0, 4)),
    Math.ceil(Number(window.slice(5, 7)) / 3) - 1 || 4,
  );
  await pull(catalog.lendingFinancials(protocols.slice(0, 3), q.start, q.end));
  // CR-UO: the token list, one token's id, its events for the next 90 days and its circulating supply
  const tokens = rows(await pull(catalog.tokenUnlockAssets()));
  const slug = str(tokens[0]?.slug);
  const assetId = str(
    ((await pull(catalog.assetBySlug(slug))).json as { data: Record<string, Json> }).data.assetID,
  ); // a single row comes back as one object
  await pull(catalog.tokenUnlockEvents(slug, window, addDays(window, 90)));
  await pull(catalog.assetSupply([assetId], window, addDays(window, 1)));
  // CR-SM (option B): the stablecoin chains and issuers, then the first and last day's supply of each over 90 days
  const chains = rows(await pull(catalog.stablecoinChains())).map((r) => str(r.id));
  await pull(
    catalog.stablecoinsByChain(chains.slice(0, 10), addDays(window, -90), addDays(window, 1)),
  );
  const issuers = rows(await pull(catalog.stablecoinIssuers())).map((r) => str(r.id));
  await pull(
    catalog.stablecoinsByIssuer(issuers.slice(0, 10), addDays(window, -90), addDays(window, 1)),
  );
  return out;
}

console.log(`data desk on fixtures, window ${window}`);
const first = await pullAll();
const requestsFirst = backend.requests.length;
console.log(`first pass: ${first.length} snapshots, ${requestsFirst} requests`);
const second = await pullAll();
const extra = backend.requests.length - requestsFirst;
console.log(
  `second pass: ${second.length} snapshots, ${extra} new requests, ${second.filter((s) => s.fromStore).length} served from the store`,
);
const manifest = store.manifest(window);
console.log(
  `manifest: ${manifest?.entries.length ?? 0} entries (hashes only), backend ${manifest?.entries[0]?.backend}`,
);
for (const r of governor.report())
  console.log(
    `governor ${r.group}: ${r.requestsToday} requests today of ${r.limit}, ${r.backoffs} back-offs`,
  );
rmSync(root, { recursive: true, force: true });
if (
  extra !== 0 ||
  second.some((s) => !s.fromStore) ||
  (manifest?.entries.length ?? 0) !== first.length
) {
  console.error("FAILED: a query was pulled twice, or the manifest does not list every snapshot");
  process.exit(1);
}
console.log("ok: every query pulled once, then served from the store");
