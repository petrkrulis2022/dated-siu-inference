import { describe, expect, it } from "vitest";
import { assembleContext } from "../context/assemble.js";
import { buildTurnPrompt } from "./prompt.js";

describe("buildTurnPrompt", () => {
  it("includes the skill/pack text, real tool descriptions, and the response format", () => {
    const context = assembleContext("ORCHESTRATOR", "you are ORCHESTRATOR", []);
    const prompt = buildTurnPrompt(context, ["get_print", "mint_claim"]);

    expect(prompt).toContain("you are ORCHESTRATOR");
    expect(prompt).toContain("get_print(printId)"); // the real tool-descriptions.ts entry
    expect(prompt).toContain("mint_claim(quantity, forWindow?)");
    expect(prompt).not.toContain("submit_job("); // not in availableTools — must not leak in
    expect(prompt).toContain('{"tool": "<tool_name>"');
    expect(prompt).toContain("no turns yet");
  });

  it("renders real prior turns so the model can see what it already tried", () => {
    const context = assembleContext("ORCHESTRATOR", "skill text", [
      {
        turn: 1,
        jobId: "job-1",
        toolName: "get_print",
        args: { printId: "x" },
        result: { final: false },
      },
    ]);
    const prompt = buildTurnPrompt(context, ["get_print"]);
    expect(prompt).toContain("Turn 1 — called get_print");
    expect(prompt).toContain('"final":false');
  });
});

describe("the rationale field is offered without steering (spec §7.4, §4.6q)", () => {
  const protocol = buildTurnPrompt(assembleContext("ORCHESTRATOR", "skill text", []), ["get_print"]);
  const offer = protocol.slice(protocol.indexOf('You may also add a "rationale"'));

  it("offers it on every call, never on a privileged subset", () => {
    expect(protocol).toContain('"rationale"');
    expect(offer).toMatch(/available on every call/);
  });

  it("names no tool, asset or situation as the one that warrants a rationale", () => {
    // The whole reason it is not payment-specific. Naming pay, fSIU or "important" here would
    // mark those turns as the ones worth thinking about, and F1 measures exactly what agents do
    // on payment turns — §4.6q's steer on a new surface.
    for (const steer of ["pay", "fsiu", "usdc", "claim", "purchase", "important", "significant"]) {
      expect(offer.toLowerCase()).not.toContain(steer);
    }
  });

  it("does not tell the agent when, or how often, to use it", () => {
    for (const nudge of ["should", "always", "whenever", "make sure", "be sure", "encouraged", "please"]) {
      expect(offer.toLowerCase()).not.toContain(nudge);
    }
  });

  it("says it is optional, in the same breath as offering it", () => {
    expect(offer).toMatch(/Omit it if you have nothing to add/);
  });

  it("leaves the friction field's own wording untouched — the new field displaces nothing", () => {
    expect(protocol).toContain('"could_not_express"');
    expect(protocol).toContain("do not invent friction that did not happen");
  });
});
