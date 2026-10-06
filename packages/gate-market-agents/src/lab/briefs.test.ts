import { describe, expect, it } from "vitest";
import { assembleContext } from "../context/assemble.js";
import { ContextValidationError, validateAgentContext } from "../pack/validate.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { requestQuoteTool } from "../tools/request-quote.js";
import { buildLabBrief, sharedPartOf, type LabBriefInput } from "./briefs.js";
import { LAB_TRADERS, SEAT_OF, buildEconomy, type TraderLabel } from "./economy.js";
import { LAB_TRADER_TOOLS } from "./roster.js";
import { LAB_TOOL_NAMES } from "./tools.js";

const economy = buildEconomy(9);
const directory = {
  ...Object.fromEntries(LAB_TRADERS.map((t) => [t, { sellerId: `erc8004:0x${t}`, model: `model-of-${t}` }])),
  ISSUER: { sellerId: "erc8004:0xISSUER", model: "raw-work" },
} as LabBriefInput["directory"];

const input = (me: TraderLabel): LabBriefInput => ({
  me,
  economy,
  print: { printId: "print-illustrative", rateUsdPerSiu: "0.001437" }, // illustrative
  address: `0xADDR-${me}`,
  directory,
  claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-06", untilIso: "2026-10-07" },
  maxTurns: 40,
  chain: "base-sepolia",
});

const briefs = Object.fromEntries(LAB_TRADERS.map((t) => [t, buildLabBrief(input(t))])) as Record<TraderLabel, string>;

/** The `{"tool": ...}` objects in a text, found by balanced braces — so a worked example that is not valid JSON fails. */
function toolExamples(text: string): Array<{ tool: string; args: Record<string, unknown> }> {
  const found: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('{"tool"', from);
    if (start < 0) return found;
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      if (text[end] === "}" && --depth === 0) break;
    }
    found.push(JSON.parse(text.slice(start, end + 1)));
    from = end + 1;
  }
}

describe("lab briefs — who differs from whom", () => {
  it("is word for word the same for every trader once the personal block is set aside", () => {
    const shared = LAB_TRADERS.map((t) => sharedPartOf(briefs[t]));
    for (const s of shared) expect(s).toBe(shared[0]);
  });

  it("differs only in label, address, skill and needs", () => {
    for (const t of LAB_TRADERS) {
      const personal = briefs[t].slice(0, briefs[t].indexOf("\n\nTHE LAB\n"));
      expect(personal).toContain(`YOU ARE ${t}.`);
      expect(personal).toContain(`0xADDR-${t}`);
      expect(personal).toContain(`you deliver ${economy.skillOf[t]} jobs`);
      // Exactly its own needs, in order. (Another trader can need the same type from the same seller in
      // the same round, so containment of one need is not a test of whose list this is.)
      const mine = economy.needs.filter((x) => x.buyer === t).map((n) => `${n.type} from ${n.seller}, from round ${n.round}`);
      expect(personal).toContain(`  YOUR NEEDS: ${mine.join("; ")}.`);
    }
  });

  it("never names a seat — only labels", () => {
    for (const t of LAB_TRADERS) {
      for (const seat of Object.values(SEAT_OF)) expect(briefs[t], `${t} names ${seat}`).not.toContain(seat);
    }
  });
});

describe("lab briefs — what they state", () => {
  const text = briefs["TRADER-1"];

  it("carries the canonical asset text verbatim, and passes the context validator", () => {
    for (const t of LAB_TRADERS) {
      expect(briefs[t]).toContain(CANONICAL_ASSET_DESCRIPTION);
      expect(() => validateAgentContext(assembleContext(SEAT_OF[t], briefs[t], []))).not.toThrow();
    }
  });

  it("states the quoted amounts, the print, the credit and the opening balances from the economy's own arithmetic", () => {
    expect(text).toContain("A job is 1 SIU.");
    expect(text).toContain("0.0017244 USD per SIU, a quote of 0.0017 USD");
    expect(text).toContain("0.001437 USD per SIU, a quote of 0.0014 USD");
    expect(text).toContain("150% of the print per SIU of the job: 0.0021555 USD for a job of 1 SIU");
    expect(text).toContain("2 SIU of it (2000 mSIU) and 0.002874 USD in USDC");
    expect(text).toContain("print-illustrative, 0.001437 USD per SIU");
  });

  it("states what every way of paying costs, side by side, in the words the user approved — no one route singled out (D21)", () => {
    expect(text).toContain(
      "Paying in USDC costs USDC. Paying with fSIU you hold costs that fSIU. Minting new fSIU costs USDC, at the\n    print, paid to the issuer.",
    );
    // The one-route parentheticals are gone: the cost of minting appears only in the parallel statement.
    expect(text).not.toContain("a mint is paid for in USDC");
    expect(text).not.toContain("minted, and paid for, as above");
    expect(text.match(/paid to the issuer/g)).toHaveLength(1);
  });

  it("states how a result is counted, and that it is measured before the window closes", () => {
    expect(text).toContain("Your result is your USDC, plus your fSIU valued at the current print, plus a credit for each need met.");
    expect(text).toContain("Results are measured before the window closes.");
  });

  it("lists every counterparty with the sellerId and model a quote request needs", () => {
    for (const t of LAB_TRADERS) expect(text).toContain(`${t}: skill ${economy.skillOf[t]}; sellerId "erc8004:0x${t}"; model "model-of-${t}"`);
    expect(text).toContain('ISSUER-B: sellerId "erc8004:0xISSUER"; model "raw-work"');
  });
});

describe("lab briefs — no steering, and nothing the system would refuse", () => {
  const text = LAB_TRADERS.map((t) => briefs[t]).join("\n");
  // Outside the canonical text, which is validated separately and says what it says.
  const own = text.split(CANONICAL_ASSET_DESCRIPTION).join("");

  it("uses none of the words that advise or compare", () => {
    for (const word of ["prefer", "should", "better", "cheaper", "advantage", "recommend", "best", "save", "worth holding", "hold on", "keep your", "convert", "cash out", "same either way"]) {
      expect(own.toLowerCase(), word).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });

  it("does not mention the escrow fee, a rebate or the route that costs less", () => {
    for (const word of ["fee", "rebate", "bps", "fewer dollars", "costs less", "cost the same", "equal cost"]) {
      expect(own.toLowerCase(), word).not.toContain(word);
    }
  });

  it("uses none of the words the project forbids in copy", () => {
    for (const word of ["backed by", "peg", "invest", "real-time", "oracle", "aixd"]) {
      expect(text.toLowerCase(), word).not.toContain(word);
    }
  });

  it("names, in its worked syntax, only tools the traders were given, by the names they were given — and each example is valid JSON", () => {
    const shown = new Set(LAB_TRADER_TOOLS.map((t) => LAB_TOOL_NAMES[t] ?? t));
    const examples = toolExamples(text);
    expect(examples.length).toBeGreaterThan(8);
    for (const e of examples) expect(shown, `${e.tool} is in a worked example but is not a name a trader was given`).toContain(e.tool);
    // The loop's own names for the renamed tools never appear: a trader that read one would call a tool it does not have.
    for (const internal of Object.keys(LAB_TOOL_NAMES)) expect(examples.map((e) => e.tool)).not.toContain(internal);
  });

  it("gives a request_quote example the tool itself accepts", () => {
    const example = toolExamples(briefs["TRADER-1"]).find((e) => e.tool === "request_quote")!;
    expect(requestQuoteTool.argsSchema.safeParse(example.args).success).toBe(true);
  });

  it("gives every payment route one worked example of the same shape, named by what it does (D26)", () => {
    const section = briefs["TRADER-1"].slice(briefs["TRADER-1"].indexOf("Step 3"), briefs["TRADER-1"].indexOf("IF YOU ARE THE SELLER"));
    expect(section.replace(/\s+/g, " ")).toContain("each works for a job and for a unit of raw work alike");
    const routes = toolExamples(section).filter((e) => e.tool.startsWith("pay_"));
    expect(routes.map((e) => e.tool)).toEqual(["pay_with_usdc", "pay_with_new_claim", "pay_with_held_claim", "pay_split"]);
    // The same one-argument shape for every route; the split alone has to say how much of it is claim.
    for (const e of routes) expect(Object.keys(e.args)).toContain("requestId");
    expect(Object.keys(routes[0].args)).toEqual(["requestId"]);
    expect(Object.keys(routes[1].args)).toEqual(["requestId"]);
    expect(Object.keys(routes[2].args)).toEqual(["requestId"]);
    expect(Object.keys(routes[3].args)).toEqual(["requestId", "claimQuantityMilliSiu"]);
  });

  it("is refused by the validator if an asset is recommended — the guard is live on these briefs", () => {
    const bad = `${briefs["TRADER-1"]}\nYou should prefer USDC.`;
    expect(() => validateAgentContext(assembleContext("ORCHESTRATOR", bad, []))).toThrow(ContextValidationError);
  });
});
