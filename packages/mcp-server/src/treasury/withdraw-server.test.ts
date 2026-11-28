import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionData, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { GATEWAY, gatewayMintCalldata, type BurnIntentTypedData } from "./gateway-withdrawal.js";
import { createWithdrawHandler, type WithdrawalRecord } from "./withdraw-server.js";

// The "treasury" here is a throwaway test key: the real treasury signs in its own wallet.
let treasury: PrivateKeyAccount;
let server: Server;
let base: string;
let allowedHosts: string[];
let circleCalls: { path: string; body: unknown }[];
let balances: Record<number, string>;
let clock: number;
let records: WithdrawalRecord[];
// The chain, as the server reads it for itself: the treasury's code per chain id, and mined transactions.
let codes: Record<number, string>;
let txs: Map<string, unknown>;
let receipts: Map<string, unknown>;

const DELEGATED = "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b";
const HASH = `0x${"cd".repeat(32)}`;
const MINT_DATA = gatewayMintCalldata("0x1234", "0xabcd");
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (hex: string) => `0x${hex.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;

/** A mined mint as the chain would show it: plain from the treasury unless overridden. */
function mined(over: Record<string, unknown> = {}, value = 500_000, minter: string = GATEWAY.testnet.minter) {
  txs.set(HASH, { type: "0x2", from: treasury.address.toLowerCase(), to: minter.toLowerCase(), input: MINT_DATA, value: "0x0", ...over });
  receipts.set(HASH, {
    status: "0x1",
    logs: [{ address: ARC_USDC, topics: [TRANSFER_TOPIC, word("0x0"), word(treasury.address)], data: word(value.toString(16)) }],
  });
}

function fakeCircle(api: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(api)).toBe(true);
    const path = url.slice(api.length);
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
  records = [];
  codes = {};
  txs = new Map();
  receipts = new Map();
  await startServer("testnet");
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

async function startServer(env: "testnet" | "mainnet"): Promise<void> {
  allowedHosts = [];
  const handler = createWithdrawHandler({
    env,
    treasury: treasury.address,
    allowedHosts,
    fetch: fakeCircle(GATEWAY[env].api),
    now: () => clock,
    record: async (r) => void records.push(structuredClone(r)),
    chainRpc: async (chain, method, params) => {
      if (method === "eth_getCode") return codes[chain.chainId] ?? "0x";
      if (method === "eth_getTransactionByHash") return txs.get(params[0] as string) ?? null;
      if (method === "eth_getTransactionReceipt") return receipts.get(params[0] as string) ?? null;
      throw new Error(`unexpected ${method}`);
    },
    sleep: async () => {},
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  allowedHosts.push(`127.0.0.1:${port}`, `localhost:${port}`);
  base = `http://127.0.0.1:${port}`;
}

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

  it("asks for an amount when the box is empty, rather than quoting the parser", async () => {
    const res = await post("/api/prepare", { chain: "arc-testnet", amount: "" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Type an amount first/);
    expect(circleCalls).toEqual([]);
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

describe("guard: the treasury must be a plain account on that chain", () => {
  it("stops before anything is signed when the treasury has code there", async () => {
    codes[5042002] = DELEGATED;
    const { status, body } = await prepare();
    expect(status).toBe(409);
    expect((body as unknown as { error: string }).error).toMatch(/^Stop: on Arc Testnet the treasury is not a plain account/);
    expect(circleCalls).toEqual([]);
  });

  it("stops before asking Circle when code appears between preparing and submitting", async () => {
    const { body } = await prepare();
    codes[5042002] = DELEGATED;
    const res = await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    expect(res.status).toBe(409);
    expect(circleCalls.some((c) => c.path === "/v1/transfer")).toBe(false);
  });

  it("stops the page from sending the mint when code appears after Circle attested", async () => {
    const { body } = await prepare();
    await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    expect((await post("/api/mint-check", { id: body.id })).status).toBe(200);
    codes[5042002] = DELEGATED;
    expect((await post("/api/mint-check", { id: body.id })).status).toBe(409);
  });

  it("says when Circle's approval has expired (10 minutes) instead of letting the mint revert", async () => {
    const { body } = await prepare();
    await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    clock += 10 * 60 * 1000 + 1;
    const res = await post("/api/mint-check", { id: body.id });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { error: string }).error).toMatch(/expired.*returns to the Gateway balance/s);
  });

  it("checks only the chain of the withdrawal", async () => {
    codes[84532] = DELEGATED;
    expect((await prepare("arc-testnet")).status).toBe(200);
    expect((await prepare("base-sepolia")).status).toBe(409);
  });
});

describe("POST /api/minted", () => {
  async function attested(): Promise<string> {
    const { body } = await prepare();
    await post("/api/submit", { id: body.id, signature: await sign(body.typedData) });
    return body.id;
  }
  const report = async (id: string, status: string) => {
    const res = await post("/api/minted", { id, txHash: HASH, status });
    return { status: res.status, body: (await res.json()) as { verdict?: string; problems?: string[] } };
  };

  it("records the hash once sent, then checks the mined transaction on chain itself: plain is Done", async () => {
    const id = await attested();
    expect((await report(id, "sent")).status).toBe(200);
    expect(records.at(-1)?.mintTx).toMatchObject({ hash: HASH, status: "sent" });
    mined();
    const { status, body } = await report(id, "mined");
    expect(status).toBe(200);
    expect(body).toMatchObject({ verdict: "plain", problems: [], recorded: true });
    expect((body as { facts?: { sender: string } }).facts?.sender).toMatch(/\(the treasury\)$/);
    expect(records.at(-1)?.mintTx).toMatchObject({ hash: HASH, status: "plain", problems: [] });
  });

  it("reports a relayed type-4 mint as not plain, with the reasons, never as done", async () => {
    const id = await attested();
    mined({ type: "0x4", from: "0xb42f812a44c22cc6b861478900401ee759ebead6", to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3", input: "0xcef6d209", authorizationList: [{}] });
    const { body } = await report(id, "mined");
    expect(body.verdict).toBe("not-plain");
    expect(body.problems?.join(" ")).toMatch(/type-4 \(EIP-7702\).*sent by 0xb42f/s);
    expect(records.at(-1)?.mintTx).toMatchObject({ status: "not-plain" });
  });

  it("reports a mint it cannot find on chain as not plain, after retrying", async () => {
    const id = await attested();
    const { body } = await report(id, "mined");
    expect(body.verdict).toBe("not-plain");
    expect(body.problems?.join(" ")).toMatch(/not found on the chain/);
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

describe("mainnet: a relayed or smart-account mint is allowed only after a typed confirmation (owner's decision, 2026-11-28)", () => {
  const MAINNET_MINTER = GATEWAY.mainnet.minter;
  const PHRASE = "I accept a relayed or smart-account mint";

  beforeEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await startServer("mainnet");
  });

  async function attestedOn(chain = "arc") {
    const prep = await post("/api/prepare", { chain, amount: "0.5" });
    const body = (await prep.json()) as { id: string; typedData: BurnIntentTypedData; summary: { notice?: string } };
    expect(prep.status).toBe(200);
    expect((await post("/api/submit", { id: body.id, signature: await sign(body.typedData) })).status).toBe(200);
    return body;
  }

  it("does not refuse when the treasury already has code: it says so plainly and carries on to Circle", async () => {
    codes[5042] = DELEGATED;
    const body = await attestedOn();
    expect(body.summary.notice).toMatch(/smart account on Arc.*0x63c0c19a282a1b52b07dd5a65b58948a07dae32b/s);
    expect(circleCalls.some((c) => c.path === "/v1/transfer")).toBe(true);
  });

  it("asks for the exact phrase before every mint, and accepts nothing else", async () => {
    const { id } = await attestedOn();
    const ask = async (confirmation?: string) => (await (await post("/api/mint-check", { id, confirmation })).json()) as Record<string, unknown>;
    const first = await ask();
    expect(first).toMatchObject({ ok: false, needsConfirmation: true, phrase: PHRASE });
    expect(String(first.notice)).toMatch(/may send this mint through a smart account and its own relayer/);
    expect(await ask("yes")).toMatchObject({ ok: false, needsConfirmation: true });
    expect(await ask(PHRASE)).toMatchObject({ ok: true });
  });

  it("logs the confirmation in the withdrawal's record, with the treasury's code at that moment", async () => {
    codes[5042] = DELEGATED;
    const { id } = await attestedOn();
    clock += 1000;
    await post("/api/mint-check", { id, confirmation: PHRASE });
    expect(records.at(-1)?.relayAcceptance).toEqual({ phrase: PHRASE, at: new Date(clock).toISOString(), treasuryCode: DELEGATED });
  });

  it("reports a relayed mint as exactly what happened, marked as accepted, never as a plain Done", async () => {
    const { id } = await attestedOn();
    await post("/api/mint-check", { id, confirmation: PHRASE });
    mined({ type: "0x4", from: "0xb01caea8c6c47bbf4f4b4c5080ca642043359c2e", to: "0xdb9b1e94b5b69df7e401ddbede43491141047db3", input: "0xcef6d209", authorizationList: [{ address: "0x63c0c19a282a1b52b07dd5a65b58948a07dae32b" }] }, 500_000, MAINNET_MINTER);
    const res = await post("/api/minted", { id, txHash: HASH, status: "mined" });
    const body = (await res.json()) as { verdict: string; accepted: boolean; facts: Record<string, string> };
    expect(body.verdict).toBe("not-plain");
    expect(body.accepted).toBe(true);
    expect(body.facts).toMatchObject({ sender: expect.stringMatching(/a relayer/), type: expect.stringMatching(/^0x4 \(EIP-7702/), receivedByTreasury: "0.500000 USDC" });
    expect(records.at(-1)?.mintTx).toMatchObject({ status: "not-plain", accepted: true });
  });
});
