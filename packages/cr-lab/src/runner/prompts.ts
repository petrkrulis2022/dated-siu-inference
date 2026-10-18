/**
 * The snapshot-mode prompts (§16.7): fixed instructions, the output schema, and only the fields of the day's snapshot that the task needs, trimmed to keep input cost down.
 *
 * A prompt is a pure function of the instance and the day's data, so the same day gives the same prompt byte for byte; its hash is recorded with the answer. It never contains
 * the reference answer, only the inputs from which the reference solver derives it. Two choices keep the prompt small, and both are stated to the model:
 *  - CR-VS shows each venue's volume per calendar month, summed by us from the daily series by the same function the reference solver uses (`vsMonthly`), not 365 daily values per venue;
 *  - CR-SM shows only the ids that have a figure on both dates, which are exactly the ids the reference solver ranks.
 * Figures are printed as plain decimals built from the source text (invariant 4); nothing is rounded here.
 */
import { createHash } from "node:crypto";
import type { DecimalValue } from "@touchstone/sdk";
import { addDays, daysBetween } from "../data-desk/dates.js";
import type { DayData } from "../tasks/day-data.js";
import type { Instance } from "../tasks/instances.js";
import type { SMReference, UOReference, VSReference } from "../tasks/solve.js";
import { smRows, vsMonthly } from "../tasks/solve.js";

export interface PromptBundle {
  /** the complete prompt, sent as one user message */
  text: string;
  /** sha256 of the data block alone: the figures the model was shown */
  dataSha256: string;
  /** sha256 of the complete prompt */
  promptSha256: string;
  /** a rough size for projecting cost before the call (characters / 4), never billed */
  approxTokens: number;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const COMMON = [
  "You are completing one data task. Use only the data given below; do not use outside knowledge of these figures.",
  "Reply with a single JSON object and nothing else: no explanation before or after it.",
  "Write every figure as a plain decimal, either a JSON number or a decimal string: no exponent, no units, no thousands separators.",
].join("\n");

const line = (o: unknown): string => JSON.stringify(o);

/** The answer schema of a task, in the words both modes give the model; the schema does not depend on the data. */
export function schemaFor(instance: Instance): string {
  switch (instance.task) {
    case "CR-VS":
      return [
        'Answer schema: {"venues": [five venue ids, largest total first], "shares": {"YYYY-MM": {"<venue id>": <percent>, ... five venues}, ... all twelve months}}',
        `The twelve month keys are ${(instance.reference as VSReference).months.join(", ")}.`,
      ].join("\n");
    case "CR-PL":
      return 'Answer schema: {"fees": <usd>, "payouts": <usd>, "revenue": <usd>}';
    case "CR-UO":
      return 'Answer schema: {"unlock30_pct": <percent>, "unlock90_pct": <percent>}';
    case "CR-SM":
      return `Answer schema: {"top5": [{"id": "<${instance.params.dimension} id>", "change_usd": <signed usd>}, ... five entries, largest absolute change first]}`;
  }
}

/** Task text, schema and data block for one instance. */
function pieces(
  instance: Instance,
  day: DayData,
): { task: string; schema: string; data: string } | undefined {
  switch (instance.task) {
    case "CR-VS": {
      const { months, venues } = vsMonthly(day, instance.params.endMonth);
      const ref = instance.reference as VSReference;
      const first = months[0]?.month ?? "";
      const last = months[months.length - 1]?.month ?? "";
      const rows = [...venues.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([venue, sums]) =>
          line({
            venue,
            monthly_volume_usd: Object.fromEntries(
              months.map((m, i) => [m.month, (sums[i] as DecimalValue).toFixed()]),
            ),
          }),
        );
      return {
        task: [
          `Task: perpetual-futures DEX volume share, ${first} to ${last}.`,
          `Find the five venues with the largest total volume over the twelve calendar months ${first} to ${last} (the sum of the twelve monthly figures).`,
          `Then, for each of those twelve months, give each of the five venues' share of the five venues' combined volume in that month, as a percentage (so the five shares of a month add up to 100).`,
          "The monthly figures below were summed by us from daily USD volume; a day with no reported figure adds nothing. Venues are listed alphabetically.",
        ].join("\n"),
        schema: schemaFor(instance),
        data: rows.join("\n"),
      };
    }
    case "CR-PL": {
      const series = day.lending.get(instance.params.protocolId);
      if (series === undefined) return undefined;
      const { protocolId, quarter, start, end } = instance.params;
      const rows: string[] = [];
      for (let d = start; daysBetween(d, end) > 0; d = addDays(d, 1)) {
        const p = series.get(d);
        if (p === undefined) return undefined;
        rows.push(
          line({
            date: d,
            fees_usd: p.fees?.toFixed() ?? null,
            revenue_usd: p.revenue?.toFixed() ?? null,
            interest_usd: p.interest?.toFixed() ?? null,
            net_interest_income_usd: p.nii?.toFixed() ?? null,
          }),
        );
      }
      return {
        task: [
          `Task: lending protocol profit and loss, protocol "${protocolId}", quarter ${quarter} (${start} to ${addDays(end, -1)}, every day included).`,
          "Give the quarter's total for three figures, in USD:",
          "- fees: the sum of fees_usd over the quarter;",
          "- payouts: what the protocol paid depositors and liquidity providers, which is the sum of interest_usd minus the sum of net_interest_income_usd;",
          "- revenue: fees minus payouts, computed from your own two figures (it must equal them exactly).",
        ].join("\n"),
        schema: schemaFor(instance),
        data: rows.join("\n"),
      };
    }
    case "CR-UO": {
      const sched = day.schedules.get(instance.params.slug);
      const id = day.tokenIds.get(instance.params.slug);
      if (sched === undefined || id === undefined) return undefined;
      const supply = day.supply.get(id)?.get(day.window);
      if (supply === null || supply === undefined) return undefined;
      const rows = sched.days
        .slice(0, 90)
        .map((d) => line({ date: d.day, tokens_unlocking: d.native.toFixed() }));
      return {
        task: [
          `Task: unlock overhang for the token "${instance.params.slug}" on ${day.window}.`,
          `The token's circulating supply on ${day.window} is ${supply.toFixed()} tokens.`,
          `Below is the daily unlock schedule, one row per day starting with ${day.window}: the tokens that unlock on that day.`,
          `Give the tokens unlocking in the next 30 days (the first 30 rows) and in the next 90 days (the first 90 rows), each as a percentage of that circulating supply (so 1.5 means one and a half percent).`,
        ].join("\n"),
        schema: schemaFor(instance),
        data: rows.join("\n"),
      };
    }
    case "CR-SM": {
      const { dimension } = instance.params;
      const { start, end, rows: usable } = smRows(day, dimension);
      const rows = [...usable]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((r) =>
          line({ id: r.id, supply_usd_start: r.first.toFixed(), supply_usd_end: r.last.toFixed() }),
        );
      return {
        task: [
          `Task: stablecoin movers by ${dimension}, ${start} to ${end}.`,
          `Each row gives the circulating supply of the stablecoins of one ${dimension}, in USD, on ${start} (supply_usd_start) and on ${end} (supply_usd_end), as valued by the data provider (a stablecoin that trades below one dollar is valued below its token count, so it can show as a fall). ${end} is the latest day the data provider had published when the data was pulled.`,
          `The change of a row is supply_usd_end minus supply_usd_start, signed. Find the five ${dimension}s with the largest absolute change, in order from largest to smallest absolute change (break ties by id, ascending), and give each one's signed change in USD.`,
          "Only ids that have a figure on both dates are listed.",
        ].join("\n"),
        schema: schemaFor(instance),
        data: rows.join("\n"),
      };
    }
  }
}

/** The prompt for one instance, or undefined when the day's data cannot supply it (the generator should not have offered it). */
export function buildPrompt(instance: Instance, day: DayData): PromptBundle | undefined {
  const p = pieces(instance, day);
  if (p === undefined) return undefined;
  const text = [
    COMMON,
    "",
    p.task,
    "",
    p.schema,
    "",
    "Data (one JSON object per line):",
    p.data,
    "",
    "Reply with the JSON object only.",
  ].join("\n");
  return {
    text,
    dataSha256: sha256(p.data),
    promptSha256: sha256(text),
    approxTokens: Math.max(1, Math.ceil(text.length / 4)),
  };
}

/**
 * A correct answer in the task's schema, written from the reference. Used only by tests and by the fixture dry run (an "answers perfectly" stand-in model); a live run never
 * reads an instance's reference except to grade.
 */
export function referenceAnswerJson(instance: Instance): string {
  switch (instance.task) {
    case "CR-VS": {
      const ref = instance.reference as VSReference;
      return JSON.stringify({ venues: ref.venues, shares: ref.shares });
    }
    case "CR-PL":
      return JSON.stringify(instance.reference);
    case "CR-UO": {
      const ref = instance.reference as UOReference;
      return JSON.stringify({ unlock30_pct: ref.unlock30Pct, unlock90_pct: ref.unlock90Pct });
    }
    case "CR-SM": {
      const ref = instance.reference as SMReference;
      return JSON.stringify({
        top5: ref.top5.map((r) => ({ id: r.id, change_usd: r.changeUsd })),
      });
    }
  }
}
