/**
 * The reasoning probe battery's runner (docs/marketplace_plan.md §14): `pnpm run lab-probe-battery -- --pilot | --stage1 | --stage2 | --replicate <label> ...`.
 *
 * It only calls and saves. Which calls make up a stage, what each arm sends and when to stop are in `lab/battery-run.ts`; the screens are in
 * `lab/probe-battery.ts`; nothing is coded or analysed here. Every call is appended to `data/lab/probes/battery/<run>/calls.jsonl` as it finishes,
 * with the prompt's hash, the raw reply, the thinking the provider returned, the usage and cost and the sampling actually sent, so a killed run
 * resumes (`--resume <run>`) without repeating a call, and the first call's evidence is on disk before the second is made.
 *
 * The Anthropic credit is shared with the daily print: the run is refused if its cap would take the cycle past the credit guard's limit (D60), and
 * what it spends is entered in the ledger as it goes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createAdapterFor, loadApiKeysFromEnv, type Adapter } from "@touchstone/harness";
import { extractThinking } from "../loop/thinking.js";
import {
  BATTERY_MODELS,
  CAPS,
  SAMPLES_PER_CELL,
  addUsd,
  callCostUsd,
  evaluateStop,
  paramsFor,
  pilotPlan,
  replicationPlan,
  stage1Plan,
  stage2Plan,
  type BatteryCall,
  type BatteryModel,
  type CallSpec,
} from "../lab/battery-run.js";
import { LAB_INSTRUMENT_VERSION } from "../lab/instrument.js";
import { decimalToUnits, unitsToDecimal } from "../lab/money.js";
import { ARMS, CELLS, CELL_IDS, armPrompt, buildCellScreen, parseBatteryReply, type Arm, type CellId } from "../lab/probe-battery.js";
import { sha256 } from "../lab/probe.js";
import { rulesFingerprint } from "../lab/reason-codes.js";
import { assertCreditGuard, loadSpendLedger, recordSpend } from "./credit-ledger.js";
import { PRICES, REPO_ROOT, withRetry } from "./p5-shared.js";

const BATTERY_DIR = join(REPO_ROOT, "data/lab/probes/battery");
const CONCURRENCY = 4;

interface Args {
  kind: "pilot" | "stage1" | "stage2" | "replicate";
  label?: string;
  resume?: string;
  cells?: CellId[];
  models?: BatteryModel[];
  arms?: Arm[];
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const kinds = (["pilot", "stage1", "stage2"] as const).filter((k) => argv.includes(`--${k}`));
  const rep = flag("replicate");
  if (rep !== undefined) kinds.push("replicate" as never);
  if (kinds.length !== 1 && flag("resume") === undefined) throw new Error("name exactly one of --pilot, --stage1, --stage2, --replicate <label>, or --resume <run>");
  const list = <T extends string>(v: string | undefined, allowed: readonly T[], what: string): T[] | undefined =>
    v === undefined
      ? undefined
      : v.split(",").map((x) => {
          if (!allowed.includes(x as T)) throw new Error(`${what}: "${x}" is not one of ${allowed.join(", ")}`);
          return x as T;
        });
  return {
    kind: (kinds[0] ?? "pilot") as Args["kind"],
    ...(rep !== undefined ? { label: rep } : {}),
    ...(flag("resume") !== undefined ? { resume: flag("resume") } : {}),
    ...(flag("cells") !== undefined ? { cells: list(flag("cells"), CELL_IDS, "--cells")! } : {}),
    ...(flag("models") !== undefined ? { models: list(flag("models"), BATTERY_MODELS, "--models")! } : {}),
    ...(flag("arms") !== undefined ? { arms: list(flag("arms"), ARMS, "--arms")! } : {}),
    concurrency: flag("concurrency") === undefined ? CONCURRENCY : Number(flag("concurrency")),
  };
}

interface Manifest {
  runId: string;
  kind: Args["kind"];
  createdAt: string;
  gitHead: string;
  instrumentVersion: number;
  capUsd: string;
  rulesFingerprint: string;
  sampling: string;
  samplesPerCell: number;
  plannedCalls: number;
  cells: Record<string, { change: string; against: readonly string[]; trader: string; seed: number; round: number; printByRound: string[]; heldUsdcMinor: string; heldFsiuMilliSiu: string; promptSha256: Record<Arm, string>; notes: string[] }>;
  plan: { cells: CellId[]; models: BatteryModel[]; arms: Arm[] };
}

const gitHead = (): string => {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
};

function planFor(args: Args, runId: string): { calls: CallSpec[]; cap: string } {
  const label = runId;
  switch (args.kind) {
    case "pilot":
      return { calls: pilotPlan(label), cap: CAPS.pilot };
    case "stage1":
      return { calls: stage1Plan(label), cap: CAPS.stage1 };
    case "stage2":
      return { calls: stage2Plan(label), cap: CAPS.stage2 };
    case "replicate": {
      if (args.cells === undefined || args.models === undefined || args.arms === undefined) throw new Error("--replicate needs --cells, --models and --arms");
      return { calls: replicationPlan(label, args.cells, args.models, args.arms), cap: CAPS.replication };
    }
  }
}

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

function loadCalls(path: string): BatteryCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as BatteryCall);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8")) as { id: string; provider: string; host: string; model_string?: string }[];
  const keys = loadApiKeysFromEnv();

  const resuming = args.resume !== undefined;
  const runId = args.resume ?? `${args.kind}${args.label !== undefined ? `-${args.label}` : ""}-${stamp()}`;
  const dir = join(BATTERY_DIR, runId);
  const callsPath = join(dir, "calls.jsonl");
  const manifestPath = join(dir, "manifest.json");

  let kindArgs = args;
  if (resuming) {
    if (!existsSync(manifestPath)) throw new Error(`no run ${runId} under ${BATTERY_DIR}`);
    const m = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    kindArgs = { ...args, kind: m.kind, cells: m.plan.cells, models: m.plan.models, arms: m.plan.arms, label: m.kind === "replicate" ? runId : args.label };
  }
  const { calls: plan, cap } = planFor(kindArgs, runId);

  // The screens every call in the plan uses, built once; their hashes are the manifest's proof of what was shown.
  const cellsUsed = [...new Set(plan.map((c) => c.cell))];
  const screens = new Map(cellsUsed.map((id) => [id, buildCellScreen(id)]));
  const promptOf = (cell: CellId, arm: Arm): string => armPrompt(screens.get(cell)!.prompt, arm);

  const fingerprint = rulesFingerprint();
  const manifest: Manifest = {
    runId,
    kind: kindArgs.kind,
    createdAt: new Date().toISOString(),
    gitHead: gitHead(),
    instrumentVersion: LAB_INSTRUMENT_VERSION,
    capUsd: cap,
    rulesFingerprint: fingerprint,
    sampling: "Provider default sampling: no temperature, top_p or top_k is sent in any arm (docs/marketplace_plan.md §14.2). Thinking: none requested in arms A and B; arm C asks sonnet-5 for display \"summarized\" and haiku-4-5 for manual thinking, budget 2,048 tokens.",
    samplesPerCell: SAMPLES_PER_CELL,
    plannedCalls: plan.length,
    cells: Object.fromEntries(
      cellsUsed.map((id) => {
        const s = screens.get(id)!;
        return [
          id,
          {
            change: CELLS[id].change,
            against: CELLS[id].against,
            trader: s.trader,
            seed: s.seed,
            round: s.round,
            printByRound: s.printByRound,
            heldUsdcMinor: s.held.usdcMinor.toString(),
            heldFsiuMilliSiu: s.held.fsiuMilliSiu.toString(),
            promptSha256: Object.fromEntries(ARMS.map((a) => [a, sha256(promptOf(id, a))])) as Record<Arm, string>,
            notes: s.notes,
          },
        ];
      }),
    ),
    plan: { cells: cellsUsed, models: [...new Set(plan.map((c) => c.model))], arms: [...new Set(plan.map((c) => c.arm))] },
  };

  mkdirSync(dir, { recursive: true });
  const done = loadCalls(callsPath);
  if (resuming) {
    const before = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
    if (before.rulesFingerprint !== fingerprint) throw new Error("the reason rules are not the ones this run started with; refusing to resume");
    for (const id of cellsUsed) {
      for (const a of ARMS) {
        if (before.cells[id]?.promptSha256[a] !== manifest.cells[id].promptSha256[a]) throw new Error(`cell ${id} arm ${a} no longer renders the prompt this run started with; refusing to resume`);
      }
    }
  } else {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const doneKeys = new Set(done.map((c) => c.key));
  const todo = plan.filter((c) => !doneKeys.has(c.key));
  const spentSoFar = done.reduce((s, c) => addUsd(s, c.usd), "0");
  const remainingCap = decimalToUnits(cap, 9) - decimalToUnits(spentSoFar, 9);
  if (remainingCap <= 0n) throw new Error(`run ${runId} has already spent its cap of $${cap}`);
  const leftUnderCap = assertCreditGuard(unitsToDecimal(remainingCap, 9));
  console.log(`Run ${runId}: ${plan.length} calls planned, ${done.length} already done, ${todo.length} to make. Cap $${cap}. Credit guard: $${leftUnderCap} left under the cycle cap after this run's cap.`);
  console.log(`Rules fingerprint ${fingerprint.slice(0, 16)}…  git ${manifest.gitHead.slice(0, 10)}  instrument v${LAB_INSTRUMENT_VERSION}\n`);

  const adapters = new Map<BatteryModel, { adapter: Adapter; apiName: string }>();
  for (const id of new Set(plan.map((c) => c.model))) {
    const entry = registry.find((r) => r.id === id);
    if (entry === undefined) throw new Error(`"${id}" is not a registered model.`);
    adapters.set(id, { adapter: withRetry(createAdapterFor({ provider: entry.provider, host: entry.host }, keys)), apiName: entry.model_string ?? id });
  }

  const all: BatteryCall[] = [...done];
  let stopReason: string | undefined;
  let queue = 0;
  // What the ledger already holds for this run, so a resumed run enters only the spend it has not entered.
  const ledgerWhat = `probe battery ${runId}`;
  let recorded = loadSpendLedger().entries.filter((e) => e.what === ledgerWhat).reduce((s, e) => addUsd(s, e.usd), "0");
  const flushSpend = (): void => {
    const total = all.reduce((s, c) => addUsd(s, c.usd), "0");
    const delta = decimalToUnits(total, 9) - decimalToUnits(recorded, 9);
    if (delta <= 0n) return;
    recordSpend({ at: new Date().toISOString(), usd: unitsToDecimal(delta, 9), what: ledgerWhat });
    recorded = total;
  };
  process.on("SIGINT", () => {
    stopReason = "interrupted";
  });

  const one = async (spec: CallSpec): Promise<void> => {
    const { adapter, apiName } = adapters.get(spec.model)!;
    const prompt = promptOf(spec.cell, spec.arm);
    const price = PRICES[spec.model];
    const base = { ...spec, at: new Date().toISOString(), promptSha256: sha256(prompt) };
    let rec: BatteryCall;
    try {
      const r = await adapter(apiName, prompt, paramsFor(spec.model, spec.arm));
      const thinking = extractThinking(r.raw);
      rec = {
        ...base,
        latencyMs: r.latency_ms,
        reply: r.text,
        parsed: parseBatteryReply(r.text, spec.arm),
        ...(thinking !== undefined ? { thinking } : {}),
        usage: r.usage,
        usd: callCostUsd(r.usage, price.priceInUsdPer1M, price.priceOutUsdPer1M),
        ...(r.sent !== undefined ? { sent: r.sent } : {}),
        ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
        deviations: r.deviations,
      };
    } catch (err) {
      rec = { ...base, latencyMs: 0, reply: "", parsed: { outcome: "unparsed" }, usage: { input: 0, output: 0, cached_input: 0, reasoning: 0 }, usd: "0", deviations: [], error: err instanceof Error ? err.message : String(err) };
    }
    appendFileSync(callsPath, `${JSON.stringify(rec)}\n`);
    all.push(rec);
    if (all.length % 100 === 0) flushSpend();
    const decision = evaluateStop(all.filter((c) => c.label === runId), cap);
    if (decision.stop && stopReason === undefined) stopReason = decision.reason;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopReason !== undefined) return;
      const spec = todo[queue++];
      if (spec === undefined) return;
      await one(spec);
    }
  };
  const started = Date.now();
  try {
    await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));
  } finally {
    flushSpend();
  }

  const mine = all.filter((c) => c.label === runId);
  const total = mine.reduce((s, c) => addUsd(s, c.usd), "0");
  console.log(`\n${mine.length} of ${plan.length} calls made in ${Math.round((Date.now() - started) / 1000)}s, $${total} spent (cap $${cap}).`);
  for (const model of BATTERY_MODELS) {
    for (const arm of ARMS) {
      const m = mine.filter((c) => c.model === model && c.arm === arm);
      if (m.length === 0) continue;
      const n = (o: string): number => m.filter((c) => c.parsed.outcome === o).length;
      console.log(`  ${model} arm ${arm}: ${m.length} calls, ${n("payment")} payments, ${n("not_payment")} not a payment, ${n("unparsed")} unparsed, $${m.reduce((s, c) => addUsd(s, c.usd), "0")}`);
    }
  }
  if (stopReason !== undefined) {
    console.log(`\nSTOPPED: ${stopReason}. Resume with --resume ${runId} only after reading why.`);
    process.exit(2);
  }
  console.log(`\nComplete. Saved ${callsPath}.`);
  if (args.kind === "pilot") {
    console.log("\nPILOT — every reply, to read before any real call:");
    for (const c of mine) {
      console.log(`\n[${c.model} arm ${c.arm} ${c.cell}] ${c.parsed.outcome}${c.parsed.route !== undefined ? ` (${c.parsed.route})` : ""} ${c.parsed.tool ?? ""}  sent=${JSON.stringify(c.sent)} usage=${JSON.stringify(c.usage)} $${c.usd} stop=${c.stopReason ?? "-"}`);
      console.log(`  reply: ${c.reply.slice(0, 700).replace(/\n/g, "\n         ")}`);
      if (c.parsed.statedReason !== undefined) console.log(`  stated reason: ${c.parsed.statedReason}`);
      if (c.thinking !== undefined) console.log(`  thinking: ${c.thinking.slice(0, 700).replace(/\n/g, "\n            ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
