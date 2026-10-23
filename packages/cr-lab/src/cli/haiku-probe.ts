/**
 * The Haiku probe (D117): gives claude-haiku-4-5 working space in two ways, one at a time, on the same instances and prompts as the counted snapshot-mode run, to show whether its 0 of 24 on
 * CR-VS, CR-PL and CR-SM is capability or the absence of working space. Rule and thresholds are in `probe/haiku-probe.ts` and in plan D117, fixed before the run.
 *
 *   node --env-file=../../.env dist/cli/haiku-probe.js --yes-spend [--windows 2026-10-17,2026-10-18,2026-10-19] [--max-items 24] [--cap 2.00]
 *
 * Spends money on the trial's Anthropic key (the spend guard still applies, and the probe's own cap, $2.00 by default, stops it first). Makes NO Blockworks request: it reads the stored snapshots.
 * Probe records and replies go under the private directory and never enter the counted records or tables. Prints counts, classes and dollars, never a Blockworks figure or a model's reply.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { SnapshotStore, defaultStoreOptions } from "../data-desk/snapshots.js";
import { pathWithin, privatePath } from "../paths.js";
import { loadAllowances } from "../runner/allowance.js";
import { buildPrompt } from "../runner/prompts.js";
import { FileRecordStore } from "../runner/records.js";
import { daySha256 } from "../runner/run-day.js";
import { buildSeats } from "../runner/seats.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";
import { loadDay } from "../tasks/day-data.js";
import { drawInstances } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import {
  PROBE_CAP_USD,
  readResult,
  regradeWorkingRow,
  runProbe,
  tally,
  type ProbeItem,
  type ProbeRow,
} from "../probe/haiku-probe.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (l: string) => console.log(`${stamp()} ${l}`);

if (!flag("yes-spend")) {
  console.error(
    "refusing: the probe spends real money on claude-haiku-4-5 (a few dollars at most; the cap is $2.00). Add --yes-spend to go ahead.",
  );
  process.exit(2);
}
const windows = (opt("windows") ?? "2026-10-17,2026-10-18,2026-10-19").split(",");
const cap = opt("cap") ?? PROBE_CAP_USD;
const maxItems = opt("max-items") !== undefined ? Number(opt("max-items")) : undefined;

const store = new SnapshotStore(defaultStoreOptions("live"));
const records = new FileRecordStore();
const seat = buildSeats(["claude-haiku-4-5"])[0];
if (seat === undefined) throw new Error("claude-haiku-4-5 is not in the registry");

// the counted answers to compare with, and the instances they were given
const items: ProbeItem[] = [];
const control: ReturnType<FileRecordStore["forWindow"]> = [];
for (const window of windows) {
  const day = loadDay(store, window);
  const drawn = drawInstances(day, new SeedBook().seedFor(window));
  const counted = records
    .forWindow(window)
    .filter(
      (r) =>
        r.part === "snapshot" &&
        r.model === "claude-haiku-4-5" &&
        (r.task === "CR-VS" || r.task === "CR-PL" || r.task === "CR-SM"),
    )
    .sort((a, b) => a.task.localeCompare(b.task) || a.instance.localeCompare(b.instance));
  for (const rec of counted) {
    const instance = drawn.find((i) => i.id === rec.instance);
    const bundle = instance === undefined ? undefined : buildPrompt(instance, day);
    if (
      instance === undefined ||
      bundle === undefined ||
      bundle.promptSha256 !== rec.prompt_sha256
    ) {
      log(`skipped ${rec.instance}: its prompt cannot be rebuilt as it was counted`);
      continue;
    }
    items.push({ instance, bundle, window, daySha256: daySha256(store, window) });
    control.push(rec);
  }
}
const chosen = maxItems === undefined ? items : items.slice(0, maxItems);
log(`${chosen.length} instances (${windows.join(", ")}), cap $${cap}`);

const dir = privatePath("cr", "probes", `haiku-${new Date().toISOString().slice(0, 10)}`);
const rows = pathWithin(dir, "records.jsonl");
mkdirSync(dir, { recursive: true });
// a run that was stopped, or a first small run, is resumed: a condition already run on an instance is never run again (one attempt each)
const prior: ProbeRow[] = existsSync(rows)
  ? readFileSync(rows, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as ProbeRow)
  : [];
if (flag("regrade-working")) {
  // re-read the stored working-field replies with the current stripping (no call, no cost); the first rows were graded by one that did not read a fenced reply as the gate does
  copyFileSync(rows, pathWithin(dir, "records.before-regrade.jsonl"));
  const regraded = prior.map((r) => {
    if (r.condition !== "working-field") return r;
    const item = items.find((i) => i.instance.id === r.record.instance);
    if (item === undefined) return r;
    const reply = readFileSync(
      pathWithin(dir, "replies", `working-field__${item.instance.id}.txt`),
      "utf-8",
    );
    return regradeWorkingRow(r, item.instance, reply);
  });
  writeFileSync(rows, regraded.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  log(
    `regraded ${regraded.filter((r, i) => r !== prior[i]).length} working-field rows from their stored replies (original kept as records.before-regrade.jsonl)`,
  );
  process.exit(0);
}
const priorSpent = prior.reduce((n, r) => n + Number(r.record.usd), 0);
const done = new Set(prior.map((r) => `${r.condition}|${r.record.instance}`));
if (prior.length > 0)
  log(`resuming: ${prior.length} answers already run ($${priorSpent.toFixed(4)} spent)`);
const fresh = await runProbe({
  seat,
  ledger: new SpendLedger({
    store: new FileLedgerStore(),
    policy: policyFromBudgets(loadBudgets()),
  }),
  items: chosen,
  allowances: loadAllowances(),
  capUsd: String(Math.max(0, Number(cap) - priorSpent)),
  done,
  keepReply: (condition, instance, text) => {
    const f = pathWithin(dir, "replies", `${condition}__${instance.id}.txt`);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text, { mode: 0o600 });
  },
  log,
});
for (const r of fresh.rows) appendFileSync(rows, `${JSON.stringify(r)}\n`, { mode: 0o600 });
const result = {
  rows: [...prior, ...fresh.rows],
  spentUsd: String(priorSpent + Number(fresh.spentUsd)),
  capReached: fresh.capReached,
};

const ran = new Set(result.rows.map((r) => r.record.instance));
const ctl = tally(
  "control",
  control.filter((r) => ran.has(r.instance)),
);
const wf = tally(
  "working-field",
  result.rows.filter((r) => r.condition === "working-field").map((r) => r.record),
);
const th = tally(
  "thinking",
  result.rows.filter((r) => r.condition === "thinking").map((r) => r.record),
);
const n = wf.answers;
const verdict = readResult(n, { workingField: wf.passed, thinking: th.passed });
const line = (t: typeof ctl) =>
  `${t.condition.padEnd(14)} ${t.passed} of ${t.answers} passed, $${Number(t.usd).toFixed(4)}, first failure classes: ${JSON.stringify(t.classes)}`;
const report = [
  `Haiku probe, ${n} instances per condition, spent $${Number(result.spentUsd).toFixed(4)} of the $${cap} cap${result.capReached ? " (stopped by the cap)" : ""}`,
  line(ctl),
  line(wf),
  line(th),
  `reading, by the rule fixed in advance: ${verdict}`,
].join("\n");
writeFileSync(pathWithin(dir, "report.md"), `${report}\n`, { mode: 0o600 });
console.log(`\n${report}\nprivate files: ${dir}`);
