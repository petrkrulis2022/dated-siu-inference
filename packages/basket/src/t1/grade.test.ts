import { describe, expect, it } from "vitest";
import { generateT1Instance } from "./generate.js";
import { gradeT1 } from "./grade.js";

const instance = generateT1Instance(42, 0);
const good = JSON.stringify(instance.expected);

describe("gradeT1", () => {
  it("passes on an exact match", async () => {
    const result = await gradeT1(instance, good);
    expect(result.passed).toBe(true);
  });

  it("passes when the JSON is wrapped in a ```json code fence", async () => {
    const result = await gradeT1(instance, `Here is the record:\n\`\`\`json\n${good}\n\`\`\``);
    expect(result.passed).toBe(true);
  });

  it("fails on non-JSON prose", async () => {
    const result = await gradeT1(instance, "The shipment is on its way, no issues to report.");
    expect(result.passed).toBe(false);
  });

  it("fails when a field value is wrong (known-bad)", async () => {
    const bad = { ...instance.expected, weight_kg: instance.expected.weight_kg + 1 };
    const result = await gradeT1(instance, JSON.stringify(bad));
    expect(result.passed).toBe(false);
  });

  it("fails on a near-miss: correct value but wrong case", async () => {
    const nearMiss = {
      ...instance.expected,
      origin_city: instance.expected.origin_city.toLowerCase(),
    };
    const result = await gradeT1(instance, JSON.stringify(nearMiss));
    expect(result.passed).toBe(false);
  });

  it("fails on a near-miss: correct value but wrong type (number as string)", async () => {
    const nearMiss = { ...instance.expected, weight_kg: String(instance.expected.weight_kg) };
    const result = await gradeT1(instance, JSON.stringify(nearMiss));
    expect(result.passed).toBe(false);
  });

  it("fails on a near-miss: an out-of-enum status value", async () => {
    const nearMiss = { ...instance.expected, status: "in-transit" };
    const result = await gradeT1(instance, JSON.stringify(nearMiss));
    expect(result.passed).toBe(false);
  });

  it("fails when a required field is missing", async () => {
    const missing = Object.fromEntries(
      Object.entries(instance.expected).filter(([key]) => key !== "priority"),
    );
    const result = await gradeT1(instance, JSON.stringify(missing));
    expect(result.passed).toBe(false);
  });

  it("fails when an additional, unexpected property is present", async () => {
    const withExtra = { ...instance.expected, note: "handled with care" };
    const result = await gradeT1(instance, JSON.stringify(withExtra));
    expect(result.passed).toBe(false);
  });
});
