import { describe, expect, it } from "vitest";
import { generateT2Instance, generateT2Instances } from "./generate.js";

describe("generateT2Instance", () => {
  it("is deterministic for a given (seed, index)", () => {
    const a = generateT2Instance(42, 0);
    const b = generateT2Instance(42, 0);
    expect(a).toEqual(b);
  });

  it("produces different instances for different indices", () => {
    const a = generateT2Instance(42, 0);
    const b = generateT2Instance(42, 1);
    expect(a.expected.codes).not.toEqual(b.expected.codes);
  });

  it("plants exactly four distinct codes", () => {
    const instance = generateT2Instance(42, 0);
    expect(instance.expected.codes).toHaveLength(4);
    expect(new Set(instance.expected.codes).size).toBe(4);
  });

  it("every planted code appears in the prompt, in the stated order", () => {
    const instance = generateT2Instance(42, 0);
    const positions = instance.expected.codes.map((code) => instance.prompt.indexOf(code));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("plants codes at varied depths, not clustered together", () => {
    const instance = generateT2Instance(42, 0);
    const positions = instance.expected.codes.map((code) => instance.prompt.indexOf(code));
    const first = positions[0];
    const last = positions[positions.length - 1];
    // First and last planted fact should be well apart relative to document length.
    expect(last - first).toBeGreaterThan(instance.prompt.length * 0.5);
  });

  it("explicitly disables prompt caching", () => {
    const instance = generateT2Instance(42, 0);
    expect(instance.params.cache_control).toBe("disabled");
  });

  it("produces a prompt roughly in the ~25,000 input token range (approximated by word count)", () => {
    const instance = generateT2Instance(42, 0);
    const wordCount = instance.prompt.split(/\s+/).length;
    // ~25,000 tokens ≈ 16,000-20,000 words in English; generous bounds since this is an
    // approximation without a real tokenizer.
    expect(wordCount).toBeGreaterThan(12000);
    expect(wordCount).toBeLessThan(28000);
  });
});

describe("generateT2Instances", () => {
  it("generates the requested count with unique instance ids", () => {
    const instances = generateT2Instances(1, 5);
    expect(instances).toHaveLength(5);
    expect(new Set(instances.map((i) => i.instance_id)).size).toBe(5);
  });
});
