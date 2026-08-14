import { diffLatestSnapshots, formatDiffReport } from "../snapshot/diff.js";
import { registryDir } from "./paths.js";

const source = process.argv[2] === "litellm" ? "litellm" : "openrouter";
const diff = await diffLatestSnapshots(registryDir(), source);
console.log(`prices:diff [${source}]`);
console.log(formatDiffReport(diff));
