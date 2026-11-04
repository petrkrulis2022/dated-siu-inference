/**
 * `pnpm --filter @touchstone/cr-lab run cr-print [-- --days 2026-10-17,2026-10-18] [--records <private records dir>]`: WP0's figures from the stored snapshot-mode records (no model call, no Blockworks request).
 *
 * The issuer models are the owner's choices: Frontier claude-sonnet-5 (D84), Commodity claude-haiku-5-5 (2026-11-04, qualifying per task type, D124). Writes the result, which holds
 * only costs, counts and pass rates (no Blockworks figure), to `data/lab/cr/economy/cr-print.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DecimalValue } from "@touchstone/sdk";
import { crPrint, dailyCosts, haircut, modelCost, type Grade } from "../economy/cr-print.js";
import { CR_PUBLIC_DIR } from "../paths.js";
import { loadRegistryAndPrices, priceFor } from "../runner/prices.js";
import { FileRecordStore } from "../runner/records.js";
import { TASKS } from "../tasks/instances.js";

const ISSUERS: readonly { model: string; grade: Grade }[] = [
  { model: "claude-sonnet-5", grade: "frontier" },
  { model: "claude-haiku-5-5", grade: "commodity" },
];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

// `--records <dir>` reads another worktree's private records (the live trial's), never copying them
const store = new FileRecordStore(arg("--records"));
const records = store.windows().flatMap((w) => store.forWindow(w));
const { snapshot } = loadRegistryAndPrices();
const fix = (d: DecimalValue | undefined, dp = 9): string | null =>
  d === undefined ? null : d.toFixed(dp);

const out = ISSUERS.map(({ model, grade }) => {
  const days =
    arg("--days")?.split(",") ??
    [
      ...new Set(
        records
          .filter((r) => r.model === model && (r.part === "snapshot" || r.part === "dry-run"))
          .map((r) => r.window),
      ),
    ].sort();
  const price = priceFor(model, snapshot);
  const c = modelCost(records, model, grade, days, price);
  const h = haircut(dailyCosts(records, model, grade, days, price), "1");
  return { c, h };
});

const prints = (["frontier", "commodity"] as const).map((g) =>
  crPrint(
    out.map((o) => o.c),
    g,
  ),
);

for (const { c, h } of out) {
  console.log(`\n${c.model} (${c.grade}), days ${c.days.join(", ")}`);
  for (const t of TASKS) {
    const r = c.perType[t];
    console.log(
      `  ${t}  ${r.passes}/${r.answers} passed (${r.passRate === undefined ? "-" : r.passRate.times(100).toFixed(1)}%)  headline cost $${r.costUsd.toFixed(6)}${r.notDerivable ? `  (${r.notDerivable} not derivable, left out)` : ""}  ${r.qualified ? "QUALIFIES" : "does not qualify"}`,
    );
  }
  console.log(
    `  cost per SIU $${fix(c.costPerSiu, 6) ?? "none"}; measured rate ${fix(c.measuredRate, 3) ?? "none"} SIU per USD; issues for ${c.qualifiedTasks.join(", ") || "nothing"}`,
  );
  console.log(
    `  haircut: ${h.pairs} day-to-day pairs, p95 rise ${h.p95Rise.times(100).toFixed(2)}%, so a budget keeps ${h.budgetAfterHaircutUsd.times(100).toFixed(2)}% of itself`,
  );
}
for (const p of prints)
  console.log(
    `\nCR lab print (${p.grade}): ${p.usdPerSiu === undefined ? "NONE (no issuer with a cost per SIU)" : `$${p.usdPerSiu} per SIU (${String(p.nanoUsdPerSiu)} nano-USD)`} from ${p.issuers.join(", ") || "-"}`,
  );

const file = join(CR_PUBLIC_DIR, "economy", "cr-print.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  `${JSON.stringify(
    {
      note: "WP0 (docs/part5-build-plan.md §4.1). Costs, counts and pass rates from the trial's stored snapshot-mode records only; no Blockworks figure. Headline cost basis (D113). Exact decimals as strings; the print is rounded once, half up, to nano-USD.",
      computedAt: new Date().toISOString(),
      issuers: out.map(({ c, h }) => ({
        model: c.model,
        grade: c.grade,
        days: c.days,
        perType: Object.fromEntries(
          TASKS.map((t) => {
            const r = c.perType[t];
            return [
              t,
              {
                answers: r.answers,
                passes: r.passes,
                notDerivable: r.notDerivable,
                headlineCostUsd: r.costUsd.toFixed(9),
                passRate: fix(r.passRate, 6),
                qualified: r.qualified,
              },
            ];
          }),
        ),
        costPerSiuUsd: fix(c.costPerSiu),
        measuredRateSiuPerUsd: fix(c.measuredRate),
        qualifiedTasks: c.qualifiedTasks,
        haircut: {
          pairs: h.pairs,
          p95Rise: h.p95Rise.toFixed(9),
          budgetMultiplier: h.budgetAfterHaircutUsd.toFixed(9),
        },
      })),
      prints: prints.map((p) => ({
        grade: p.grade,
        basket: p.basket,
        issuers: p.issuers,
        withoutCost: p.withoutCost,
        usdPerSiu: p.usdPerSiu ?? null,
        nanoUsdPerSiu: p.nanoUsdPerSiu === undefined ? null : String(p.nanoUsdPerSiu),
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(`\nwritten: ${file}`);
