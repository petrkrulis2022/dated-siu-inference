/**
 * Stand-in models for trying the runner without spending anything: adapters that read only the PROMPT TEXT, as a model would, and reply. `solverFromPrompt` solves a task from the
 * data block alone, with no access to the instance or its reference; that the answer passes the gate is the proof that a prompt carries everything its question needs and nothing that
 * contradicts the key. The flawed stand-ins damage a correct answer in one named way each, so every class of the failure taxonomy can be produced on demand. None of this calls a provider.
 */
import { AdapterHttpError, type Adapter, type AdapterResult } from "@touchstone/harness";
import { D, roundHalfUp, type DecimalValue } from "@touchstone/sdk";
import type { Seat } from "./run-answer.js";

type Row = Record<string, unknown>;
const dataRows = (prompt: string): Row[] => {
  const after = prompt.split("Data (one JSON object per line):\n")[1] ?? "";
  const body = after.split("\n\nReply with the JSON object only.")[0] ?? "";
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Row);
};
const r6 = (x: DecimalValue): string => roundHalfUp(x, 6);
const sum = (xs: readonly DecimalValue[]): DecimalValue => xs.reduce((a, b) => a.plus(b), new D(0));

/** The correct answer to a snapshot-mode prompt, computed from the prompt alone. */
export function solverFromPrompt(prompt: string): Record<string, unknown> {
  const rows = dataRows(prompt);
  if (prompt.includes("Task: perpetual-futures DEX volume share")) {
    const perVenue = rows.map((r) => ({
      venue: r.venue as string,
      monthly: r.monthly_volume_usd as Record<string, string>,
    }));
    const months = Object.keys(perVenue[0]?.monthly ?? {}).sort();
    const ranked = perVenue
      .map((v) => ({ ...v, total: sum(months.map((m) => new D(v.monthly[m] as string))) }))
      .sort((a, b) => b.total.comparedTo(a.total) || a.venue.localeCompare(b.venue))
      .slice(0, 5);
    const shares: Record<string, Record<string, string>> = {};
    for (const m of months) {
      const denom = sum(ranked.map((v) => new D(v.monthly[m] as string)));
      shares[m] = Object.fromEntries(
        ranked.map((v) => [v.venue, r6(new D(v.monthly[m] as string).div(denom).times(100))]),
      );
    }
    return { venues: ranked.map((v) => v.venue), shares };
  }
  if (prompt.includes("Task: lending protocol profit and loss")) {
    const col = (k: string) => sum(rows.map((r) => new D(r[k] as string)));
    const fees = r6(col("fees_usd"));
    const payouts = r6(col("interest_usd").minus(col("net_interest_income_usd")));
    return { fees, payouts, revenue: new D(fees).minus(payouts).toFixed() };
  }
  if (prompt.includes("Task: unlock overhang")) {
    const m = /circulating supply on \d{4}-\d{2}-\d{2} is (\S+) tokens/.exec(prompt);
    const supply = new D(m?.[1] ?? "0");
    const tokens = rows.map((r) => new D(r.tokens_unlocking as string));
    return {
      unlock30_pct: r6(sum(tokens.slice(0, 30)).div(supply).times(100)),
      unlock90_pct: r6(sum(tokens.slice(0, 90)).div(supply).times(100)),
    };
  }
  if (prompt.includes("Task: stablecoin movers")) {
    const moved = rows
      .map((r) => ({
        id: r.id as string,
        change: new D(r.supply_usd_end as string).minus(r.supply_usd_start as string),
      }))
      .sort((a, b) => b.change.abs().comparedTo(a.change.abs()) || a.id.localeCompare(b.id))
      .slice(0, 5);
    return { top5: moved.map((x) => ({ id: x.id, change_usd: r6(x.change) })) };
  }
  throw new Error("not a snapshot-mode prompt");
}

export type StandIn = "solver" | "sloppy" | "fenced" | "silent" | "failing" | "truncating";

/** Damages a correct answer in the way a given task makes easy; every damage maps to one taxonomy class. */
function damage(prompt: string, answer: Record<string, unknown>): Record<string, unknown> {
  if (prompt.includes("Task: unlock overhang"))
    return { ...answer, unlock30_pct: new D(answer.unlock30_pct as string).times(10).toFixed() };
  if (prompt.includes("Task: stablecoin movers")) {
    const top = [...(answer.top5 as unknown[])];
    [top[0], top[1]] = [top[1], top[0]];
    return { top5: top };
  }
  if (prompt.includes("Task: perpetual-futures DEX volume share"))
    return { ...answer, venues: (answer.venues as string[]).slice(0, 4) };
  const payouts = new D(answer.payouts as string).times("1.03");
  return {
    fees: answer.fees,
    payouts: r6(payouts),
    revenue: new D(answer.fees as string).minus(r6(payouts)).toFixed(),
  };
}

/** An adapter that answers from the prompt as `kind` says. `usage` follows the sizes, so costs are real arithmetic on made-up token counts. */
export function standInAdapter(kind: StandIn): Adapter {
  return async (_model, prompt): Promise<AdapterResult> => {
    const result = (text: string, stopReason = "end_turn"): AdapterResult => ({
      text,
      usage: {
        input: Math.ceil(prompt.length / 4),
        output: Math.ceil(text.length / 4),
        cached_input: 0,
        reasoning: 0,
      },
      latency_ms: 1,
      raw: {},
      deviations: [],
      stopReason,
    });
    if (kind === "failing") throw new AdapterHttpError("stand-in provider error", 429, {});
    if (kind === "silent") return result("");
    if (kind === "truncating") return result('{"venues": ["a", "b"', "max_tokens");
    const correct = solverFromPrompt(prompt);
    if (kind === "solver") return result(JSON.stringify(correct));
    if (kind === "fenced") return result("```json\n" + JSON.stringify(correct) + "\n```");
    return result(JSON.stringify(damage(prompt, correct)));
  };
}

/** A seat backed by a stand-in; priced as given (default one dollar in, five out per million tokens, so a small answer costs a fraction of a cent). */
export function standInSeat(
  kind: StandIn,
  opts: {
    id?: string;
    provider?: Seat["provider"];
    price?: Seat["price"];
  } = {},
): Seat {
  const provider = opts.provider ?? "anthropic";
  return {
    modelId: opts.id ?? `stand-in-${kind}`,
    modelString: `stand-in/${kind}`,
    provider,
    keyName: `CR_${provider.toUpperCase()}_API_KEY`,
    price: opts.price ?? { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" },
    adapter: standInAdapter(kind),
    params: { temperature: 0, max_tokens: 4000 },
  };
}
