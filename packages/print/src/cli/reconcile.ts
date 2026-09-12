import { join } from "node:path";
import {
  bodyHashHex,
  loadDeployment,
  reconciliationBodyOf,
  signReconciliation,
  type ReconciliationBody,
  type ReconciliationRecord,
} from "@touchstone/sdk";
import {
  reconcile,
  formatReconciliationReport,
  type ReconciliationRecord as HarnessReconciliationRecord,
} from "@touchstone/harness";
import { D, sum } from "../decimal.js";
import { loadPublisherKeyFromEnv, verifyPrintSignature } from "../sign/sign.js";
import { OnChainAttestationClient } from "../anchor/on-chain.js";
import { StubAttestationClient, type AttestationClient } from "../anchor/attestation.js";
import { writeReconciliation } from "../publication.js";
import { loadPrint, loadRegistry, printsDir, reconciliationsDir } from "./load-inputs.js";

/**
 * Reconciles a published print against real provider invoices — docs/methodology.md §7.
 *
 * Deliberately does NOT recompute cost from run records: print.cost_of_production_usd already
 * sums every recorded attempt across every measured model (packages/print/src/compute/
 * cost-of-production.ts, includes the reasoning-token fix), so there is exactly one computation
 * of a print's real cost, reused here rather than duplicated — the duplication is exactly what
 * let the old harness/src/cli/reconcile.ts drift out of date with that fix in the first place.
 *
 * Deliberately does NOT edit the print. A print's signed body (including status, permanently
 * "provisional") is untouched forever — reconciliation is a separate signed, anchored record in
 * data/reconciliations/<print_id>.json, referencing the print by id. A print is "final" exactly
 * when a valid record like this exists — see publication.ts's loadReconciledPrintIds.
 *
 * Usage: reconcile <print-id> --<provider>=<usd> [--<provider>=<usd> ...]
 * One flag per real billing source actually used in this print (openrouter/anthropic/openai/
 * google/xai, or whichever the registry's `provider` field says) — every provider present in
 * the print's own basket_costs (qualifying or excluded; cost_of_production_usd counts both) must
 * be supplied, or this refuses rather than silently reconciling against a partial total.
 */

const printId = process.argv[2];
const flagArgs = process.argv.slice(3);
if (!printId || flagArgs.length === 0) {
  console.error("Usage: reconcile <print-id> --<provider>=<usd> [--<provider>=<usd> ...]");
  process.exit(1);
}

const invoiceByProvider = new Map<string, string>();
for (const arg of flagArgs) {
  const match = /^--([a-z0-9-]+)=(.+)$/i.exec(arg);
  if (!match) {
    console.error(`Unrecognised argument "${arg}" — expected --<provider>=<usd>.`);
    process.exit(1);
  }
  invoiceByProvider.set(match[1], match[2]);
}

const print = await loadPrint(join(printsDir(), `${printId}.json`));

const signatureCheck = verifyPrintSignature(print);
if (!signatureCheck.valid) {
  console.error(
    `Refusing to reconcile ${printId}: its own signature does not verify (${signatureCheck.reason}).`,
  );
  process.exit(1);
}

const registry = await loadRegistry();
const providerById = new Map(registry.map((r) => [r.id, r.provider]));
// Every model this print actually recorded cost for — qualifying or excluded, since
// cost_of_production_usd sums both. A model no longer in the current registry (removed since
// this print was published) can't be mapped to a provider here; this is a known limitation for
// reconciling an old print against a since-changed registry, not something this CLI resolves.
const providersUsed = new Set(
  [...print.basket_costs]
    .map((bc) => providerById.get(bc.model_id))
    .filter((p): p is string => !!p),
);

const missing = [...providersUsed].filter((p) => !invoiceByProvider.has(p));
if (missing.length > 0) {
  console.error(
    `Missing invoice figures for provider(s) actually used in ${printId}: ${missing.join(", ")}.`,
  );
  process.exit(1);
}
const unexpected = [...invoiceByProvider.keys()].filter((p) => !providersUsed.has(p));
if (unexpected.length > 0) {
  console.error(
    `Provider(s) supplied but not actually used in ${printId} (typo?): ${unexpected.join(", ")}.`,
  );
  process.exit(1);
}

// provider_breakdown is a minItems:1 tuple by schema; invoiceByProvider.size >= 1 is already
// guaranteed above (flagArgs.length > 0 was checked before any entry was added), so this cast is
// asserting a real invariant, not working around a genuine possibility of an empty array.
const providerBreakdown = [...invoiceByProvider.entries()]
  .map(([provider, invoice_usd]) => ({ provider, invoice_usd }))
  .sort((a, b) =>
    a.provider.localeCompare(b.provider),
  ) as ReconciliationBody["provider_breakdown"];
// invoice_usd is computed AS this sum, not supplied independently — so it can never disagree
// with provider_breakdown's own total, by construction rather than by a separate runtime check.
const invoiceUsd = sum(providerBreakdown.map((p) => new D(p.invoice_usd))).toString();

const computedUsd = print.cost_of_production_usd;
const harnessRecord: HarnessReconciliationRecord = reconcile(printId, computedUsd, invoiceUsd);
console.log(formatReconciliationReport(harnessRecord));
console.log("  Provider breakdown:");
for (const { provider, invoice_usd } of providerBreakdown) {
  console.log(`    ${provider}: $${invoice_usd}`);
}

if (harnessRecord.status !== "final") {
  console.log(
    "\nNot reconciled — nothing written. The print stays provisional, which already discloses " +
      '"not yet reconciled" honestly; re-run once a corrected invoice figure is available.',
  );
  process.exit(1);
}

const privateKeyHex = loadPublisherKeyFromEnv();
const body = {
  schema_version: "1.0",
  print_id: printId,
  computed_usd: computedUsd,
  invoice_usd: invoiceUsd,
  provider_breakdown: providerBreakdown,
  relative_delta: harnessRecord.relative_delta,
  tolerance: harnessRecord.tolerance,
  reconciled_at: harnessRecord.reconciled_at,
};
const signed = signReconciliation(body, privateKeyHex);

// Same fail-fast RPC convention as cli/publish.ts: TOUCHSTONE_CHAIN_NAME (default base-sepolia),
// RPC URL from <NETWORK>_RPC_URL, StubAttestationClient only when no chain is configured at all.
const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
const rpcUrl = process.env[rpcEnvVar];
const attestationClient: AttestationClient = rpcUrl
  ? new OnChainAttestationClient({
      rpcUrl,
      contractAddress: loadDeployment(chainName).contracts.TouchstoneAttestation.address,
      privateKeyHex,
      chainName,
    })
  : new StubAttestationClient();
if (!rpcUrl) {
  console.warn(`${rpcEnvVar} is not set — anchoring with StubAttestationClient (no real anchor).`);
}

// Anchored the same way a print is: postPrint(bodyHash, version) doesn't care whose hash it
// is — reconciliationBodyOf strips signature/public_key/anchor the same way printBodyOf does,
// and bodyHashHex is the same generic primitive both packages build on.
const hashHex = bodyHashHex(reconciliationBodyOf(signed));
const anchor = await attestationClient.postPrint(hashHex, `reconciliation-${signed.schema_version}`);

if (anchor.status === "failed") {
  console.error(`Refusing to write: anchoring failed (${anchor.notes ?? "no further detail"}).`);
  process.exit(1);
}

const record: ReconciliationRecord = { ...signed, anchor };
const { path } = await writeReconciliation(reconciliationsDir(), record);
console.log(`\nWrote ${path}`);
console.log(`Anchor: ${anchor.status} (${anchor.chain})`);
console.log(`${printId} is now final: docs/methodology.md §7 — presence of this record IS final.`);
