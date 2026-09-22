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

  it("formatToolList joins every description onto its own line", () => {
    const list = formatToolList();
    expect(list.split("\n")).toHaveLength(Object.keys(TOOL_DESCRIPTIONS).length);
  });
});
