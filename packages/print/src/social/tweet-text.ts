import type { Print } from "@touchstone/sdk";

/** Same rule every other surface (site, console) already follows — docs/methodology.md §7:
 * "final" is presence of a reconciliation record, never print.status (permanently "provisional"
 * on the signed body itself). */
export function composeTweetText(print: Print, isFinal: boolean): string {
  const status = isFinal ? "final" : "provisional";
  return `Dated SIU — $${print.dated_siu} (${print.date}, ${status}).\nhttps://prints.touchstoneassay.com/prints/${print.print_id}`;
}
