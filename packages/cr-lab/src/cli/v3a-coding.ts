/**
 * v3a's blind coding of the account measure (`economy/v3a-coding.ts`). Three steps, each its own command:
 *
 *   `pnpm --filter @touchstone/cr-lab run v3a-coding -- export --logs <log.jsonl,...> --hand-seed <seed> --out-dir <private dir>`
 *     writes `items.json` (every priced decision, agent ids masked, keyed so a key names neither run nor agent), `hand-sample.json` (a seeded 10% for Petr, labels
 *     blank) and `key-map.json` (key -> run, seq, agent: never given to a coder). Free.
 *   `... code --items <items.json> --model <coder model id> --out <codes.json> --yes-spend --ledger <the trial's ledger> [--budgets <path>]`
 *     runs one coder model over the items, each call through the spend ledger's guard. SPENDS MONEY: run it only on the owner's go.
 *   `... kappa --a <codes.json> --b <codes.json> [--hand <hand.json>]`
 *     reports Cohen's kappa between the coders (below 0.7, the account measure is n/a) and each coder against the hand codes. Free.
 *
 * Every output file is new: nothing here overwrites an existing file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { trialKey } from "../keys.js";
import { anthropicChat, anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { openAiChat, openAiChatApi } from "../mcp/openai-loop.js";
import type { ToolChat } from "../mcp/tool-loop.js";
import { loadRegistryAndPrices, priceFor, usageCostUsd } from "../runner/prices.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";
import type { LogEntry } from "../economy/log.js";
import {
  blindItems,
  CODING_INSTRUCTIONS,
  extractPricedDecisions,
  handSample,
  kappa,
  KAPPA_FLOOR,
  modelCoder,
  type BlindItem,
  type UnitLabel,
} from "../economy/v3a-coding.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = arg(name);
  if (v === undefined) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
};
const writeNew = (path: string, data: unknown): void => {
  if (existsSync(path)) throw new Error(`${path} already exists; write to a new path`);
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600, flag: "wx" });
};
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf-8")) as T;

const step = process.argv[2];
if (step === "export") {
  const dir = need("out-dir");
  mkdirSync(dir, { recursive: true });
  const decisions = need("logs")
    .split(",")
    .flatMap((path) =>
      extractPricedDecisions(
        path,
        readFileSync(path, "utf-8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as LogEntry),
      ),
    );
  const items = blindItems(decisions);
  writeNew(join(dir, "items.json"), items);
  writeNew(
    join(dir, "hand-sample.json"),
    handSample(items, need("hand-seed")).map((x) => ({ ...x, label: "" })),
  );
  writeNew(
    join(dir, "key-map.json"),
    decisions.map((d) => ({ key: d.key, run: d.run, seq: d.seq, agent: d.agent, kind: d.kind })),
  );
  console.log(`${items.length} priced decisions; wrote items.json, hand-sample.json (${Math.round(items.length / 10)} or so) and key-map.json to ${dir}`);
} else if (step === "code") {
  if (!process.argv.includes("--yes-spend")) {
    console.error("coding spends real money: add --yes-spend (and --ledger <the trial's ledger>); run it only on the owner's go");
    process.exit(2);
  }
  const model = need("model");
  const ledger = new SpendLedger({ store: new FileLedgerStore(need("ledger")), policy: policyFromBudgets(loadBudgets(arg("budgets"))) });
  const { registry, snapshot } = loadRegistryAndPrices();
  const entry = registry.find((r) => r.id === model);
  if (entry === undefined) throw new Error(`"${model}" is not in the model registry`);
  const chat: ToolChat =
    entry.provider === "anthropic"
      ? anthropicChat(anthropicMessagesApi(trialKey("anthropic")), entry.model_string)
      : entry.provider === "openai"
        ? openAiChat(openAiChatApi(trialKey("openai")), entry.model_string)
        : (() => {
            throw new Error(`no tool chat for ${model} (${entry.provider}) yet`);
          })();
  const keyName = entry.provider === "anthropic" ? "CR_ANTHROPIC_API_KEY" : "CR_OPENAI_API_KEY";
  const coder = modelCoder(chat);
  const price = priceFor(model, snapshot);
  const out: Record<string, UnitLabel> = {};
  for (const item of readJson<BlindItem[]>(need("items"))) {
    const projected = usageCostUsd(
      { input: Math.ceil((CODING_INSTRUCTIONS.length + item.text.length) / 3), output: 2_000, cached_input: 0, reasoning: 0 },
      price,
      chat.provider,
    );
    out[item.key] = await ledger.guard(chat.provider, projected.toFixed(6), { part: "economy", model, key: keyName, what: `v3a coding ${item.key}` }, async () => {
      const label = await coder(item);
      return { usd: projected.toFixed(6), label };
    }).then((r) => r.label);
  }
  writeNew(need("out"), out);
  console.log(`coded ${Object.keys(out).length} decisions with ${model}`);
  void D;
} else if (step === "kappa") {
  const a = new Map(Object.entries(readJson<Record<string, UnitLabel>>(need("a"))));
  const b = new Map(Object.entries(readJson<Record<string, UnitLabel>>(need("b"))));
  const k = kappa(a, b);
  console.log(`coders: kappa ${k.kappa === null ? "n/a" : k.kappa.toFixed(3)} over ${k.n} decisions (${k.agreed} agreed) -- ${k.kappa !== null && k.kappa >= KAPPA_FLOOR ? "usable" : `below ${KAPPA_FLOOR}: the account measure reports n/a`}`);
  const handPath = arg("hand");
  if (handPath !== undefined) {
    const hand = new Map(readJson<{ key: string; label: UnitLabel }[]>(handPath).filter((x) => x.label !== ("" as UnitLabel)).map((x) => [x.key, x.label]));
    console.log(`hand codes (${hand.size}): vs A ${kappa(hand, a).kappa?.toFixed(3) ?? "n/a"}, vs B ${kappa(hand, b).kappa?.toFixed(3) ?? "n/a"}`);
  }
} else {
  console.error("usage: v3a-coding export | code | kappa (see the file's doc comment)");
  process.exit(2);
}
