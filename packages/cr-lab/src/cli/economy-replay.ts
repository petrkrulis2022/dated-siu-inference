/**
 * `pnpm --filter @touchstone/cr-lab run economy-replay -- [--seed dw1-0] [--windows 3] [--rpc-url http://127.0.0.1:8545] [--json <path>]`
 *
 * Development window DW1 (`docs/part5-build-plan.md` §6): runs scripted windows on the memory ledger (scripted agents, stand-in data, no spend), replays the window's journal onto the
 * real contracts on a local anvil chain, and compares every balance. Starts its own anvil unless `--rpc-url` names a local one (chain id 31337 only). Needs anvil and forge on PATH.
 * Prints the summary, the findings and the diff; exits 1 if either is not empty.
 */
import { writeFileSync } from "node:fs";
import { replayOnAnvil, scriptedWindows } from "../economy/chain-replay.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const seed = arg("--seed", "dw1-0") as string;
const windows = Number(arg("--windows", "3"));
const rpcUrl = arg("--rpc-url");
const jsonPath = arg("--json");

const world = await scriptedWindows(
  seed,
  Array.from({ length: windows }, (_, i) => i + 1),
);
const ops = new Map<string, number>();
for (const e of world.chain.journal) ops.set(e.op, (ops.get(e.op) ?? 0) + 1);
const result = await replayOnAnvil(world.chain, rpcUrl === undefined ? {} : { rpcUrl });

console.log(
  `DW1, seed ${seed}, ${windows} window(s): ${result.replayed} of ${result.entries} journal entries replayed in ${result.transactions} transactions on anvil`,
);
console.log(`journal: ${[...ops].map(([op, n]) => `${op} ${n}`).join(", ")}`);
console.log(`findings: ${result.findings.length}; diff rows: ${result.diff.length}`);
for (const f of result.findings) console.log(JSON.stringify(f, null, 1));
for (const r of result.diff)
  console.log(`  ${r.what} ${r.key}: memory ${r.memory}, chain ${r.chain}`);
if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(result, null, 1)}\n`);
process.exitCode = result.findings.length === 0 && result.diff.length === 0 ? 0 : 1;
