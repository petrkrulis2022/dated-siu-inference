#!/usr/bin/env node
// Verify a Touchstone Assay print yourself. Plain Node 18+, no npm install, no keys.
//
//   node verify-print.mjs 2026-10-14                 # fetch that print from GitHub, hash it, check its anchor on-chain
//   node verify-print.mjs ./2026-10-14.json          # hash a file you already have
//   node verify-print.mjs 2026-10-14 --no-network    # only compute the hash (a file argument never touches the network except for the anchor check)
//
// What it does, in the order the page "Verify this yourself" gives it:
//   1. Take the print's JSON and remove the fields that cannot be part of what was signed: signature, public_key, anchor,
//      superseded_by, correction_notes. (anchor, superseded_by and correction_notes are added after signing, so they cannot be in the hash.)
//   2. Canonicalise what is left with RFC 8785 (JCS): keys sorted, no whitespace, numbers and strings as JSON writes them.
//   3. keccak256 of the UTF-8 bytes. This is the print's body hash, "0x" plus 64 lowercase hex digits.
//   4. For the chain named in the print's anchor, ask that chain's block explorer for the anchor transaction's logs and look for a
//      PrintPosted(bodyHash, version, timestamp) event from the TouchstoneAttestation contract carrying your hash.
// It does NOT check the signature (see the page, or packages/print in the repository, for that).
// Exit code 0: the hash was computed, and any anchor it could check matched. 1: a mismatch, no anchor found, or a lookup failed.

/* global fetch, TextEncoder */
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RAW_PRINT_URL = "https://raw.githubusercontent.com/petrkrulis2022/dated-siu-inference/main/data/prints/";

/** Removed before hashing. The same list as the site's verify.json and as packages/print's printBodyOf. */
export const EXCLUDED_FIELDS = ["signature", "public_key", "anchor", "superseded_by", "correction_notes"];

/** TouchstoneAttestation on each chain. The same table as verify.json; a test keeps it equal to data/deployments/. */
export const CHAINS = {
  "base-sepolia": {
    name: "Base Sepolia",
    chainId: 84532,
    explorer: "https://base-sepolia.blockscout.com",
    contract: "0xF60701793eD168ffd6e818e1DCcb600393297190",
    publisher: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a",
  },
  "arc-testnet": {
    name: "Arc Testnet",
    chainId: 5042002,
    explorer: "https://testnet.arcscan.app",
    contract: "0x12b886b043feABc3d90bBae3ae206d22b208160d",
    publisher: "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a",
  },
};

// ---- keccak256 (the original Keccak padding, as Ethereum uses; NOT NIST SHA3-256, which pads differently) --------------------------------------------
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];
const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK) & b[((x + 2) % 5) + 5 * y]);
    }
    s[0] ^= RC[round];
  }
}

/** keccak256 of a Uint8Array, as "0x" plus 64 lowercase hex digits. */
export function keccak256Hex(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      state[i] ^= lane;
    }
    keccakF(state);
  }
  let hex = "";
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) hex += Number((state[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return `0x${hex}`;
}

// ---- RFC 8785 (JCS) for the JSON a print contains: object keys sorted by UTF-16 code unit, no whitespace -----------------------------------------
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(",")}}`;
}

/** The print's body hash: remove the excluded fields, canonicalise, keccak256. */
export function bodyHashOf(print) {
  const body = { ...print };
  for (const field of EXCLUDED_FIELDS) delete body[field];
  return keccak256Hex(new TextEncoder().encode(canonicalJson(body)));
}

/** Look for a PrintPosted event carrying `hash` in an anchor transaction's logs, as the explorer returns them (Blockscout API v2). */
export function findPrintPosted(logs, contract, hash) {
  for (const item of logs?.items ?? []) {
    if (String(item?.address?.hash ?? "").toLowerCase() !== contract.toLowerCase()) continue;
    const params = Object.fromEntries((item?.decoded?.parameters ?? []).map((p) => [p.name, p.value]));
    if (String(params.bodyHash ?? "").toLowerCase() === hash.toLowerCase()) {
      return { block: item.block_number, version: params.version, timestamp: Number(params.timestamp) };
    }
  }
  return undefined;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const noNetwork = process.argv.includes("--no-network");
  const target = args[0];
  if (!target) {
    console.error("usage: node verify-print.mjs <print_id | path/to/print.json> [--no-network]");
    process.exit(1);
  }
  let print;
  if (existsSync(target)) print = JSON.parse(readFileSync(target, "utf8"));
  else {
    const res = await fetch(`${RAW_PRINT_URL}${target}.json`);
    if (!res.ok) {
      console.error(`could not fetch print "${target}": HTTP ${res.status}`);
      process.exit(1);
    }
    print = await res.json();
  }
  const hash = bodyHashOf(print);
  console.log(`print ${print.print_id ?? target}`);
  console.log(`body hash ${hash}`);
  if (noNetwork) return;

  const anchor = print.anchor;
  if (!anchor || anchor.status !== "anchored" || !anchor.tx_hash) {
    console.log("no anchor transaction in this print (not anchored)");
    process.exit(1);
  }
  const chain = CHAINS[anchor.chain];
  if (!chain) {
    console.log(`the print names chain "${anchor.chain}", which this script has no contract for`);
    process.exit(1);
  }
  const res = await fetch(`${chain.explorer}/api/v2/transactions/${anchor.tx_hash}/logs`);
  if (!res.ok) {
    console.log(`explorer lookup failed: HTTP ${res.status} for ${chain.explorer}`);
    process.exit(1);
  }
  const found = findPrintPosted(await res.json(), chain.contract, hash);
  if (!found) {
    console.log(`NOT FOUND: no PrintPosted event carrying this hash in ${anchor.tx_hash} from ${chain.contract} on ${chain.name}`);
    process.exit(1);
  }
  console.log(`ANCHORED on ${chain.name}: tx ${anchor.tx_hash}, block ${found.block}, ${new Date(found.timestamp * 1000).toISOString()}, version ${found.version}`);
  console.log(`contract ${chain.contract} (publisher ${chain.publisher})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
