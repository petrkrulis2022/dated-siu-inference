#!/usr/bin/env node
// `pnpm console` — starts the read-only API (via tsx, no separate build step needed) and the
// Vite dev server (which proxies /api to it) together. Hand-rolled rather than adding
// `concurrently` as a dependency: spawning two child processes is a handful of lines, and this
// repo already prefers a small hand-rolled utility over a new dependency for exactly this kind
// of thing (see packages/basket/src/seed.ts's mulberry32).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));

function run(name, command, args) {
  const child = spawn(command, args, { cwd: packageDir, stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[console] ${name} exited (${code}) — stopping.`);
    process.exit(code ?? 1);
  });
  return child;
}

console.log("[console] starting API (tsx server/index.ts) and the Vite dev server...");
const api = run("api", "pnpm", ["exec", "tsx", resolve(packageDir, "server/index.ts")]);
const web = run("web", "pnpm", [
  "exec",
  "vite",
  "--config",
  resolve(packageDir, "web/vite.config.ts"),
]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    api.kill(signal);
    web.kill(signal);
    process.exit(0);
  });
}
