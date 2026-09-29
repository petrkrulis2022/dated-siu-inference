import { describe, expect, it } from "vitest";
import { TOOLS } from "../tools/index.js";
import { TOOL_DESCRIPTIONS, formatToolList } from "./tool-descriptions.js";

describe("TOOL_DESCRIPTIONS", () => {
  it("has an entry for every tool actually in the real TOOLS registry — the drift guard", () => {
    for (const toolName of Object.keys(TOOLS)) {
      expect(TOOL_DESCRIPTIONS).toHaveProperty(toolName);
    }
  });

  it("has no stale entry for a tool that no longer exists", () => {
    for (const toolName of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(TOOLS).toHaveProperty(toolName);
    }
  });

  it("formatToolList emits every description, newline-separated", () => {
    const list = formatToolList();
    // Asserted by content rather than by line count. A description may legitimately span several
    // lines: `submit_job`'s carries a worked example of the gate module it expects, added
    // 2026-09-29 after both issuers in P5 run 3 failed to produce one. Counting lines would have
    // forced that example onto a single unreadable line to satisfy the test, which is the test
    // dictating the prompt rather than checking it.
    for (const description of Object.values(TOOL_DESCRIPTIONS)) {
      expect(list).toContain(description);
    }
    expect(list.split("\n").length).toBeGreaterThanOrEqual(Object.keys(TOOL_DESCRIPTIONS).length);
  });

  it(
    "every description opens with its own tool name, so a multi-line entry is still " +
      "attributable to the tool it describes",
    () => {
      for (const [toolName, description] of Object.entries(TOOL_DESCRIPTIONS)) {
        expect(description.startsWith(`${toolName}(`)).toBe(true);
      }
    },
  );
});
