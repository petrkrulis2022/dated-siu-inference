import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GATEWAY, type BurnIntentTypedData } from "./gateway-withdrawal.js";
import { createWithdrawHandler, type WithdrawalRecord } from "./withdraw-server.js";

// The "treasury" here is a throwaway test key: the real treasury signs on its hardware wallet.
let treasury: PrivateKeyAccount;
let server: Server;
let base: string;
let allowedHosts: string[];
let circleCalls: { path: string; body: unknown }[];
let balances: Record<number, string>;
let clock: number;
let records: WithdrawalRecord[];

function fakeCircle(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(GATEWAY.testnet.api)).toBe(true);
    const path = url.slice(GATEWAY.testnet.api.length);
    const body = JSON.parse(String(init?.body ?? "null"));
    circleCalls.push({ path, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/v1/balances")
      return json({ token: "USDC", balances: body.sources.map((s: { domain: number; depositor: string }) => ({ domain: s.domain, depositor: s.depositor, balance: balances[s.domain] ?? "0" })) });
    if (path === "/v1/estimate") {
      const fee = body[0].spec.sourceDomain === 26 ? "3850" : "11000";
      return json([{ burnIntent: { maxBlockHeight: "34789781", maxFee: fee, spec: body[0].spec } }]);
    }
    if (path === "/v1/transfer") return json({ transferId: "t-1", attestation: "0x1234", signature: "0xabcd" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  treasury = privateKeyToAccount(generatePrivateKey());
  circleCalls = [];
  balances = { 6: "2.000000", 26: "1.000000" };
  clock = 1_000_000;
  allowedHosts = [];
  records = [];
  const handler = createWithdrawHandler({
    env: "testnet",
    treasury: treasury.address,
    allowedHosts,
    fetch: fakeCircle(),
    now: () => clock,
    record: async (r) => void records.push(structuredClone(r)),
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function sign(t: BurnIntentTypedData, account = treasury): Promise<Hex> {
  return account.signTypedData({
    domain: t.domain,
    types: { TransferSpec: t.types.TransferSpec, BurnIntent: t.types.BurnIntent },
    primaryType: "BurnIntent",
    message: { maxBlockHeight: BigInt(t.message.maxBlockHeight), maxFee: BigInt(t.message.maxFee), spec: { ...t.message.spec, value: BigInt(t.message.spec.value) } },
  });
}

async function prepare(chain = "arc-testnet", amount = "0.5") {
  const res = await post("/api/prepare", { chain, amount });
  return { status: res.status, body: (await res.json()) as { id: string; typedData: BurnIntentTypedData; summary: Record<string, string>; refusals?: string[] } };
}

describe("who may talk to it", () => {
  it("answers only requests addressed to 127.0.0.1 or localhost on its own port", async () => {
    // fetch() drops a custom Host header; node:http sends it, as a DNS-rebinding page's browser would.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + "/api/state", { headers: { host: "evil.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(circleCalls).toEqual([]);
  });

  it("refuses a POST from another origin", async () => {
    const res = await post("/api/prepare", { chain: "arc-testnet", amount: "0.5" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(circleCalls).toEqual([]);
  });

  it("serves the page with a policy that runs only its own script", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect(await res.text()).toContain('src="/app.js"');
  });
});

describe("GET /api/state", () => {
  it("shows the treasury's Gateway balance on each chain, from Circle", async () => {
    const res = await fetch(base + "/api/state");
    const body = (await res.json()) as { network: string; treasury: string; chains: { key: string; balance: string }[] };
    expect(body.network).toBe("testnet");
    expect(body.treasury).toBe(treasury.address);
    expect(body.chains.map((c) => [c.key, c.balance])).toEqual([["base-sepolia", "2.000000"], ["arc-testnet", "1.000000"]]);
  });
});

describe("POST /api/prepare", () => {
  it("builds the burn intent from Circle's estimate, to the treasury, and says what it costs", async () => {
    const { status, body } = await prepare();
    expect(status).toBe(200);
    expect(body.typedData.message.maxFee).toBe("3850");
    expect(body.typedData.message.maxBlockHeight).toBe("34789781");
    expect(body.typedData.message.spec.destinationRecipient.toLowerCase()).toContain(treasury.address.slice(2).toLowerCase());
    expect(body.summary).toMatchObject({ amount: "0.500000", maxFee: "0.003850", balance: "1.000000", balanceAfterAtLeast: "0.496150" });
  });

  it("refuses what the balance cannot carry with Circle's fee, before anything is signed", async () => {
    balances[26] = "0.003000";
    const { status, body } = await prepare("arc-testnet", "0.003");
    expect(status).toBe(422);
    expect(body.refusals?.join(" ")).toMatch(/fee/);
    expect(body.id).toBeUndefined();
  });

  it("refuses a chain of the other environment and an amount that is not one", async () => {
    expect((await prepare("arc", "0.5")).status).toBe(400);
    expect((await prepare("arc-testnet", "1e3")).status).toBe(400);
  });
});

describe("POST /api/submit", () => {
  it("refuses a signature from any account but the treasury, and tells Circle nothing", async () => {
    const { body } = await prepare();
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await post("/api/submit", { id: body.id, signature: await sign(body.typedData, stranger) });
    expect(res.status).toBe(400);
    expect(circleCalls.some((c) => c.path === "/v1/transfer")).toBe(false);
  });

  it("sends Circle exactly the intent it prepared, and returns the treasury's mint transaction", async () => {
    const { body } = await prepare();
    const signature = await sign(body.typedData);
    const res = await post("/api/submit", { id: body.id, signature, typedData: { tampered: true } });
    expect(res.status).toBe(200);
    const transfer = circleCalls.filter((c) => c.path === "/v1/transfer");
    expect(transfer).toEqual([{ path: "/v1/transfer", body: [{ burnIntent: body.typedData.message, signature }] }]);
    const { mint } = (await res.json()) as { mint: { chainId: number; to: string; from: string; data: Hex } };
    expect(mint.chainId).toBe(5042002);
    expect(mint.to).toBe(GATEWAY.testnet.minter);
    expect(mint.from).toBe(treasury.address);
    const decoded = decodeFunctionData({ abi: parseAbi(["function gatewayMint(bytes,bytes)"]), data: mint.data });
    expect(decoded.args).toEqual(["0x1234", "0xabcd"]);
  });

  it("uses a prepared withdrawal once only", async () => {
    const { body } = await prepare();
    const signature = await sign(body.typedData);
    expect((await post("/api/submit", { id: body.id, signature })).status).toBe(200);
    expect((await post("/api/submit", { id: body.id, signature })).status).toBe(404);
  });

  it("forgets a prepared withdrawal after 15 minutes", async () => {
    const { body } = await prepare();
    const signature = await sign(body.typedData);
    clock += 15 * 60 * 1000 + 1;
    expect((await post("/api/submit", { id: body.id, signature })).status).toBe(404);
  });

  it("records the signed request and Circle's answer once Circle attests", async () => {
    const { body } = await prepare();
    const signature = await sign(body.typedData);
    expect(records).toEqual([]);
    await post("/api/submit", { id: body.id, signature });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: body.id,
      network: "testnet",
      chain: "arc-testnet",
      treasury: treasury.address,
      amount: "0.500000",
      maxFee: "0.003850",
      typedData: body.typedData,
      signature,
      circle: { transferId: "t-1", attestation: "0x1234", signature: "0xabcd" },
      mint: { chainId: 5042002, to: GATEWAY.testnet.minter },
    });
  });

  it("checks the balance again before sending, in case it moved since preparing", async () => {
    const { body } = await prepare();
    balances[26] = "0.100000";
    const res = await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    expect(res.status).toBe(422);
    expect(circleCalls.some((c) => c.path === "/v1/transfer")).toBe(false);
  });
});

describe("POST /api/minted", () => {
  const HASH = `0x${"cd".repeat(32)}`;

  it("adds the mint transaction the page reports to that withdrawal's record", async () => {
    const { body } = await prepare();
    await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    expect((await post("/api/minted", { id: body.id, txHash: HASH, status: "sent" })).status).toBe(200);
    expect((await post("/api/minted", { id: body.id, txHash: HASH, status: "success" })).status).toBe(200);
    expect(records.at(-1)?.mintTx).toMatchObject({ hash: HASH, status: "success" });
  });

  it("accepts it only for a withdrawal Circle attested, with a real transaction hash and status", async () => {
    const { body } = await prepare();
    expect((await post("/api/minted", { id: body.id, txHash: HASH, status: "sent" })).status).toBe(404);
    await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    expect((await post("/api/minted", { id: body.id, txHash: "0x1234", status: "sent" })).status).toBe(400);
    expect((await post("/api/minted", { id: body.id, txHash: HASH, status: "maybe" })).status).toBe(400);
    expect((await post("/api/minted", { id: "nope", txHash: HASH, status: "sent" })).status).toBe(404);
  });
});
