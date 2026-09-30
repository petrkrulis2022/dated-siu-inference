import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { readFileSync } from "node:fs";
const ROOT = "/home/petrunix/dated-siu-inference";
const dep = JSON.parse(readFileSync(`${ROOT}/data/deployments/base-sepolia-gate-market.json`,"utf-8"));
const env = Object.fromEntries(readFileSync(`${ROOT}/.env`,"utf-8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^"|"$/g,"")];}));
const pk = (k)=>k.startsWith("0x")?k:"0x"+k;
const acct = privateKeyToAccount(pk(env.DEPLOYER_PRIVATE_KEY));
const c = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const w = createWalletClient({ account: acct, chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
const L = dep.capacityLots, CODE = L.classIds.code, ZERO = `0x${"0".repeat(64)}`;
const wcAbi = parseAbi([
  "event Minted(uint256 indexed tokenId, address indexed issuer, address indexed buyer, bytes32 classId, bytes32 series, uint256 quantity, uint64 windowFrom, uint64 windowTo)",
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function settled(uint256 tokenId, address holder) external view returns (bool)",
  "function claimTypes(uint256 tokenId) external view returns (address issuer, bytes32 classId, bytes32 series, uint64 windowFrom, uint64 windowTo, bool exists, uint256 referenceNanoUsdPerSiu)",
  "function settleWindowClose(uint256 tokenId, address holder, (string printId, bytes32 series, uint64 printDate, uint256 nanoUsdPerSiu, uint64 validUntil) att, bytes signature) external",
]);
const bondAbi = parseAbi(["function headroom(address issuer, bytes32 classId) external view returns (uint256)"]);
const TXS = ["0xb6c5eabd93aa8f681a0ad762dc438c64b385321e3435d15d9366679f5d70e034","0x480566c7c872041e6a7c330e8417617d0613bfda8eb40d76dffdb7eebfd6d732"];
const ids = [];
for (const t of TXS) {
  const r = await c.getTransactionReceipt({ hash: t });
  for (const l of r.logs) { try { const d = decodeEventLog({ abi: wcAbi, data: l.data, topics: l.topics }); if (d.eventName === "Minted") ids.push(d.args.tokenId); } catch {} }
}
for (const id of ids) {
  const ct = await c.readContract({ address: dep.workClaim.address, abi: wcAbi, functionName: "claimTypes", args: [id] });
  while (BigInt(Math.floor(Date.now()/1000)) < ct[4]) {
    const waitS = Number(ct[4] - BigInt(Math.floor(Date.now()/1000))) + 15;
    console.log(`waiting ${waitS}s for window close`);
    await new Promise(r => setTimeout(r, waitS * 1000));
  }
  const bal = await c.readContract({ address: dep.workClaim.address, abi: wcAbi, functionName: "balanceOf", args: [acct.address, id] });
  if (bal === 0n || await c.readContract({ address: dep.workClaim.address, abi: wcAbi, functionName: "settled", args: [id, acct.address] })) { console.log("already settled"); continue; }
  const h = await w.writeContract({ address: dep.workClaim.address, abi: wcAbi, functionName: "settleWindowClose",
    args: [id, acct.address, { printId: "", series: ZERO, printDate: 0n, nanoUsdPerSiu: 0n, validUntil: 0n }, "0x"], chain: baseSepolia });
  const r = await c.waitForTransactionReceipt({ hash: h });
  console.log(`EXPIRED ${bal} mSIU block ${r.blockNumber} tx ${h}`);
}
// Fresh connection, block height at or beyond the last write — the rule, not the naive version.
await new Promise(r => setTimeout(r, 20000));
const c2 = createPublicClient({ chain: baseSepolia, transport: http(env.BASE_SEPOLIA_RPC_URL) });
console.log("verify at block", await c2.getBlockNumber());
for (const n of ["ISSUER-A","ISSUER-B"]) {
  const hr = await c2.readContract({ address: dep.capacityBond.address, abi: bondAbi, functionName: "headroom", args: [L[n].address, CODE] });
  console.log(`${n} ${hr}/${L[n].issuanceLimitPerClass} ${hr===BigInt(L[n].issuanceLimitPerClass)?"FULL":"SHORT"}`);
}
