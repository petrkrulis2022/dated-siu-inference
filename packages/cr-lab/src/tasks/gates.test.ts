import { describe, expect, it } from "vitest";
import { D } from "@touchstone/sdk";
import { parseJsonDecimal } from "../data-desk/json-decimal.js";
import {
  gatePL,
  gateSM,
  gateUO,
  gateVS,
  parseAnswer,
  readDecimal,
  withinAbsolute,
  withinRelative,
  type Verdict,
} from "./gates.js";
import type { PLReference, SMReference, UOReference, VSReference } from "./solve.js";

const obj = (text: string) => {
  const p = parseAnswer(text);
  if (!p.ok) throw new Error(`test answer did not parse: ${p.failure.detail}`);
  return p.value;
};
const codes = (v: Verdict) => v.failures.map((f) => f.code);

describe("parseAnswer: the whole reply is one JSON object", () => {
  it("accepts a bare object, with surrounding whitespace", () => {
    expect(parseAnswer('  \n{"a": 1}\n ')).toMatchObject({ ok: true, fenced: false });
  });
  it("accepts one fenced block and records that it was fenced; that is noted, not a failure", () => {
    expect(parseAnswer('```json\n{"a": 1}\n```')).toMatchObject({ ok: true, fenced: true });
    expect(parseAnswer('```\n{"a": 1}\n```')).toMatchObject({ ok: true, fenced: true });
  });
  it("rejects prose around the JSON, a second block, an array, a scalar, and invalid JSON", () => {
    for (const bad of [
      'Here is the answer: {"a": 1}',
      '{"a": 1}\nHope this helps!',
      '```json\n{"a":1}\n```\n```json\n{"a":2}\n```',
      "[1, 2]",
      "5",
      '"text"',
      "null",
      '{"a": 1,}',
      "",
      "{'a': 1}",
      '{"a": NaN}',
    ]) {
      const p = parseAnswer(bad);
      expect(p.ok, bad).toBe(false);
      if (!p.ok) expect(p.failure.code).toBe("format");
    }
  });
  it("keeps the digits of a number exactly as written", () => {
    const o = obj('{"x": 0.1000000000000000055511151231257827}');
    expect(readDecimal(o.x)?.toFixed(34)).toBe("0.1000000000000000055511151231257827");
  });
});

describe("readDecimal: a plain decimal from a JSON number or a decimal string", () => {
  const j = (t: string) => parseJsonDecimal(t) as never;
  it("accepts integers, fractions and negatives, as numbers or strings", () => {
    for (const ok of ["12", "-12", "12.5", "-0.25", "0", '"12"', '"-12.5"', '"0.000001"'])
      expect(readDecimal(j(ok)), ok).toBeDefined();
  });
  it("rejects exponents, units, separators, blanks, null, booleans and non-numbers", () => {
    for (const bad of [
      "1e3",
      "1E-2",
      '"1e3"',
      '"12%"',
      '"$12"',
      '"1,234"',
      '"1 234"',
      '""',
      '" 1"',
      '"1."',
      '".5"',
      '"+1"',
      "null",
      "true",
      '"abc"',
      '"NaN"',
      "[1]",
      "{}",
    ])
      expect(readDecimal(j(bad)), bad).toBeUndefined();
  });
});

describe("tolerances, compared in decimals", () => {
  it("withinRelative: exactly at the tolerance passes, a hair over fails, zero must match exactly", () => {
    expect(withinRelative(new D("1001"), new D("1000"), "0.001")).toBe(true);
    expect(withinRelative(new D("999"), new D("1000"), "0.001")).toBe(true);
    expect(withinRelative(new D("1001.000001"), new D("1000"), "0.001")).toBe(false);
    expect(withinRelative(new D("-1001"), new D("-1000"), "0.001")).toBe(true);
    expect(withinRelative(new D("0"), new D("0"), "0.001")).toBe(true);
    expect(withinRelative(new D("0.000001"), new D("0"), "0.001")).toBe(false);
  });
  it("withinAbsolute: exactly 0.01 passes, a hair over fails", () => {
    expect(withinAbsolute(new D("12.34"), new D("12.35"), "0.01")).toBe(true);
    expect(withinAbsolute(new D("12.3399999"), new D("12.35"), "0.01")).toBe(false);
  });
});

// ---- CR-VS ---------------------------------------------------------------------------------------------------------------------------------------
const MONTHS = [
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
];
const VENUES = ["v1", "v2", "v3", "v4", "v5"];
const VS_REF: VSReference = {
  venues: VENUES,
  months: MONTHS,
  shares: Object.fromEntries(
    MONTHS.map((m) => [
      m,
      { v1: "40.000000", v2: "25.000000", v3: "20.000000", v4: "10.000000", v5: "5.000000" },
    ]),
  ),
};
const vsAnswer = (
  mutate?: (a: {
    venues: string[];
    shares: Record<string, Record<string, string | number>>;
  }) => void,
) => {
  const a = {
    venues: [...VENUES],
    shares: Object.fromEntries(MONTHS.map((m) => [m, { ...VS_REF.shares[m] }])) as Record<
      string,
      Record<string, string | number>
    >,
  };
  mutate?.(a);
  return obj(JSON.stringify(a));
};

describe("gateVS", () => {
  it("passes the reference answer, with numbers or decimal strings", () => {
    expect(gateVS(vsAnswer(), VS_REF)).toEqual({ passed: true, failures: [], fenced: false });
    expect(
      gateVS(
        vsAnswer((a) => {
          a.shares["2026-01"] = { v1: 40, v2: 25, v3: 20, v4: 10, v5: 5 };
        }),
        VS_REF,
      ).passed,
    ).toBe(true);
  });
  it("accepts venues in any order", () => {
    expect(
      gateVS(
        vsAnswer((a) => a.venues.reverse()),
        VS_REF,
      ).passed,
    ).toBe(true);
  });
  it("accepts a share exactly 0.01 away and rejects one a hair further", () => {
    // moving v1 by 0.01 and v2 by -0.01 keeps the month at 100
    const edge = vsAnswer((a) => {
      a.shares["2026-01"] = { v1: "40.010000", v2: "24.990000", v3: "20", v4: "10", v5: "5" };
    });
    expect(gateVS(edge, VS_REF).passed).toBe(true);
    const over = vsAnswer((a) => {
      a.shares["2026-01"] = { v1: "40.010001", v2: "24.989999", v3: "20", v4: "10", v5: "5" };
    });
    expect(codes(gateVS(over, VS_REF))).toEqual(["value", "value"]);
  });
  it("fails a wrong venue set", () => {
    const v = gateVS(
      vsAnswer((a) => {
        a.venues[4] = "v9";
        for (const m of MONTHS) {
          a.shares[m] = { v1: "40", v2: "25", v3: "20", v4: "10", v9: "5" };
        }
      }),
      VS_REF,
    );
    expect(v.passed).toBe(false);
    expect(codes(v)).toContain("set");
  });
  it("fails months that do not add up to 100 (within 0.01), whatever the individual shares", () => {
    const v = gateVS(
      vsAnswer((a) => {
        a.shares["2026-03"] = { v1: "40", v2: "25", v3: "20", v4: "10", v5: "5.5" };
      }),
      VS_REF,
    );
    expect(codes(v)).toContain("sum");
    expect(codes(v)).toContain("value");
    const closeEnough = gateVS(
      vsAnswer((a) => {
        a.shares["2026-03"] = { v1: "40.005", v2: "25", v3: "20", v4: "10", v5: "5" };
      }),
      VS_REF,
    );
    expect(closeEnough.passed).toBe(true); // 100.005 is within 0.01 of 100, and 0.005 within 0.01 of the reference
  });
  it("fails a schema that is wrong: extra or missing keys, six venues, a missing month, a venue left out of a month, a share that is not a decimal", () => {
    expect(codes(gateVS(obj('{"venues": [], "shares": {}, "note": "x"}'), VS_REF))).toEqual([
      "schema",
    ]);
    expect(codes(gateVS(obj('{"venues": ["v1"]}'), VS_REF))).toEqual(["schema"]);
    expect(
      codes(
        gateVS(
          vsAnswer((a) => a.venues.push("v6")),
          VS_REF,
        ),
      ),
    ).toEqual(["schema"]);
    expect(
      codes(
        gateVS(
          vsAnswer((a) => {
            a.venues[1] = "v1";
          }),
          VS_REF,
        ),
      ),
    ).toEqual(["schema"]); // not distinct
    expect(
      codes(
        gateVS(
          vsAnswer((a) => delete a.shares["2026-05"]),
          VS_REF,
        ),
      ),
    ).toEqual(["schema"]);
    expect(
      codes(
        gateVS(
          vsAnswer((a) => {
            a.shares["2099-01"] = a.shares["2026-05"]!;
            delete a.shares["2026-05"];
          }),
          VS_REF,
        ),
      ),
    ).toEqual(["schema"]);
    expect(
      codes(
        gateVS(
          vsAnswer((a) => delete a.shares["2026-05"]!.v3),
          VS_REF,
        ),
      ),
    ).toContain("schema");
    expect(
      codes(
        gateVS(
          vsAnswer((a) => {
            a.shares["2026-05"]!.v3 = "20%";
          }),
          VS_REF,
        ),
      ),
    ).toContain("schema");
  });
  it("lists every failure but caps the detail of a repeated one", () => {
    const v = gateVS(
      vsAnswer((a) => {
        for (const m of MONTHS) a.shares[m] = { v1: "41", v2: "24", v3: "20", v4: "10", v5: "5" };
      }),
      VS_REF,
    );
    expect(v.failures.filter((f) => f.code === "value").length).toBeLessThanOrEqual(7);
    expect(v.failures.some((f) => f.detail.includes("more of the same"))).toBe(true);
  });
  it("carries the fenced flag through", () => {
    expect(gateVS(vsAnswer(), VS_REF, true).fenced).toBe(true);
  });
});

// ---- CR-PL ---------------------------------------------------------------------------------------------------------------------------------------
const PL_REF: PLReference = { fees: "1000.000000", payouts: "800.000000", revenue: "200.000000" };
const pl = (fees: string, payouts: string, revenue: string) =>
  obj(JSON.stringify({ fees, payouts, revenue }));

describe("gatePL", () => {
  it("passes the reference", () => {
    expect(gatePL(pl("1000", "800", "200"), PL_REF).passed).toBe(true);
  });
  it("passes figures exactly 0.1% away, provided revenue is the answer's own fees minus payouts", () => {
    expect(gatePL(pl("1001", "800.8", "200.2"), PL_REF).passed).toBe(true); // fees +0.1%, payouts +0.1%, revenue 200.2 = +0.1%
  });
  it("fails fees or payouts more than 0.1% away; because revenue must equal fees minus payouts, the error carries into revenue and is reported there too", () => {
    expect(codes(gatePL(pl("1001.01", "800", "201.01"), PL_REF))).toEqual(["value", "value"]); // fees +0.101%, and revenue +0.5%
    expect(codes(gatePL(pl("1000", "801", "199"), PL_REF))).toEqual(["value", "value"]); // payouts +0.125%, and revenue -0.5%
  });
  it("fails revenue that is not EXACTLY fees minus payouts, even when close to the reference", () => {
    const v = gatePL(pl("1000", "800", "200.01"), PL_REF);
    expect(codes(v)).toEqual(["identity"]); // within 0.1% of the reference revenue, but not fees - payouts
    expect(gatePL(pl("1000.000001", "800", "200.000001"), PL_REF).passed).toBe(true); // exact to the last decimal place
  });
  it("fails revenue that is internally consistent but far from the reference", () => {
    expect(codes(gatePL(pl("1000", "700", "300"), PL_REF))).toEqual(["value", "value"]); // payouts and revenue both off
  });
  it("accepts numbers and strings, and compares in decimals, not floats", () => {
    expect(
      gatePL(obj('{"fees": 0.3, "payouts": 0.1, "revenue": 0.2}'), {
        fees: "0.3",
        payouts: "0.1",
        revenue: "0.2",
      }).passed,
    ).toBe(true); // 0.3 - 0.1 is exactly 0.2 here
  });
  it("fails the wrong keys and values that are not plain decimals", () => {
    expect(codes(gatePL(obj('{"fees": "1", "payouts": "1"}'), PL_REF))).toEqual(["schema"]);
    expect(
      codes(gatePL(obj('{"fees": "1", "payouts": "1", "revenue": "0", "x": 1}'), PL_REF)),
    ).toEqual(["schema"]);
    expect(
      codes(gatePL(obj('{"fees": "1e3", "payouts": "800", "revenue": "200"}'), PL_REF)),
    ).toEqual(["schema"]);
    expect(
      codes(gatePL(obj('{"fees": null, "payouts": "800", "revenue": "200"}'), PL_REF)),
    ).toEqual(["schema"]);
  });
  it("needs a zero reference to be matched exactly", () => {
    const zero: PLReference = { fees: "100", payouts: "0.000000", revenue: "100" };
    expect(gatePL(pl("100", "0", "100"), zero).passed).toBe(true);
    expect(codes(gatePL(pl("100", "0.000001", "99.999999"), zero))).toContain("value");
  });
});

// ---- CR-UO ---------------------------------------------------------------------------------------------------------------------------------------
const UO_REF: UOReference = {
  unlock30Pct: "2.500000",
  unlock90Pct: "7.250000",
  unlock30Tokens: "1",
  unlock90Tokens: "1",
  circulating: "1",
  supplyDay: "2026-10-18",
};
const uo = (a: string, b: string) => obj(JSON.stringify({ unlock30_pct: a, unlock90_pct: b }));

describe("gateUO", () => {
  it("passes the reference, and values exactly 0.01 percentage points away", () => {
    expect(gateUO(uo("2.5", "7.25"), UO_REF).passed).toBe(true);
    expect(gateUO(uo("2.51", "7.24"), UO_REF).passed).toBe(true);
  });
  it("fails a hair beyond 0.01, and says which of the two", () => {
    const v = gateUO(uo("2.510001", "7.25"), UO_REF);
    expect(codes(v)).toEqual(["value"]);
    expect(v.failures[0]!.detail).toContain("unlock30_pct");
    expect(gateUO(uo("2.5", "7.260001"), UO_REF).failures[0]!.detail).toContain("unlock90_pct");
  });
  it("fails a percentage given as a fraction, which is how a scale slip looks to the gate", () => {
    expect(codes(gateUO(uo("0.025", "0.0725"), UO_REF))).toEqual(["value", "value"]);
  });
  it("fails the wrong keys and non-decimal values", () => {
    expect(codes(gateUO(obj('{"unlock30_pct": "2.5"}'), UO_REF))).toEqual(["schema"]);
    expect(codes(gateUO(obj('{"unlock30_pct": "2.5%", "unlock90_pct": "7.25"}'), UO_REF))).toEqual([
      "schema",
    ]);
  });
});

// ---- CR-SM ---------------------------------------------------------------------------------------------------------------------------------------
const SM_REF: SMReference = {
  dimension: "chain",
  top5: [
    { id: "a", changeUsd: "-5000000.000000" },
    { id: "b", changeUsd: "4000000.000000" },
    { id: "c", changeUsd: "3000000.000000" },
    { id: "d", changeUsd: "-2000000.000000" },
    { id: "e", changeUsd: "1000000.000000" },
  ],
};
const sm = (rows: [string, string | number][]) =>
  obj(JSON.stringify({ top5: rows.map(([id, change_usd]) => ({ id, change_usd })) }));
const GOOD: [string, string][] = [
  ["a", "-5000000"],
  ["b", "4000000"],
  ["c", "3000000"],
  ["d", "-2000000"],
  ["e", "1000000"],
];

describe("gateSM", () => {
  it("passes the reference, and changes exactly 0.1% away", () => {
    expect(gateSM(sm(GOOD), SM_REF).passed).toBe(true);
    expect(
      gateSM(
        sm([
          ["a", "-5005000"],
          ["b", "4004000"],
          ["c", "3003000"],
          ["d", "-2002000"],
          ["e", "1001000"],
        ]),
        SM_REF,
      ).passed,
    ).toBe(true);
  });
  it("fails a change more than 0.1% away", () => {
    const v = gateSM(
      sm([
        ["a", "-5005001"],
        ["b", "4000000"],
        ["c", "3000000"],
        ["d", "-2000000"],
        ["e", "1000000"],
      ]),
      SM_REF,
    );
    expect(codes(v)).toEqual(["value"]);
    expect(v.failures[0]!.detail).toContain("a:");
  });
  it("fails the wrong sign: a fall reported as a rise is far outside the tolerance", () => {
    expect(
      codes(
        gateSM(
          sm([
            ["a", "5000000"],
            ["b", "4000000"],
            ["c", "3000000"],
            ["d", "-2000000"],
            ["e", "1000000"],
          ]),
          SM_REF,
        ),
      ),
    ).toEqual(["value"]);
  });
  it("tells the right five in the wrong order from a wrong set", () => {
    expect(
      codes(
        gateSM(
          sm([
            ["b", "4000000"],
            ["a", "-5000000"],
            ["c", "3000000"],
            ["d", "-2000000"],
            ["e", "1000000"],
          ]),
          SM_REF,
        ),
      ),
    ).toEqual(["order"]);
    expect(
      codes(
        gateSM(
          sm([
            ["a", "-5000000"],
            ["b", "4000000"],
            ["c", "3000000"],
            ["d", "-2000000"],
            ["z", "1000000"],
          ]),
          SM_REF,
        ),
      ),
    ).toEqual(["set"]);
  });
  it("fails a schema that is wrong: not five entries, repeated ids, extra keys, a change that is not a decimal", () => {
    expect(codes(gateSM(obj('{"top5": []}'), SM_REF))).toEqual(["schema"]);
    expect(codes(gateSM(obj('{"top5": "a,b,c,d,e"}'), SM_REF))).toEqual(["schema"]);
    expect(codes(gateSM(obj('{"top5": [], "extra": 1}'), SM_REF))).toEqual(["schema"]);
    expect(
      codes(
        gateSM(
          sm([
            ["a", "1"],
            ["a", "1"],
            ["b", "1"],
            ["c", "1"],
            ["d", "1"],
          ]),
          SM_REF,
        ),
      ),
    ).toContain("schema");
    expect(
      codes(
        gateSM(
          sm([
            ["a", "1e6"],
            ["b", "1"],
            ["c", "1"],
            ["d", "1"],
            ["e", "1"],
          ]),
          SM_REF,
        ),
      ),
    ).toContain("schema");
    expect(
      codes(
        gateSM(
          obj('{"top5": [{"id": "a"}, {"id":"b"}, {"id":"c"}, {"id":"d"}, {"id":"e"}]}'),
          SM_REF,
        ),
      ),
    ).toEqual(["schema"]);
  });
});
