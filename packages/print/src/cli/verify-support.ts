import { readdir } from "node:fs/promises";
import type { Print } from "@touchstone/sdk";
import { TASK_CLASSES, BASKET_VERSION } from "@touchstone/basket";
import type { RoundingRules } from "../rounding.js";
import { cachePolicyVariant, batchDiscountVariant } from "../compute/sensitivity.js";
import type { PrintInput } from "../compute/index.js";
import type { Discrepancy } from "../verify.js";
import {
  buildModelInputs,
  loadCarryForwardHistory,
  loadDeclaredRunRecords,
  loadPriceSnapshot,
  loadRegistry,
  loadRunManifest,
  printsDir,
  runsDirFor,
} from "./load-inputs.js";

export interface BuiltVerifyInput {
  input?: PrintInput;
  manifestDiscrepancy?: Discrepancy;
  loadErrorMessage?: string;
}

/**
 * Builds `verifyPrint`'s own recomputation input for a real, already-published print — shared
 * by cli/verify.ts (one print) and cli/verify-all.ts (every print), so the two can never quietly
 * drift apart on how a print's own historical rules are reconstructed. Recomputes from the runs
 * and the snapshot the print itself references — not the latest snapshot — and from the print's
 * own historical `rounding`/carry-forward/median-diagnostic opt-ins, never today's defaults;
 * verifying against today's rules would "fail" every correct historical print (found live,
 * 2026-09-26 — this is exactly the class of bug this extraction exists to stop recurring).
 */
export async function buildVerifyInput(print: Print): Promise<BuiltVerifyInput> {
  let manifestDiscrepancy: Discrepancy | undefined;
  try {
    const registry = await loadRegistry();
    const snapshot = await loadPriceSnapshot(print.price_snapshot_ref);

    // Found live, 2026-09-26: a tier series print (print.series set) never gets its own run
    // manifest — cli/publish.ts's tier loop calls publishPrint without runsDirPath, by design
    // (design-doc §4a: "published alongside the blended Dated SIU from the same executed runs,
    // at no additional measurement cost" — one harness run, one manifest, both series and the
    // blend read the same records). Looking records up by print.print_id itself (e.g.
    // "2026-09-14-frontier") always threw "no run manifest", which every prior version of this
    // function's caller (cli/verify.ts) silently swallowed into a signature-only check — so
    // every tier print ever published had reported "OK" without its recomputation ever actually
    // running, not even once. Fixed: load records from the underlying blended print_id instead,
    // then filter to this tier's own registered models exactly as cli/publish.ts's own tier loop
    // does (open_weights true = commodity, false = frontier).
    const baseRunsPrintId = print.series
      ? print.print_id.replace(/-frontier$|-commodity$/, "")
      : print.print_id;
    const records = await loadDeclaredRunRecords(baseRunsPrintId);

    // Declared-vs-actual drift check: the manifest is supposed to be the authoritative list of
    // this print's constituent run records (docs/methodology.md), but nothing stops the directory
    // from later holding more or fewer files than it declares — e.g. hand-editing, a partial sync.
    // Surfacing that here, not just documenting the intent, is what makes it a check.
    try {
      const manifest = await loadRunManifest(baseRunsPrintId);
      const onDisk = (await readdir(runsDirFor(baseRunsPrintId))).filter(
        (f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "index.json",
      );
      const declared = [...manifest.run_records].sort();
      const actual = [...onDisk].sort();
      if (JSON.stringify(declared) !== JSON.stringify(actual)) {
        manifestDiscrepancy = {
          field: "run_manifest",
          published: declared.join(", "),
          recomputed: actual.join(", "),
        };
      }
    } catch (manifestErr) {
      console.warn(
        `Could not check the run manifest (${manifestErr instanceof Error ? manifestErr.message : String(manifestErr)}).`,
      );
    }

    const { models: allModels } = buildModelInputs(registry, snapshot, records);
    // Same tier split cli/publish.ts's own tier loop uses — a standalone tier print is already
    // single-tier by construction, so recomputing it from the full, unfiltered registry would
    // both price models this series never included and silently change the qualifying set.
    const openWeightsById = new Map(registry.map((r) => [r.id, r.open_weights]));
    const models = print.series
      ? allModels.filter((m) => openWeightsById.get(m.model_id) === (print.series === "commodity"))
      : allModels;
    const allModelIds = models.map((m) => m.model_id);

    // Carry-forward only ever applied from rules-2026-09-26 onward — gated on this print's own
    // declared methodology_revision, not its date, because a print dated 2026-09-26 can still
    // have been computed and signed under rules-2026-09-25 (the fix landed later the same day;
    // see docs/methodology.md's rules-2026-09-25b entry for the same class of same-day edge
    // case). Applying carry-forward to a print that was never computed with it would recompute a
    // different qualifying set than the one actually signed — a false discrepancy, not a real one.
    const revisionDate = print.methodology_revision?.match(/^rules-(\d{4}-\d{2}-\d{2})/)?.[1];
    const carryForwardApplies = !print.series && revisionDate !== undefined && revisionDate >= "2026-09-26";

    const input: PrintInput = {
      version: BASKET_VERSION,
      print_id: print.print_id,
      date: print.date,
      status: print.status,
      classWeights: {
        T1: TASK_CLASSES.T1.weight,
        T2: TASK_CLASSES.T2.weight,
        T3: TASK_CLASSES.T3.weight,
      },
      models,
      // Found live, 2026-09-26: never passing this meant every print published before the
      // 2026-09-25 significant-figures rounding fix (dated_siu_dp: 4, not dated_siu_sig_figs: 4)
      // was recomputed under TODAY's rounding rule regardless — a real verifier bug producing a
      // dated_siu (and, via it, every spread_to_index/market_spread) mismatch that has nothing to
      // do with the print's own correctness. A print's own rounding is exactly what
      // roundDatedSiu/computePrint already key off; verify simply never supplied it.
      // Cast: the generated schema type widens mode/siu_per_usd_mode to `string` (the schema
      // itself never enum-restricted them) — every real print's own field is one of the two
      // literal values RoundingRules actually requires, enforced at the point it was published.
      rounding: print.rounding as RoundingRules,
      ...(carryForwardApplies
        ? { carryForwardHistory: await loadCarryForwardHistory(printsDir(), print.date) }
        : {}),
      // Reproduce the same opt-in this print itself declares, not a revision-date guess — direct
      // and precise, since the published print is the ground truth for whether it carries the
      // field at all (see PrintInput.publishMedianDiagnostic's own doc comment).
      publishMedianDiagnostic: print.dated_siu_median_diagnostic !== undefined,
      price_snapshot_ref: print.price_snapshot_ref,
      methodology_version: print.methodology_version,
      sensitivityVariants: [
        cachePolicyVariant({
          cachedFraction: "0.40",
          cachedPriceRatio: "0.10",
          appliesTo: allModelIds,
          taskClasses: ["T2" as const],
        }),
        batchDiscountVariant({ discount: "0.50", appliesTo: allModelIds }),
      ],
    };

    return { input, manifestDiscrepancy };
  } catch (err) {
    return {
      manifestDiscrepancy,
      loadErrorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
