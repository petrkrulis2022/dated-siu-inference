import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Print, RunRecord } from "@touchstone/sdk";

const NON_PRINT_FILES = new Set(["latest.json", "index.json"]);

export interface PrintIndexEntry {
  print_id: string;
  date: string;
  status: "provisional" | "final";
  dated_siu: string;
  superseded_by?: { print_id: string; reason: string };
}

/** Every published print, oldest first. Renders directly from data/prints/ — build1-spec.md §7. */
export async function loadAllPrints(printsDir: string): Promise<Print[]> {
  const files = (await readdir(printsDir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json") && !NON_PRINT_FILES.has(f),
  );
  const prints: Print[] = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(printsDir, f), "utf-8")) as Print),
  );
  prints.sort((a: Print, b: Print) => a.date.localeCompare(b.date));
  return prints;
}

/**
 * Same filtering @touchstone/print's loadRunRecords uses, but taking an explicit runs root
 * instead of deriving one from process.cwd() — that derivation assumes a caller two directory
 * levels below the repo root (true for every packages/* caller), which site/ (one level below
 * root) doesn't satisfy. Matches loadAllPrints's own explicit-directory convention.
 */
export async function loadRunRecordsFor(runsDir: string, printId: string): Promise<RunRecord[]> {
  const dir = join(runsDir, printId);
  const files = (await readdir(dir).catch(() => [] as string[])).filter(
    (f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "reconciliation.json",
  );
  return Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf-8")) as RunRecord),
  );
}

export interface ChainInfo {
  attestationAddress: string;
  publisherAddress: string;
  explorerBaseUrl: string;
}

interface DeploymentRecord {
  network: { explorer: string };
  contracts: {
    TouchstoneAttestation: { address: string; constructorArgs: { publisher_: string } };
  };
}

/**
 * The TouchstoneAttestation address and its immutable publisher, read from the checked-in
 * deployment record (data/deployments/*.json) rather than hand-typed — the contract has no
 * publisher-rotation path, so this constructor arg is a permanent fact, not a live claim.
 */
export async function loadChainInfo(deploymentFile: string): Promise<ChainInfo> {
  const record: DeploymentRecord = JSON.parse(await readFile(deploymentFile, "utf-8"));
  return {
    attestationAddress: record.contracts.TouchstoneAttestation.address,
    publisherAddress: record.contracts.TouchstoneAttestation.constructorArgs.publisher_,
    explorerBaseUrl: record.network.explorer,
  };
}
