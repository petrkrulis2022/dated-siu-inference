/**
 * The MCP-mode prompt (D101): the same four questions as snapshot mode, but with no data in the prompt. The model is told what is asked, how the figures are defined and what shape to answer in,
 * and must find and read the data itself through the tools. It is not told which tools or models to use: finding them is part of what is measured. A prompt is a pure function of the instance
 * and the snapshot day, and never contains the key.
 */
import { createHash } from "node:crypto";
import { addDays } from "../data-desk/dates.js";
import { schemaFor } from "../runner/prompts.js";
import type { Instance } from "../tasks/instances.js";
import type { VSReference } from "../tasks/solve.js";

export interface McpPrompt {
  text: string;
  promptSha256: string;
  /** a rough size (characters / 4) for projecting cost before a call, never billed */
  approxTokens: number;
}

const COMMON = [
  "You are completing one research task using Blockworks data tools. Use the tools to find and read the data you need; use only data the tools return, and do not rely on outside knowledge of these figures.",
  "Entities are identified by their Blockworks ids: use the ids and series keys the tools give you. A tool refuses a call that asks for too much rather than shortening it, so plan your reads.",
  "When you have the answer, reply with a single JSON object and nothing else: no explanation before or after it.",
  "Write every figure as a plain decimal, either a JSON number or a decimal string: no exponent, no units, no thousands separators.",
].join("\n");

function taskText(instance: Instance, window: string): string {
  switch (instance.task) {
    case "CR-VS": {
      const months = (instance.reference as VSReference).months;
      const first = months[0] ?? "";
      const last = months[months.length - 1] ?? "";
      return [
        `Task: perpetual-futures DEX volume share, ${first} to ${last}.`,
        `Find the five perpetual-futures DEX protocols with the largest total trading volume over the twelve calendar months ${first} to ${last} (the sum of each protocol's daily USD volume; a day with no reported figure adds nothing).`,
        "Then, for each of those twelve months, give each of the five protocols' share of the five protocols' combined volume in that month, as a percentage (so the five shares of a month add up to 100).",
      ].join("\n");
    }
    case "CR-PL": {
      const { protocolId, quarter, start, end } = instance.params;
      return [
        `Task: lending protocol profit and loss, protocol "${protocolId}" (its Blockworks id), quarter ${quarter} (${start} to ${addDays(end, -1)}, every day included).`,
        "Give the quarter's total for three figures, in USD:",
        "- fees: the total fees paid by users, summed over the days of the quarter;",
        "- payouts: what the protocol paid depositors and liquidity providers, which is the interest paid by borrowers minus the net interest income kept by the protocol, each summed over the days of the quarter;",
        "- revenue: fees minus payouts, computed from your own two figures (it must equal them exactly).",
      ].join("\n");
    }
    case "CR-UO":
      return [
        `Task: unlock overhang for the token "${instance.params.slug}" on ${window}.`,
        `Find the tokens unlocking in the next 30 days and in the next 90 days, counting from ${window} (the 30 and the 90 daily unlock amounts beginning with ${window}), and give each as a percentage of the token's circulating supply on ${window} (so 1.5 means one and a half percent).`,
      ].join("\n");
    case "CR-SM": {
      const { dimension } = instance.params;
      const start = addDays(window, -90);
      return [
        `Task: stablecoin movers by ${dimension}, ${start} to the latest day the data provider has published (the snapshot day ${window} or the day before).`,
        `For each ${dimension}, the change is its circulating stablecoin supply in USD on the latest published day minus its supply on ${start}, signed (as valued by the data provider: a stablecoin that trades below one dollar is valued below its token count, so it can show as a fall).`,
        `Find the five ${dimension}s with the largest absolute change, in order from largest to smallest absolute change (break ties by id, ascending), and give each one's signed change in USD. Consider only ids that have a figure on both dates.`,
      ].join("\n");
    }
  }
}

export function buildMcpPrompt(instance: Instance, window: string): McpPrompt {
  const text = [
    COMMON,
    "",
    taskText(instance, window),
    "",
    schemaFor(instance),
    "",
    "Reply with the JSON object only, once you have read the data you need.",
  ].join("\n");
  return {
    text,
    promptSha256: createHash("sha256").update(text).digest("hex"),
    approxTokens: Math.max(1, Math.ceil(text.length / 4)),
  };
}
