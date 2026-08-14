import { describe, expect, it } from "vitest";
import Ajv from "ajv";
import { generateT1Instance, generateT1Instances, T1_SCHEMA } from "./generate.js";

describe("generateT1Instance", () => {
  it("is deterministic for a given (seed, index)", () => {
    const a = generateT1Instance(42, 0);
    const b = generateT1Instance(42, 0);
    expect(a).toEqual(b);
  });

  it("produces different instances for different indices under the same parent seed", () => {
    const a = generateT1Instance(42, 0);
    const b = generateT1Instance(42, 1);
    expect(a.expected).not.toEqual(b.expected);
    expect(a.instance_id).not.toBe(b.instance_id);
  });

  it("produces different instances for different parent seeds", () => {
    const a = generateT1Instance(42, 0);
    const b = generateT1Instance(43, 0);
    expect(a.expected).not.toEqual(b.expected);
  });

  it("uses temperature 0 and no cache_control (only T2 needs that)", () => {
    const instance = generateT1Instance(42, 0);
    expect(instance.params.temperature).toBe(0);
    expect(instance.params.cache_control).toBeUndefined();
  });

  it("produces a prompt roughly in the ~1,000 input token range (approximated by word count)", () => {
    const instance = generateT1Instance(42, 0);
    const wordCount = instance.prompt.split(/\s+/).length;
    // ~1,000 tokens ≈ 650-800 words in English; generous bounds since this is an
    // approximation without a real tokenizer.
    expect(wordCount).toBeGreaterThan(400);
    expect(wordCount).toBeLessThan(1200);
  });

  it("expected values themselves satisfy T1_SCHEMA (generator can't emit a value it would fail)", () => {
    const ajv = new Ajv();
    const validate = ajv.compile(T1_SCHEMA);
    for (let i = 0; i < 5; i++) {
      const instance = generateT1Instance(7, i);
      expect(validate(instance.expected)).toBe(true);
    }
  });

  it("origin and destination city are always different", () => {
    for (let i = 0; i < 20; i++) {
      const instance = generateT1Instance(i, i);
      expect(instance.expected.origin_city).not.toBe(instance.expected.destination_city);
    }
  });
});

describe("generateT1Instances", () => {
  it("generates the requested count with unique instance ids", () => {
    const instances = generateT1Instances(1, 5);
    expect(instances).toHaveLength(5);
    expect(new Set(instances.map((i) => i.instance_id)).size).toBe(5);
  });
});
