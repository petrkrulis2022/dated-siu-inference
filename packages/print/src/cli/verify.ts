import { join } from "node:path";
import { formatVerifyReport, verifyPrint } from "../verify.js";
import { loadPrint, printsDir } from "./load-inputs.js";
import { buildVerifyInput } from "./verify-support.js";

const target = process.argv[2];
if (!target) {
  console.error("Usage: verify <print-id | path-to-print.json>");
  process.exit(1);
}

const path = target.endsWith(".json") ? target : join(printsDir(), `${target}.json`);
const print = await loadPrint(path);

const { input, manifestDiscrepancy, loadErrorMessage } = await buildVerifyInput(print);
if (loadErrorMessage) {
  console.warn(`Could not load recomputation inputs (${loadErrorMessage}).`);
  console.warn("Falling back to a signature-only check.\n");
}

const result = verifyPrint(print, input);
if (manifestDiscrepancy) {
  result.ok = false;
  result.discrepancies.push(manifestDiscrepancy);
}
console.log(formatVerifyReport(print, result));
process.exit(result.ok ? 0 : 1);
