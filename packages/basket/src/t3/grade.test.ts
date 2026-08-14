import { describe, expect, it } from "vitest";
import { generateT3Instance } from "./generate.js";
import { gradeT3 } from "./grade.js";

const instance = generateT3Instance(42, 0); // filterAboveThreshold(nums, threshold)

describe("gradeT3", () => {
  it("passes a correct implementation (known-good)", async () => {
    const code =
      "export function filterAboveThreshold(nums, threshold) { return nums.filter(n => n > threshold); }";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(true);
  }, 10000);

  it("passes when the code is wrapped in a ```js fence and never explicitly exports the function", async () => {
    const code =
      "```js\nfunction filterAboveThreshold(nums, threshold) { return nums.filter(n => n > threshold); }\n```";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(true);
  }, 10000);

  it("fails a wholly wrong implementation (known-bad)", async () => {
    const code = "export function filterAboveThreshold(nums, threshold) { return []; }";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(false);
  }, 10000);

  it("fails a near-miss off-by-one implementation (>= instead of >)", async () => {
    const code =
      "export function filterAboveThreshold(nums, threshold) { return nums.filter(n => n >= threshold); }";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/test case/i);
  }, 10000);

  it("fails cleanly on a syntax error rather than crashing", async () => {
    const code = "export function filterAboveThreshold(nums, threshold) { return nums.filter( ";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(false);
  }, 10000);

  it("fails cleanly when the response doesn't define the expected function at all", async () => {
    const code = "export function somethingElse() { return 42; }";
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/no exported function/i);
  }, 10000);

  it("kills an infinite loop at the hard timeout rather than hanging", async () => {
    const code = "export function filterAboveThreshold(nums, threshold) { while (true) {} }";
    const start = Date.now();
    const result = await gradeT3(instance, code, 1500);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
    expect(Date.now() - start).toBeLessThan(4000);
  }, 10000);

  it("denies network access: a candidate whose logic depends on a network call fails, doesn't crash the sandbox", async () => {
    const code = `
        export async function filterAboveThreshold(nums, threshold) {
          await fetch('https://example.com');
          return nums.filter(n => n > threshold);
        }
      `;
    const result = await gradeT3(instance, code);
    expect(result.passed).toBe(false);
  }, 10000);
});
