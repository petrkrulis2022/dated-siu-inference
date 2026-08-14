import { randChoice, randInt, type Rng } from "../seed.js";

export interface TestCase {
  args: unknown[];
  expected: unknown;
}

export interface CodeTemplate {
  name: string;
  functionName: string;
  signature: string;
  description: string;
  /** The correct implementation — used only to compute expected outputs, never sent to the model. */
  reference: (...args: unknown[]) => unknown;
  generateTestCases: (rng: Rng) => TestCase[];
}

function randomIntArray(rng: Rng, length: number, min: number, max: number): number[] {
  return Array.from({ length }, () => randInt(rng, min, max));
}

const WORD_POOL = [
  "cat",
  "elephant",
  "dog",
  "hippopotamus",
  "ant",
  "giraffe",
  "fox",
  "rhinoceros",
  "owl",
  "salamander",
  "bee",
  "chimpanzee",
];

const filterAboveThreshold: CodeTemplate = {
  name: "filterAboveThreshold",
  functionName: "filterAboveThreshold",
  signature: "function filterAboveThreshold(nums, threshold)",
  description:
    "Write a JavaScript function `filterAboveThreshold(nums, threshold)` that returns a new array " +
    "containing every number in `nums` that is strictly greater than `threshold`, preserving their " +
    "original order. `nums` is an array of numbers; `threshold` is a number.",
  reference: (nums, threshold) => (nums as number[]).filter((n) => n > (threshold as number)),
  generateTestCases(rng) {
    const cases: TestCase[] = [];
    // Deliberate boundary case: a value exactly equal to the threshold, so an off-by-one
    // implementation using >= instead of > is actually caught, not just usually caught.
    const boundaryThreshold = randInt(rng, -10, 10);
    const boundaryNums = [boundaryThreshold - 1, boundaryThreshold, boundaryThreshold + 1];
    cases.push({
      args: [boundaryNums, boundaryThreshold],
      expected: filterAboveThreshold.reference(boundaryNums, boundaryThreshold),
    });
    for (let i = 0; i < 6; i++) {
      const length = randInt(rng, 0, 8);
      const nums = randomIntArray(rng, length, -20, 20);
      const threshold = randInt(rng, -20, 20);
      cases.push({
        args: [nums, threshold],
        expected: filterAboveThreshold.reference(nums, threshold),
      });
    }
    return cases;
  },
};

const cappedRunningTotal: CodeTemplate = {
  name: "cappedRunningTotal",
  functionName: "cappedRunningTotal",
  signature: "function cappedRunningTotal(nums, cap)",
  description:
    "Write a JavaScript function `cappedRunningTotal(nums, cap)` that returns an array of the running " +
    "total of `nums`, except the total is never allowed to exceed `cap` — once adding an element would " +
    "push the total above `cap`, the total for that position (and every position after it) is `cap`. " +
    "`nums` is an array of non-negative numbers; `cap` is a positive number.",
  reference: (nums, cap) => {
    let total = 0;
    const out: number[] = [];
    for (const n of nums as number[]) {
      total = Math.min(total + n, cap as number);
      out.push(total);
    }
    return out;
  },
  generateTestCases(rng) {
    const cases: TestCase[] = [];
    // Deliberate boundary case: a running total that lands exactly on the cap, then keeps
    // adding — catches an implementation that clamps with >= cap instead of once at cap.
    const cap = randInt(rng, 10, 20);
    cases.push({
      args: [[cap, 1, 2], cap],
      expected: cappedRunningTotal.reference([cap, 1, 2], cap),
    });
    for (let i = 0; i < 6; i++) {
      const length = randInt(rng, 0, 8);
      const nums = randomIntArray(rng, length, 0, 15);
      const randomCap = randInt(rng, 5, 50);
      cases.push({
        args: [nums, randomCap],
        expected: cappedRunningTotal.reference(nums, randomCap),
      });
    }
    return cases;
  },
};

const countLongerThan: CodeTemplate = {
  name: "countLongerThan",
  functionName: "countLongerThan",
  signature: "function countLongerThan(words, minLength)",
  description:
    "Write a JavaScript function `countLongerThan(words, minLength)` that returns the number of strings " +
    "in `words` whose length is strictly greater than `minLength`. `words` is an array of strings; " +
    "`minLength` is a non-negative integer.",
  reference: (words, minLength) =>
    (words as string[]).filter((w) => w.length > (minLength as number)).length,
  generateTestCases(rng) {
    const cases: TestCase[] = [];
    // Deliberate boundary case: a word whose length exactly equals minLength — catches an
    // off-by-one implementation using >= instead of >.
    const boundaryWord = randChoice(rng, WORD_POOL);
    cases.push({
      args: [[boundaryWord], boundaryWord.length],
      expected: countLongerThan.reference([boundaryWord], boundaryWord.length),
    });
    for (let i = 0; i < 6; i++) {
      const length = randInt(rng, 0, 8);
      const words = Array.from({ length }, () => randChoice(rng, WORD_POOL));
      const minLength = randInt(rng, 1, 8);
      cases.push({
        args: [words, minLength],
        expected: countLongerThan.reference(words, minLength),
      });
    }
    return cases;
  },
};

const dedupeStable: CodeTemplate = {
  name: "dedupeStable",
  functionName: "dedupeStable",
  signature: "function dedupeStable(nums)",
  description:
    "Write a JavaScript function `dedupeStable(nums)` that returns a new array with duplicate values " +
    "removed, keeping only each value's first occurrence and preserving the original relative order. " +
    "`nums` is an array of numbers.",
  reference: (nums) => {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const n of nums as number[]) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  },
  generateTestCases(rng) {
    const cases: TestCase[] = [];
    // Deliberate boundary case: a known, guaranteed-duplicate pattern — don't rely on
    // random luck to exercise the actual dedup logic.
    cases.push({
      args: [[1, 2, 1, 3, 2, 1]],
      expected: dedupeStable.reference([1, 2, 1, 3, 2, 1]),
    });
    for (let i = 0; i < 6; i++) {
      const length = randInt(rng, 0, 10);
      const nums = randomIntArray(rng, length, 0, 4); // small range forces genuine duplicates
      cases.push({ args: [nums], expected: dedupeStable.reference(nums) });
    }
    return cases;
  },
};

const nthLargest: CodeTemplate = {
  name: "nthLargest",
  functionName: "nthLargest",
  signature: "function nthLargest(nums, n)",
  description:
    "Write a JavaScript function `nthLargest(nums, n)` that returns the nth largest value in `nums`, " +
    "where `n` is 1-indexed (n=1 returns the largest value, n=2 the second largest, and so on). " +
    "Duplicate values each count as their own position. You may assume `nums.length >= n`.",
  reference: (nums, n) => [...(nums as number[])].sort((a, b) => b - a)[(n as number) - 1],
  generateTestCases(rng) {
    const cases: TestCase[] = [];
    // Deliberate boundary case: tied values at the target rank — catches an implementation
    // that dedupes before ranking instead of treating each occurrence as its own position.
    cases.push({ args: [[5, 5, 5, 3, 1], 2], expected: nthLargest.reference([5, 5, 5, 3, 1], 2) });
    for (let i = 0; i < 6; i++) {
      const length = randInt(rng, 1, 9);
      const nums = randomIntArray(rng, length, -20, 20);
      const n = randInt(rng, 1, length);
      cases.push({ args: [nums, n], expected: nthLargest.reference(nums, n) });
    }
    return cases;
  },
};

export const TEMPLATES: readonly CodeTemplate[] = [
  filterAboveThreshold,
  cappedRunningTotal,
  countLongerThan,
  dedupeStable,
  nthLargest,
];
