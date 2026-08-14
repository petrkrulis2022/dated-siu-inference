import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeResult, TaskInstance } from "../types.js";
import type { T3Expected } from "./generate.js";
import { RUNNER_SOURCE } from "./runner-source.js";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_HEAP_MB = 256;

/** Strips a ```js/```javascript fence if present; otherwise returns the text as-is. */
function extractCode(raw: string): string {
  const fenced = raw.match(/```(?:js|javascript)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * If the code declares the target function but never exports it, add the export. If the
 * function isn't declared at all, leaves the code untouched — appending `export { name }`
 * for a name that was never declared produces an invalid module (a SyntaxError at import
 * time), which would mask the actual problem behind a confusing error instead of the
 * runner's clean "no exported function named X" result.
 */
function ensureExported(code: string, functionName: string): string {
  const alreadyExported = new RegExp(
    `export\\s+(default\\s+)?(async\\s+)?function\\s+${functionName}\\b|export\\s*\\{[^}]*\\b${functionName}\\b`,
  ).test(code);
  if (alreadyExported) {
    return code;
  }

  const isDeclared = new RegExp(
    `(^|\\s)(async\\s+)?function\\s+${functionName}\\b|(^|\\s)(const|let|var)\\s+${functionName}\\b`,
  ).test(code);
  if (!isDeclared) {
    return code;
  }

  return `${code}\n\nexport { ${functionName} };\n`;
}

async function unshareAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn("unshare", ["--net", "--map-root-user", "--", "true"]);
    check.on("error", () => resolve(false));
    check.on("close", (code) => resolve(code === 0));
  });
}

interface SandboxResult {
  passed: boolean;
  error?: string;
  results?: { index: number; passed: boolean; error?: string }[];
}

function runSandboxed(
  tempDir: string,
  timeoutMs: number,
): Promise<{ result?: SandboxResult; timedOut: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(
      "unshare",
      [
        "--net",
        "--map-root-user",
        "--",
        "node",
        `--max-old-space-size=${MAX_HEAP_MB}`,
        "runner.mjs",
      ],
      { cwd: tempDir, timeout: timeoutMs, killSignal: "SIGKILL" },
    );

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      resolve({ timedOut: false, stderr: `${stderr}\n${String(err)}` });
    });
    child.on("close", (_code, signal) => {
      if (signal === "SIGKILL" || signal === "SIGTERM") {
        timedOut = true;
      }
      try {
        const result = stdout.trim() ? (JSON.parse(stdout.trim()) as SandboxResult) : undefined;
        resolve({ result, timedOut, stderr });
      } catch {
        resolve({ timedOut, stderr: `${stderr}\nUnparsable stdout: ${stdout}` });
      }
    });
  });
}

export async function gradeT3(
  instance: TaskInstance<T3Expected>,
  rawResponse: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GradeResult> {
  if (!(await unshareAvailable())) {
    throw new Error(
      "`unshare --net` is not available in this environment — refusing to grade T3 without network " +
        "isolation rather than silently falling back to an unsandboxed execution.",
    );
  }

  const code = ensureExported(extractCode(rawResponse), instance.expected.functionName);

  const tempDir = await mkdtemp(join(tmpdir(), "datum-t3-sandbox-"));
  try {
    await writeFile(join(tempDir, "candidate.mjs"), code, "utf-8");
    await writeFile(join(tempDir, "runner.mjs"), RUNNER_SOURCE, "utf-8");
    await writeFile(
      join(tempDir, "tests.json"),
      JSON.stringify({
        functionName: instance.expected.functionName,
        testCases: instance.expected.testCases,
      }),
      "utf-8",
    );

    const { result, timedOut, stderr } = await runSandboxed(tempDir, timeoutMs);

    if (timedOut) {
      return { passed: false, reason: `Execution exceeded the ${timeoutMs}ms hard timeout.` };
    }
    if (!result) {
      return { passed: false, reason: `Sandbox produced no parseable result. stderr: ${stderr}` };
    }
    if (result.error) {
      return { passed: false, reason: result.error };
    }
    if (!result.passed) {
      const failed = (result.results ?? []).filter((r) => !r.passed);
      return {
        passed: false,
        reason: `${failed.length}/${result.results?.length ?? 0} hidden test case(s) failed.`,
      };
    }
    return { passed: true };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
