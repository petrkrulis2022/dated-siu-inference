import { describe, expect, it } from "vitest";
import { assembleContext } from "../context/assemble.js";
import { buildTurnPrompt } from "./prompt.js";

describe("buildTurnPrompt", () => {
  it("includes the skill/pack text, real tool descriptions, and the response format", () => {
    const context = assembleContext("ORCHESTRATOR", "you are ORCHESTRATOR", []);
    const prompt = buildTurnPrompt(context, ["get_print", "mint_claim"]);

    expect(prompt).toContain("you are ORCHESTRATOR");
    expect(prompt).toContain("get_print(printId)"); // the real tool-descriptions.ts entry
    expect(prompt).toContain("mint_claim(classId, quantity");
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
