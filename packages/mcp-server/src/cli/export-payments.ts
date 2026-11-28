import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertGitIgnored } from "../private-output.js";
import { exportPayments, utcDay, type ClassifiedSettlementRow } from "../settlement-csv.js";
import { formatUsdc } from "../treasury/gateway-withdrawal.js";
import { HARDWARE_WALLET_THRESHOLD_USDC, hardwareWalletAlert, readTreasuryTotal } from "../treasury/treasury-total.js";
import { TREASURY_ADDRESS } from "../workers/wallet-labels.js";

/**
 * Exports the settlement log to one bookkeeping CSV per complete UTC day under data/private/payments/
 * (gitignored), filling in every day not yet on disk, so a missed run costs nothing.
 *
 *   pnpm --filter @touchstone/mcp-server run payments:export [-- --day YYYY-MM-DD]... [--out DIR]
 *
 * --day writes that day again although its file exists. Reads the live D1 database through
 * `wrangler d1 execute --remote` under the operator's own Cloudflare login: no token of its own, and
 * no public endpoint. Wrangler needs Node 22; scripts/export-payments.sh sets that up for cron.
 *
 * Every run also totals the treasury (wallet plus Gateway balance, Base and Arc mainnet). Once that is
 * more than $100, it alerts once per UTC day: a line in the log, data/private/ALERT-treasury-hardware-
 * wallet.txt, and a Windows message box when running under WSL. The owner's decision of 2026-11-28 is
 * that the treasury, a dedicated hot wallet in MetaMask today, moves to a hardware wallet then.
 */

const execFileP = promisify(execFile);
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = resolve(PACKAGE_DIR, "../../data/private/payments");
const DATABASE = "touchstone-settlements";
const COLUMNS = "id, at, tool, network, route, amount, payer, reference, batch_tx, traffic, via";

function parseArgs(argv: string[]): { out: string; forceDays: string[] } {
  let out = DEFAULT_OUT;
  const forceDays: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--") continue;
    if ((arg === "--out" || arg === "--day") && value !== undefined) {
      if (arg === "--out") out = resolve(value);
      else forceDays.push(value);
      i++;
    } else throw new Error(`unknown argument ${JSON.stringify(arg)}; usage: [--day YYYY-MM-DD]... [--out DIR]`);
  }
  return { out, forceDays };
}

/** A day as it may appear inside SQL: only ever YYYY-MM-DD, checked here, never free text. */
function sqlDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`not a day: ${JSON.stringify(day)}`);
  return `'${day}T00:00:00.000Z'`;
}

async function d1<T>(sql: string): Promise<T[]> {
  const { stdout } = await execFileP(
    "npx",
    ["wrangler", "d1", "execute", DATABASE, "--remote", "--json", "--command", sql],
    { cwd: PACKAGE_DIR, maxBuffer: 256 * 1024 * 1024 },
  );
  const parsed: unknown = JSON.parse(stdout);
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { success?: boolean; results?: T[] } | undefined;
  if (!first?.success || !Array.isArray(first.results)) throw new Error(`D1 query failed: ${stdout.slice(0, 300)}`);
  return first.results;
}

async function main(): Promise<void> {
  const { out, forceDays } = parseArgs(process.argv.slice(2));
  assertGitIgnored(join(out, "0000-00-00.csv"));
  const existingDays = new Set(
    existsSync(out)
      ? (await readdir(out)).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).map((f) => f.slice(0, 10))
      : [],
  );
  const result = await exportPayments({
    today: new Date().toISOString().slice(0, 10),
    existingDays,
    forceDays,
    firstDay: async () => {
      const [row] = await d1<{ first: string | null }>("SELECT min(at) AS first FROM settlements");
      return row?.first ? utcDay(row.first) : undefined;
    },
    query: (from, to) =>
      d1<ClassifiedSettlementRow>(
        `SELECT ${COLUMNS} FROM settlements_classified WHERE at >= ${sqlDay(from)} AND at < ${sqlDay(to)} ORDER BY at, id`,
      ),
    write: async (day, csv) => {
      const path = join(out, `${day}.csv`);
      assertGitIgnored(path);
      await mkdir(out, { recursive: true });
      // Written whole, then renamed: a day's file exists only once it is complete.
      await writeFile(`${path}.partial`, csv, "utf-8");
      await rename(`${path}.partial`, path);
    },
  });
  const stamp = new Date().toISOString();
  if (result.days.length === 0) {
    console.log(`${stamp} payments export: up to date (${existingDays.size} day file(s) in ${out})`);
  } else {
    const traffic = Object.entries(result.byTraffic)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    console.log(
      `${stamp} payments export: wrote ${result.days.length} day(s), ${result.days[0]} to ${result.days.at(-1)}; ` +
        `${result.rows} payment(s)${traffic ? ` (${traffic})` : ""} -> ${out}`,
    );
  }
  await checkTreasuryTotal(dirname(out));
}

/** Totals the treasury and raises the hardware-wallet alert when due. Never fails the export. */
async function checkTreasuryTotal(privateDir: string): Promise<void> {
  const stamp = new Date().toISOString();
  try {
    const { parts, total } = await readTreasuryTotal({ treasury: TREASURY_ADDRESS });
    console.log(
      `${stamp} treasury total ${formatUsdc(total)} USDC (${parts.map((p) => `${p.where} ${formatUsdc(p.amount)}`).join(", ")}); ` +
        `hardware wallet at more than ${formatUsdc(HARDWARE_WALLET_THRESHOLD_USDC)}`,
    );
    const statePath = join(privateDir, "hardware-wallet-alert.json");
    const alertPath = join(privateDir, "ALERT-treasury-hardware-wallet.txt");
    assertGitIgnored(statePath);
    assertGitIgnored(alertPath);
    let lastAlertDay: string | undefined;
    try {
      lastAlertDay = (JSON.parse(await readFile(statePath, "utf-8")) as { lastAlertDay?: string }).lastAlertDay;
    } catch {
      lastAlertDay = undefined;
    }
    const today = stamp.slice(0, 10);
    const alert = hardwareWalletAlert({ total, lastAlertDay, today });
    if (!alert) return;
    console.log(`${stamp} ${alert}`);
    await mkdir(privateDir, { recursive: true });
    await writeFile(alertPath, `${stamp}\n${alert}\n`, "utf-8");
    await writeFile(statePath, JSON.stringify({ lastAlertDay: today, total: formatUsdc(total) }) + "\n", "utf-8");
    notifyDesktop(alert);
  } catch (e) {
    console.log(`${stamp} treasury total check failed (the export itself is unaffected): ${(e as Error).message}`);
  }
}

/** Best effort: a Windows message box when running under WSL; nothing elsewhere. Never blocks. */
function notifyDesktop(message: string): void {
  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (!existsSync(powershell)) return;
  const script =
    "Add-Type -AssemblyName PresentationFramework; " +
    `[System.Windows.MessageBox]::Show('${message.replaceAll("'", "''")}', 'Touchstone treasury') | Out-Null`;
  try {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // best effort: the log line and the alert file are the record
  }
}

main().catch((err: unknown) => {
  console.error(`${new Date().toISOString()} payments export FAILED:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
