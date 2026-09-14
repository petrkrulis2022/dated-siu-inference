import type { Print } from "@touchstone/sdk";

/**
 * Model count is derived from the print's own exchange_rate_table (excluded_reason absent =
 * qualified), never hardcoded — registry composition changes over time (models get admitted or
 * excluded), and a fixed number in this template would silently go stale the next time it does.
 */
export function composeTweetText(print: Print): string {
  const modelCount = print.exchange_rate_table.filter((row) => !row.excluded_reason).length;
  return (
    `Dated SIU today: $${print.dated_siu}\n` +
    `The benchmark price of one unit of completed AI work — a fixed basket of tasks, measured ` +
    `across ${modelCount} models by actually buying the inference and reconciling against invoices.\n` +
    `Published daily. Signed. Anchored on Base.\n` +
    `https://prints.touchstoneassay.com`
  );
}
