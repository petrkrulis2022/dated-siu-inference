import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** The permanent combined hostile fixture — env exfiltration, network egress, path traversal,
 * a busy-loop, and a fork bomb, all in one submission. See hostile.mjs.txt's own header comment
 * for why it's staged as `.txt` rather than imported directly. */
export async function loadHostileFixture(): Promise<string> {
  return readFile(join(FIXTURES_DIR, "hostile.mjs.txt"), "utf-8");
}
