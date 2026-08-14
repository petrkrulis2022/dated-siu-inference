import { buildGpuRateSnapshot } from "../floor/gpu-rate-snapshot.js";
import { writeGpuRateSnapshot } from "../floor/write-gpu-rate-snapshot.js";
import { registryDir } from "./paths.js";

// H100 SXM 80GB: cross-validated as the reference GPU during P5 — Akash and Vast.ai
// independently quoted overlapping $1.5-3.2/hr ranges for it.
const REFERENCE_GPU = {
  akashModel: "h100",
  vastaiGpuName: "H100 SXM",
  label: "NVIDIA H100 SXM 80GB",
};

const timestamp = new Date().toISOString();
const snapshot = await buildGpuRateSnapshot(REFERENCE_GPU, timestamp, timestamp);
const path = await writeGpuRateSnapshot(registryDir(), snapshot);

console.log(`Wrote GPU rate snapshot -> ${path}`);
for (const entry of snapshot.entries) {
  console.log(`  ${entry.source}: $${entry.rate_usd_per_hour}/hr (n=${entry.sample_size})`);
}
