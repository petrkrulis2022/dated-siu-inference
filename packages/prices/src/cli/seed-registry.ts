import { seedRegistry, writeRegistry } from "../registry/index.js";
import { registryModelsPath } from "./paths.js";

const result = await seedRegistry();
await writeRegistry(registryModelsPath(), result.entries);

console.log(`Resolved ${result.entries.length} registry entries -> ${registryModelsPath()}`);
for (const entry of result.entries) {
  console.log(`  ${entry.id} (${entry.tier}, ${entry.host}) -> ${entry.model_string}`);
}
if (result.skipped.length > 0) {
  console.log(`\nSkipped (missing API keys):`);
  for (const s of result.skipped) {
    console.log(`  ${s.registry_id}: ${s.reason}`);
  }
}
