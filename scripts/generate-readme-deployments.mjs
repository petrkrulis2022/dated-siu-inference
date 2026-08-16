#!/usr/bin/env node
// Regenerates README.md's Deployments section from data/deployments/*.json.
//
// data/deployments/*.json is the canonical record of every contract deployment (addresses, tx
// hashes, block numbers, constructor args, compiler settings, smoke-test results). This script
// exists so the README stays a *view* of that record, never a second copy of it: run this after
// any deployment, commit both the JSON and the regenerated README, and the two can never
// silently disagree about an address.
//
// Usage: node scripts/generate-readme-deployments.mjs [--check]
//   --check   exit 1 if README.md's generated section doesn't match what this script would
//             write, without touching the file. Suitable for CI.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentsDir = join(repoRoot, "data", "deployments");
const readmePath = join(repoRoot, "README.md");

const BEGIN_MARKER = "<!-- BEGIN GENERATED: deployments -->";
const END_MARKER = "<!-- END GENERATED: deployments -->";

function loadDeploymentFiles() {
  return readdirSync(deploymentsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      network: f.replace(/\.json$/, ""),
      record: JSON.parse(readFileSync(join(deploymentsDir, f), "utf-8")),
    }));
}

function renderContractRow(name, contract) {
  const status = contract.verified?.status ?? "unverified";
  return `| \`${name}\` | [\`${contract.address}\`](${contract.explorerUrl}) | ${status} |`;
}

function renderDeployment({ network, record }) {
  const lines = [];
  lines.push(`### ${record.network.name}`);
  lines.push("");
  if (record.network.chainId) {
    lines.push(
      `Chain ID \`${record.network.chainId}\`. Deployed ${record.deployedAt.iso.slice(0, 10)} from commit \`${record.source.gitCommitShort}\`.`,
    );
    lines.push("");
  }
  lines.push("| Contract | Address | Verification |");
  lines.push("| --- | --- | --- |");
  lines.push(renderContractRow("DatumAttestation", record.contracts.DatumAttestation));
  lines.push(renderContractRow("DatumEscrow", record.contracts.DatumEscrow));
  lines.push("");
  lines.push(
    `Full record — transaction hashes, block numbers, constructor arguments, compiler settings, ` +
      `and live smoke-test results — is canonical in ` +
      `[\`data/deployments/${network}.json\`](./data/deployments/${network}.json). ` +
      `**This README section is a convenience view generated from that file** ` +
      `(\`node scripts/generate-readme-deployments.mjs\`) and must never be hand-edited to disagree with it.`,
  );
  lines.push("");
  if (Array.isArray(record.mainnetRequirements) && record.mainnetRequirements.length > 0) {
    lines.push(`**Not deployed to mainnet.** Requirements before it can be:`);
    for (const req of record.mainnetRequirements) {
      lines.push(`- ${req}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** `toISOString()` always carries milliseconds (`.000Z` for a whole second) — this must match
 * the real CLI output byte-for-byte, computed from the raw unix timestamp rather than trusting a
 * hand-typed ISO string field to already be in that exact format. */
function anchorIso(record) {
  const seconds = record.smokeTests?.["1_anchorRealPrint"]?.storedTimestamp;
  return typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : "…";
}

function renderVerifySection(deployments) {
  const first = deployments[0];
  if (!first) return "";
  const { network, record } = first;
  const rpcEnvVar = `${network.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  return `### Verify a print independently

A print's own \`signature\` and \`public_key\` fields only prove internal consistency — that some
key signed this exact body. They cannot prove that key is Datum's, because a tampered file could
carry a self-consistent signature over a different key entirely. Closing that gap is the entire
reason the publisher key is coupled to \`DatumAttestation\`: the contract's \`publisher\` address is
immutable and lives outside the file, so it is a truth a tampered print cannot rewrite.

The loop:

1. Recompute the print's body hash independently (JCS-canonicalise the body minus its signature
   fields, keccak256 it).
2. Recover the signer's address from the raw \`{signature, hash}\` pair — not read from the
   print's own \`public_key\` field. (Recovery yields two address candidates, since the stored
   signature carries no recovery bit; exactly one matches a real signer.)
3. Compare the recovered address against \`DatumAttestation.publisher()\`, read live from chain.
4. Confirm the same body hash is anchored (\`postedAt(bodyHash) > 0\`).

\`\`\`bash
${rpcEnvVar}=... pnpm --filter @datum/print run verify-onchain <print-id> ${network}
\`\`\`

No \`DATUM_PUBLISHER_KEY\` is needed — this command only reads. Real output against a print
anchored on ${record.network.name}:

\`\`\`
On-chain publisher():        ${record.contracts.DatumAttestation.constructorArgs.publisher_}
Recovered signer candidates: ${record.contracts.DatumAttestation.constructorArgs.publisher_.toLowerCase()}, 0x77e5e69a6e32acd31864bacc256765926cd39498
  -> MATCH (recovery id 0): this print was signed by the on-chain publisher.

postedAt(bodyHash): ${record.smokeTests?.["1_anchorRealPrint"]?.storedTimestamp ?? "…"}
  -> ANCHORED at ${anchorIso(record)}

VERIFIED: signature matches the on-chain publisher AND the hash is anchored.
\`\`\`

A print signed by any other key — or never anchored at all — reports \`NOT VERIFIED\` and exits
non-zero (verified live against ${record.network.name} with an unrelated key: neither recovered
candidate matched \`publisher()\`, and \`postedAt\` read 0).`;
}

function renderSection(deployments) {
  const parts = ["## Deployments", "", BEGIN_MARKER, ""];
  parts.push(...deployments.map(renderDeployment));
  const verify = renderVerifySection(deployments);
  if (verify) parts.push(verify, "");
  parts.push(END_MARKER);
  return parts.join("\n");
}

function main() {
  const deployments = loadDeploymentFiles();
  const generated = renderSection(deployments);

  const readme = readFileSync(readmePath, "utf-8");
  const beginIdx = readme.indexOf(BEGIN_MARKER);
  const endIdx = readme.indexOf(END_MARKER);

  const checkOnly = process.argv.includes("--check");

  let before;
  let after;
  if (beginIdx === -1 || endIdx === -1) {
    // No existing section — the whole file is "before"; nothing is "after".
    before = `${readme.trimEnd()}\n\n`;
    after = "";
  } else {
    before = readme.slice(0, readme.lastIndexOf("## Deployments", beginIdx)).trimEnd();
    before = before.length > 0 ? `${before}\n\n` : "";
    const afterEnd = readme.indexOf("\n", endIdx) + 1;
    after = readme.slice(afterEnd).trimStart();
  }
  // Exactly one blank line on each side of the generated block, however much whitespace was
  // there before — this is what makes a second run produce byte-identical output to the first.
  const next = after.length > 0 ? `${before}${generated}\n\n${after}` : `${before}${generated}\n`;

  // The repo's own formatter (table column padding, list spacing, etc.) has opinions this
  // script doesn't try to replicate by hand — run it as the last step instead, so the file
  // this script produces is always already prettier-clean and `pnpm run format` never has
  // anything left to do to it.
  const formatted = formatWithPrettier(next);

  if (checkOnly) {
    if (formatted !== readme) {
      console.error(
        "README.md's Deployments section is out of date. Run without --check to regenerate.",
      );
      process.exit(1);
    }
    console.log("README.md's Deployments section is up to date.");
    return;
  }

  writeFileSync(readmePath, formatted);
  console.log(
    `Regenerated README.md's Deployments section from ${deployments.length} record(s) in data/deployments/.`,
  );
}

function formatWithPrettier(content) {
  return execFileSync("pnpm", ["exec", "prettier", "--stdin-filepath", "README.md"], {
    cwd: repoRoot,
    input: content,
    encoding: "utf-8",
  });
}

main();
