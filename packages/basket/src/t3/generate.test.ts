import { describe, expect, it } from "vitest";
import { generateT3Instance, generateT3Instances } from "./generate.js";
import { TEMPLATES } from "./templates.js";

describe("generateT3Instance", () => {
  it("is deterministic for a given (seed, index)", () => {
    const a = generateT3Instance(42, 0);
    const b = generateT3Instance(42, 0);
    expect(a).toEqual(b);
  });

  it("produces different hidden test cases for different parent seeds", () => {
    const a = generateT3Instance(42, 0);
    const b = generateT3Instance(43, 0);
    expect(a.expected.testCases).not.toEqual(b.expected.testCases);
    // Same template slot though — see basket.ts note on why template order is fixed.
    expect(a.expected.functionName).toBe(b.expected.functionName);
  });

  it("uses a different template for each of the five instance slots", () => {
    const instances = generateT3Instances(1, 5);
    const functionNames = instances.map((i) => i.expected.functionName);
    expect(new Set(functionNames).size).toBe(TEMPLATES.length);
  });

  it("every hidden test case's expected output matches the template's own reference implementation", () => {
    for (let i = 0; i < TEMPLATES.length; i++) {
      const instance = generateT3Instance(7, i);
      const template = TEMPLATES[i];
      for (const testCase of instance.expected.testCases) {
        expect(testCase.expected).toEqual(template.reference(...testCase.args));
      }
    }
  });

  it("uses temperature 0 and no cache_control (only T2 needs that)", () => {
    const instance = generateT3Instance(42, 0);
    expect(instance.params.temperature).toBe(0);
    expect(instance.params.cache_control).toBeUndefined();
  });
});

describe("generateT3Instances", () => {
  it("generates the requested count with unique instance ids", () => {
    const instances = generateT3Instances(1, 5);
    expect(instances).toHaveLength(5);
    expect(new Set(instances.map((i) => i.instance_id)).size).toBe(5);
  });
});
