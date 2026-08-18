import type { Print, PriceSnapshot } from "@touchstone/sdk";
import { D, callCost } from "@touchstone/print";

type ExchangeRateRow = Print["exchange_rate_table"][number];
type PriceEntry = PriceSnapshot["entries"][number];

export interface ConvertInput {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface ConvertOutput {
  siu: string;
  usd: string;
}

/**
 * convert(model, input_tokens, output_tokens) — build1-spec.md §9: "SIU + USD equivalent." No
 * new pricing logic: the dollar cost comes from the print's own referenced price snapshot (the
 * same `callCost` arithmetic @touchstone/print uses to build a print in the first place), and the
 * SIU figure comes from the print's own published `usd_per_siu` for that model — never a
 * separately-invented rate.
 *
 * Takes an already-loaded `print` and `snapshot` rather than reading `data/` itself — the I/O
 * (which price snapshot a print references, resolving it from `data/registry/`) lives in
 * server.ts, so this function's arithmetic is testable with plain fixtures and no filesystem.
 */
export function convertTool(
  input: ConvertInput,
  print: Print,
  snapshot: PriceSnapshot,
): ConvertOutput {
  const row = print.exchange_rate_table.find((r: ExchangeRateRow) => r.model_id === input.model);
  if (!row || row.usd_per_siu === undefined) {
    throw new Error(
      `Model "${input.model}" has no published exchange rate in print ${print.print_id}` +
        (row?.excluded_reason ? ` (${row.excluded_reason}).` : "."),
    );
  }

  const priceEntry = snapshot.entries.find((e: PriceEntry) => e.model_id === input.model);
  if (!priceEntry) {
    throw new Error(
      `Model "${input.model}" has no price in the snapshot print ${print.print_id} referenced (${print.price_snapshot_ref}).`,
    );
  }

  const usd = callCost(
    input.input_tokens,
    input.output_tokens,
    priceEntry.price_in_usd_per_1m,
    priceEntry.price_out_usd_per_1m,
  );
  const siu = usd.dividedBy(new D(row.usd_per_siu));

  return { siu: siu.toString(), usd: usd.toString() };
}
