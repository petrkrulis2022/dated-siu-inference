import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadSchema(relativePath: string, importMetaUrl: string): object {
  const path = fileURLToPath(new URL(relativePath, importMetaUrl));
  return JSON.parse(readFileSync(path, "utf-8"));
}
