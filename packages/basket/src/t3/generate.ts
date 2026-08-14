import type { TaskInstance } from "../types.js";
import { deriveSeed, mulberry32 } from "../seed.js";
import { TEMPLATES, type TestCase } from "./templates.js";

export interface T3Expected {
  functionName: string;
  testCases: TestCase[];
}

export function generateT3Instance(parentSeed: number, index: number): TaskInstance<T3Expected> {
  const template = TEMPLATES[index % TEMPLATES.length];
  const seed = deriveSeed(parentSeed, "T3", index);
  const rng = mulberry32(seed);

  const testCases = template.generateTestCases(rng);

  const prompt =
    `${template.description}\n\n` +
    `Signature: ${template.signature}\n\n` +
    `Write your implementation in JavaScript. Export the function with ` +
    `\`export function ${template.functionName}(...)\`. Provide only the function definition — ` +
    "no example usage, no explanation, no markdown outside a single code block if you use one.";

  return {
    task_class: "T3",
    instance_id: `T3-${index.toString().padStart(2, "0")}`,
    seed,
    prompt,
    params: { temperature: 0, max_tokens: 512 },
    expected: { functionName: template.functionName, testCases },
  };
}

export function generateT3Instances(parentSeed: number, count: number): TaskInstance<T3Expected>[] {
  return Array.from({ length: count }, (_, i) => generateT3Instance(parentSeed, i));
}
