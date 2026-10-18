import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../data-desk/dates.js";
import { referenceAnswerJson } from "../runner/prompts.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { vsMonthly } from "../tasks/solve.js";
import { FakeMcp } from "./fake-mcp.js";
import { buildMcpPrompt } from "./prompts.js";
import { dayFromRelayed, gradeMcpAnswer, referenceFor, type RelayedCall } from "./relayed.js";

let f: FixtureDay;
let by: Record<string, Instance>;
beforeAll(async () => {
  f = await fixtureDay();
  const all = drawInstances(f.day, "9".repeat(64));
  by = Object.fromEntries(
    ["CR-VS", "CR-PL", "CR-UO", "CR-SM"].map((t) => [t, all.find((i) => i.task === t) as Instance]),
  );
});
afterAll(() => f.cleanup());

const W = () => f.day.window;
const mcp = () => new FakeMcp({ backend: f.backend, today: W() });
const run = async (
  m: FakeMcp,
  calls: [string, Record<string, unknown>][],
): Promise<RelayedCall[]> => {
  const out: RelayedCall[] = [];
  for (const [tool, args] of calls) out.push({ tool, args, ...(await m.call(tool, args)) });
  return out;
};
const answerFor = (i: Instance) => referenceAnswerJson(i);
const venueIds = () => f.backend.world.venues.map((v) => v.id);

/** every read a careful agent makes to answer a CR-VS question */
function vsReads(endMonth: string, ids: string[]): [string, Record<string, unknown>][] {
  const { months } = vsMonthly(f.day, endMonth);
  return [
    ["tabular_data", { model: "perp-dex-protocols", pageSize: 100 }],
    [
      "timeseries_data",
      {
        model: "perp-dex-protocols",
        granularity: "1d",
        series: ids,
        start: (months[0] as { start: string }).start,
        end: (months.at(-1) as { end: string }).end,
      },
    ],
  ];
}

describe("the MCP prompt", () => {
  it("states the question and the schema, names no tool or model, and never holds the key", () => {
    for (const i of Object.values(by)) {
      const p = buildMcpPrompt(i, W());
      expect(p.text).toContain("Answer schema:");
      expect(p.text).not.toMatch(
        /timeseries_data|tabular_data|perp-dex-protocols|lending-protocols|asset-supply/,
      );
      const figures = referenceAnswerJson(i).match(/-?\d+\.\d{6}/g) ?? [];
      for (const fig of figures) expect(p.text.includes(fig)).toBe(false);
      expect(buildMcpPrompt(i, W()).promptSha256).toBe(p.promptSha256);
    }
  });
});

describe("a day built from what the model received", () => {
  it("reads tool results the way it reads a snapshot, and skips errors and text that is not data", async () => {
    const calls = await run(
      mcp(),
      vsReads((by["CR-VS"] as Extract<Instance, { task: "CR-VS" }>).params.endMonth, venueIds()),
    );
    const day = dayFromRelayed(W(), [
      ...calls,
      {
        tool: "timeseries_data",
        args: { model: "perp-dex-protocols", granularity: "1d" },
        isError: true,
        text: "{}",
      },
      {
        tool: "timeseries_data",
        args: { model: "perp-dex-protocols", granularity: "1d" },
        isError: false,
        text: "not json",
      },
      { tool: "search_documents", args: { model: "x" }, isError: false, text: "{}" },
    ]);
    expect(day.perpVenues.length).toBe(venueIds().length);
    expect(day.perp.size).toBe(venueIds().length);
    expect(day.missing).toEqual(expect.arrayContaining(["lending", "tokens", "stablecoins"]));
  });
});

describe("grading an MCP answer from the data the model received", () => {
  it("CR-VS: reading every venue for the right twelve months, and answering correctly, passes", async () => {
    const i = by["CR-VS"] as Extract<Instance, { task: "CR-VS" }>;
    const relayed = dayFromRelayed(W(), await run(mcp(), vsReads(i.params.endMonth, venueIds())));
    const g = gradeMcpAnswer({ instance: i, text: answerFor(i), relayed });
    expect(g.snapshotCheck).toBe("same");
    expect(g.passed).toBe(true);
    expect(g.classification.classes).toEqual([]);
  });

  it("CR-VS: too few venues read (not enough to rank five) is wrong-dataset, whatever is answered", async () => {
    const i = by["CR-VS"] as Extract<Instance, { task: "CR-VS" }>;
    const relayed = dayFromRelayed(
      W(),
      await run(mcp(), vsReads(i.params.endMonth, venueIds().slice(0, 4))),
    );
    expect(referenceFor(i, relayed)).toBeUndefined();
    const g = gradeMcpAnswer({ instance: i, text: answerFor(i), relayed });
    expect(g).toMatchObject({ passed: false, snapshotCheck: "insufficient" });
    expect(g.classification.classes).toContain("wrong-dataset");
  });

  it("CR-VS: leaving out a top venue gives an answer right for what was read and still fails, as wrong-dataset", async () => {
    const i = by["CR-VS"] as Extract<Instance, { task: "CR-VS" }>;
    const top = i.reference.venues[0] as string;
    const ids = venueIds().filter((v) => v !== top);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    const relayed = dayFromRelayed(W(), await run(mcp(), vsReads(i.params.endMonth, ids)));
    const consistent = referenceFor(i, relayed);
    expect(consistent).toBeDefined();
    const text = referenceAnswerJson({ ...i, reference: consistent } as Instance);
    const g = gradeMcpAnswer({ instance: i, text, relayed });
    expect(g.verdict?.passed).toBe(true); // right for the data it was given
    expect(g.snapshotCheck).toBe("differs");
    expect(g.passed).toBe(false);
    expect(g.classification.primary).toBe("wrong-dataset");
  });

  it("CR-VS: reading the wrong period fails, and a wrong answer on good data is classed by the gate, not as wrong-dataset", async () => {
    const i = by["CR-VS"] as Extract<Instance, { task: "CR-VS" }>;
    const { months } = vsMonthly(f.day, i.params.endMonth);
    const shifted = await run(mcp(), [
      [
        "timeseries_data",
        {
          model: "perp-dex-protocols",
          granularity: "1d",
          series: venueIds(),
          start: addDays((months[0] as { start: string }).start, 20),
          end: (months.at(-1) as { end: string }).end,
        },
      ],
    ]);
    const bad = gradeMcpAnswer({
      instance: i,
      text: answerFor(i),
      relayed: dayFromRelayed(W(), shifted),
    });
    expect(bad.passed).toBe(false);
    const good = dayFromRelayed(W(), await run(mcp(), vsReads(i.params.endMonth, venueIds())));
    const sloppy = JSON.stringify({
      ...JSON.parse(answerFor(i)),
      venues: (i.reference.venues as string[]).slice(0, 4),
    });
    const g = gradeMcpAnswer({ instance: i, text: sloppy, relayed: good });
    expect(g.snapshotCheck).toBe("same");
    expect(g.passed).toBe(false);
    expect(g.classification.primary).toBe("missing-items");
  });

  it("CR-PL: the right protocol and quarter passes; another protocol's data cannot answer it", async () => {
    const i = by["CR-PL"] as Extract<Instance, { task: "CR-PL" }>;
    const read = (id: string): [string, Record<string, unknown>][] => [
      [
        "timeseries_data",
        {
          model: "lending-protocols",
          granularity: "1d",
          series: [id],
          start: i.params.start,
          end: i.params.end,
        },
      ],
    ];
    const ok = gradeMcpAnswer({
      instance: i,
      text: answerFor(i),
      relayed: dayFromRelayed(W(), await run(mcp(), read(i.params.protocolId))),
    });
    expect(ok.passed).toBe(true);
    const other = f.day.lendingProtocols.find((p) => p !== i.params.protocolId) as string;
    const wrong = gradeMcpAnswer({
      instance: i,
      text: answerFor(i),
      relayed: dayFromRelayed(W(), await run(mcp(), read(other))),
    });
    expect(wrong).toMatchObject({ passed: false, snapshotCheck: "insufficient" });
    expect(wrong.classification.classes).toContain("wrong-dataset");
  });

  it("CR-SM: with the data's one-day lag, 90d is the right window; without the lag it is a day short and the model must ask for more", async () => {
    const i = by["CR-SM"] as Extract<Instance, { task: "CR-SM" }>;
    const model = i.params.dimension === "chain" ? "stablecoins-by-chain" : "stablecoins-by-issuer";
    const ids =
      i.params.dimension === "chain"
        ? [...f.day.stablecoins.chain.keys()]
        : [...f.day.stablecoins.issuer.keys()];
    const reads = (timeframe: string): [string, Record<string, unknown>][] =>
      Array.from({ length: Math.ceil(ids.length / 10) }, (_, k) => [
        "timeseries_data",
        {
          model,
          granularity: "1d",
          series: ids.slice(k * 10, k * 10 + 10),
          timeframe,
          bounds: true,
        },
      ]);
    // the fixture series run to the snapshot day, so with no lag a 91-day timeframe starts 90 days back
    const good = gradeMcpAnswer({
      instance: i,
      text: answerFor(i),
      relayed: dayFromRelayed(W(), await run(mcp(), reads("91d"))),
    });
    expect(good.passed).toBe(true);
    const short = gradeMcpAnswer({
      instance: i,
      text: answerFor(i),
      relayed: dayFromRelayed(W(), await run(mcp(), reads("90d"))),
    });
    expect(short).toMatchObject({ passed: false, snapshotCheck: "insufficient" });
  });

  it("an answer with no data fetched at all cannot pass: it fails as wrong-dataset", () => {
    const g = gradeMcpAnswer({
      instance: by["CR-UO"] as Instance,
      text: answerFor(by["CR-UO"] as Instance),
      relayed: dayFromRelayed(W(), []),
    });
    expect(g.passed).toBe(false);
    expect(g.classification.classes).toContain("wrong-dataset");
  });

  it("a session that ended on a limit before any answer is a session-limit failure", () => {
    const g = gradeMcpAnswer({
      instance: by["CR-PL"] as Instance,
      text: "",
      relayed: dayFromRelayed(W(), []),
      sessionLimit: "max-turns",
    });
    expect(g.passed).toBe(false);
    expect(g.classification.classes).toEqual(
      expect.arrayContaining(["session-limit", "no-output", "wrong-dataset"]),
    );
    expect(g.classification.primary).toBe("session-limit");
  });
});
