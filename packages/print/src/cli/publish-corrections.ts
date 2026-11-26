/**
 * Publishes the corrections of published prints (docs/methodology.md, the revision policy's error procedure), through publish-correction.ts:
 * each print named becomes the next numbered revision, recomputed from its own run records and price snapshot under CORRECTION_RULES_REVISION,
 * signed, anchored and written append-only, naming its original in `supersedes`; the original gains `superseded_by`. latest.json never moves
 * back to an older date.
 *
 * Every correction is computed and checked before the first one is signed: the qualifying set must not change, something must change, the cause
 * of each change must be nameable (correctionReason), and with --expect every value must equal the approved dry run's. One failure stops the
 * run before anything is written.
 *
 *   Scratch:  node dist/cli/publish-corrections.js --scratch [--expect <dry-run.json>] [--summary <file.json>] <print_id>...
 *             Signs with a throwaway key and anchors nowhere. Refuses to run inside a git checkout: run it in a copy of the repository.
 *   Real:     node dist/cli/publish-corrections.js --yes --expect <dry-run.json> [--summary <file.json>] <print_id>...
 *             The publisher key and chains from the environment, as cli/publish-unattended.ts reads them. Only on the owner's go.
 */
import { randomBytes } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadDeployment, type Print } from "@touchstone/sdk";
import { createPublicClient, http, parseEther, type Hex } from "viem";
import {
  FallbackAttestationClient,
  SkippingAttestationClient,
  StubAttestationClient,
  type AttestationClient,
  type SecondaryAttestation,
} from "../anchor/attestation.js";
import { OnChainAttestationClient } from "../anchor/on-chain.js";
import { computePrint } from "../compute/index.js";
import { correctionInput, CORRECTION_RULES_REVISION, nextRevisionId } from "../correction.js";
import { correctionReason, publishCorrection } from "../publish-correction.js";
import { loadPublisherKeyFromEnv } from "../sign/sign.js";
import { loadPrint, printsDir, repoRoot } from "./load-inputs.js";
import { buildVerifyInput } from "./verify-support.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scratch = flag("--scratch");
const expectPath = valueOf("--expect");
const summaryPath = valueOf("--summary");
const valued = new Set(["--expect", "--summary"]);
const ids = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? "")).sort();

if (ids.length === 0) {
  console.error("Name at least one print_id to correct.");
  process.exit(2);
}
if (!scratch && !flag("--yes")) {
  console.error("Publishing corrections signs and anchors them for real: pass --yes (with --expect), or --scratch for a dry run in a copy.");
  process.exit(2);
}
if (!scratch && !expectPath) {
  console.error("A real run needs --expect <dry-run.json>: the values published must be the values the owner approved.");
  process.exit(2);
}
if (scratch) {
  const inCheckout = await access(join(repoRoot(), ".git"))
    .then(() => true)
    .catch(() => false);
  if (inCheckout) {
    console.error(`--scratch refuses to run inside a git checkout (${repoRoot()}): copy the repository without .git and run it there.`);
    process.exit(2);
  }
}

/** The fields computePrint produces, compared with the approved dry run's corrected body. */
const COMPARED = ["dated_siu", "dated_siu_median_diagnostic", "basket_costs", "weights", "exchange_rate_table", "sensitivity_block", "cost_of_production_usd"] as const;
const approved = new Map<string, Record<string, unknown>>();
if (expectPath) {
  const rows = JSON.parse(await readFile(expectPath, "utf-8")) as { print_id: string; corrected_body: Record<string, unknown> }[];
  for (const r of rows) approved.set(r.print_id, r.corrected_body);
}

// 1. Compute and check every correction before anything is signed.
interface Planned {
  original: Print;
  input: ReturnType<typeof correctionInput>;
  reason: string;
  datedSiu: string;
}
const planned: Planned[] = [];
const problems: string[] = [];
for (const id of ids) {
  try {
    const original = await loadPrint(join(printsDir(), `${id}.json`));
    if (original.superseded_by) throw new Error(`already superseded by ${original.superseded_by.print_id}`);
    const revisionId = nextRevisionId(original.print_id);
    const built = await buildVerifyInput({
      ...original,
      print_id: revisionId,
      methodology_revision: CORRECTION_RULES_REVISION,
      supersedes: { print_id: original.print_id, reason: "planned" },
    });
    if (!built.input) throw new Error(`could not build the recomputation: ${built.loadErrorMessage ?? "unknown error"}`);
    const input = correctionInput(original, built.input);
    const { body } = computePrint({ ...input, status: original.status });
    if (expectPath) {
      const want = approved.get(id);
      if (!want) throw new Error(`not in the approved dry run (${expectPath})`);
      const differs = COMPARED.filter((k) => JSON.stringify(body[k as keyof typeof body] ?? null) !== JSON.stringify(want[k] ?? null));
      if (differs.length > 0) throw new Error(`differs from the approved dry run in ${differs.join(", ")}`);
    }
    planned.push({ original, input, reason: correctionReason(original, body, input), datedSiu: body.dated_siu });
  } catch (err) {
    problems.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (problems.length > 0) {
  console.error(`Nothing was published: ${problems.length} of ${ids.length} correction(s) did not check out:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`${planned.length} correction(s) computed and checked${expectPath ? " against the approved dry run" : ""}.`);

// 2. Keys and chains.
let privateKeyHex: string;
let attestationClient: AttestationClient;
let secondaryAttestations: SecondaryAttestation[] = [];
if (scratch) {
  privateKeyHex = `0x${randomBytes(32).toString("hex")}`;
  attestationClient = new StubAttestationClient();
  console.log("Scratch run: signed with a throwaway key, anchored nowhere.");
} else {
  privateKeyHex = loadPublisherKeyFromEnv();
  const publisherAddress = process.env.TOUCHSTONE_PUBLISHER_ADDRESS;
  const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
  const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  const rpcUrl = process.env[rpcEnvVar];
  if (!publisherAddress || !rpcUrl) {
    console.error(`TOUCHSTONE_PUBLISHER_ADDRESS and ${rpcEnvVar} must be set: a correction is anchored like any print.`);
    process.exit(1);
  }
  const balance = await createPublicClient({ transport: http(rpcUrl) }).getBalance({ address: publisherAddress as Hex });
  if (balance < parseEther("0.01")) {
    console.error(`Publisher balance on ${chainName} is ${balance} wei, below 0.01 ETH: refusing to start a run that may not be able to anchor.`);
    process.exit(1);
  }
  attestationClient = new OnChainAttestationClient({
    rpcUrl,
    contractAddress: loadDeployment(chainName).contracts.TouchstoneAttestation.address,
    privateKeyHex,
    chainName,
  });
  // Arc Testnet, best-effort, as for the daily print: about 0.0012 USDC an anchor. Too little for the whole run and the Arc anchors are skipped,
  // with the reason recorded in each correction.
  const arcRpcUrls = [process.env.ARC_TESTNET_RPC_URL, process.env.ARC_TESTNET_RPC_URL_2].filter((u): u is string => Boolean(u));
  if (arcRpcUrls.length > 0) {
    const arcContract = loadDeployment("arc-testnet").contracts.TouchstoneAttestation.address;
    const needed = BigInt(planned.length) * 1_200_000_000_000_000n;
    let arcBalance: bigint | undefined;
    for (const url of arcRpcUrls) {
      try {
        arcBalance = await createPublicClient({ transport: http(url) }).getBalance({ address: publisherAddress as Hex });
        break;
      } catch {
        // This provider did not answer; try the next.
      }
    }
    if (arcBalance !== undefined && arcBalance < needed) {
      const reason = `publisher balance on Arc Testnet is ${arcBalance} wei, below the ${needed} wei ${planned.length} anchors need; top it up from the Arc faucet`;
      console.log(`ARC_ANCHOR_SKIPPED ${JSON.stringify({ reason })}`);
      secondaryAttestations = [{ chainName: "arc-testnet", client: new SkippingAttestationClient(reason) }];
    } else {
      const clients = arcRpcUrls.map(
        (url) =>
          new OnChainAttestationClient({
            rpcUrl: url,
            contractAddress: arcContract,
            privateKeyHex,
            chainName: "arc-testnet",
            nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 18 },
          }),
      );
      secondaryAttestations = [{ chainName: "arc-testnet", client: new FallbackAttestationClient(clients) }];
    }
  }
}

// 3. Publish, oldest first. A failure stops the run; what was written before it stands, each one complete.
const summary: Record<string, unknown>[] = [];
for (const p of planned) {
  const result = await publishCorrection(printsDir(), {
    original: p.original,
    input: p.input,
    reason: p.reason,
    privateKeyHex,
    attestationClient,
    secondaryAttestations,
  });
  summary.push({
    original: p.original.print_id,
    revision: result.print.print_id,
    dated_siu: { original: p.original.dated_siu, corrected: result.print.dated_siu },
    written: result.write.path.slice(repoRoot().length + 1),
    latest_json: result.write.latestWritten,
    anchor: result.print.anchor?.status,
    additional_anchors: (result.print.anchor?.additional_anchors ?? []).map((a) => `${a.chain}: ${a.status}`),
    original_superseded_by: result.original.superseded_by?.print_id,
    reason: p.reason,
  });
  console.log(`${p.original.print_id} -> ${result.print.print_id}  dated_siu ${p.original.dated_siu} -> ${result.print.dated_siu}  anchor ${result.print.anchor?.status}`);
}
if (summaryPath) await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
console.log(`Published ${summary.length} correction(s).`);
