import {
  generateT1Instances,
  generateT2Instances,
  generateT3Instances,
  toSeed,
} from "@datum/basket";
import { estimateCost, formatDryRunReport } from "../dry-run.js";
import { loadLatestPriceSnapshot, loadRegistry } from "./load-data.js";

const printSeedMaterial = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const printSeed = toSeed(printSeedMaterial);

const registry = await loadRegistry();
const priceSnapshot = await loadLatestPriceSnapshot("openrouter");
const instances = [
  ...generateT1Instances(printSeed, 5),
  ...generateT2Instances(printSeed, 5),
  ...generateT3Instances(printSeed, 5),
];

const result = estimateCost(registry, priceSnapshot, instances);
console.log(formatDryRunReport(result));
console.log(`\n(print seed material: "${printSeedMaterial}")`);
console.log("No API calls were made.");
