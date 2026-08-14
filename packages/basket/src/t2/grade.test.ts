import { describe, expect, it } from "vitest";
import { generateT2Instance } from "./generate.js";
import { gradeT2 } from "./grade.js";

const instance = generateT2Instance(42, 0);

describe("gradeT2", () => {
  it("passes when every planted code is present", async () => {
    const response = instance.expected.codes.join("\n");
    const result = await gradeT2(instance, response);
    expect(result.passed).toBe(true);
  });

  it("passes even with surrounding formatting/whitespace (substring match)", async () => {
    const response = instance.expected.codes.map((c) => `- code: ${c}  `).join("\n");
    const result = await gradeT2(instance, response);
    expect(result.passed).toBe(true);
  });

  it("fails when a planted code is missing entirely (known-bad)", async () => {
    const response = instance.expected.codes.slice(1).join("\n");
    const result = await gradeT2(instance, response);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain(instance.expected.codes[0]);
  });

  it("fails on a near-miss: correct code but wrong case", async () => {
    const response = instance.expected.codes.map((c) => c.toLowerCase()).join("\n");
    const result = await gradeT2(instance, response);
    expect(result.passed).toBe(false);
  });

  it("fails on a near-miss: a truncated code", async () => {
    const response = [
      instance.expected.codes[0].slice(0, -1),
      ...instance.expected.codes.slice(1),
    ].join("\n");
    const result = await gradeT2(instance, response);
    expect(result.passed).toBe(false);
  });

  it("fails on an empty response", async () => {
    const result = await gradeT2(instance, "");
    expect(result.passed).toBe(false);
  });
});
