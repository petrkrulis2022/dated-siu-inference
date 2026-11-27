import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isHex, type Hex } from "viem";
import {
  GATEWAY,
  assertSafeBurnIntent,
  buildWithdrawal,
  chainFor,
  formatUsdc,
  gatewayMintCalldata,
  parseUsdc,
  recoverBurnIntentSigner,
  withdrawalRefusals,
  type BurnIntentTypedData,
  type GatewayEnvironment,
} from "./gateway-withdrawal.js";
import { WITHDRAW_PAGE_HTML, WITHDRAW_PAGE_JS } from "./withdraw-page.js";

/**
 * The local server behind the treasury withdrawal page (src/cli/treasury-withdraw.ts binds it to
 * 127.0.0.1). It holds no key and signs nothing. It reads the treasury's Gateway balance, asks
 * Circle's /v1/estimate for the fee and expiry, builds the burn intent the treasury's own wallet
 * signs, forwards that signature to Circle's /v1/transfer, and hands back the gatewayMint
 * transaction for the same wallet to send.
 *
 * What the browser can steer is narrow on purpose:
 * - It picks a chain and an amount; the server builds everything else.
 * - It returns only a signature and the id of what the server prepared. The server re-reads the
 *   intent from its own memory, checks the signature recovers to the treasury, re-checks the
 *   balance, and runs the safety check again before anything reaches Circle.
 * - A prepared withdrawal is single-use and expires after 15 minutes.
 * - Requests must name this server's own host, and a POST from another origin is refused, so no
 *   other site can drive it.
 */

/**
 * One withdrawal as it happened, for the treasury's books (the CLI writes it under the gitignored
 * data/private/withdrawals/): what the treasury signed, Circle's answer, and the mint transaction
 * the page reports once it is sent and again once it is mined.
 */
export interface WithdrawalRecord {
  id: string;
  network: GatewayEnvironment;
  chain: string;
  treasury: string;
  amount: string;
  maxFee: string;
  attestedAt: string;
  typedData: BurnIntentTypedData;
  signature: Hex;
  circle: { transferId: string | null; attestation: string; signature: string };
  mint: { chainId: number; to: string; data: Hex };
  mintTx?: { hash: Hex; status: MintStatus; reportedAt: string };
}

type MintStatus = "sent" | "success" | "failed";
const MINT_STATUSES: readonly string[] = ["sent", "success", "failed"];

export interface WithdrawServerOptions {
  env: GatewayEnvironment;
  treasury: string;
  /** "127.0.0.1:<port>" and "localhost:<port>": the only Host headers answered. */
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  /** Keeps each withdrawal's record; called on attestation and on every mint report. */
  record?: (r: WithdrawalRecord) => Promise<void>;
}

interface Pending {
  typedData: BurnIntentTypedData;
  chain: string;
  expiresAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
/** How long the page may report the mint transaction of an attested withdrawal. */
const ATTESTED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function createWithdrawHandler(opts: WithdrawServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const env = GATEWAY[opts.env];
  const treasury = getAddress(opts.treasury);
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const attested = new Map<string, { record: WithdrawalRecord; expiresAt: number }>();

  /** Best effort: a record that cannot be written is logged, never allowed to lose the mint. */
  async function keep(r: WithdrawalRecord): Promise<boolean> {
    if (!opts.record) return false;
    try {
      await opts.record(r);
      return true;
    } catch (e) {
      console.error(`${new Date(now()).toISOString()} could not write the record of ${r.id}:`, (e as Error).message);
      return false;
    }
  }

  async function circle(path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(`${env.api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok || json === undefined) throw new HttpError(502, `Circle ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    return json;
  }

  async function balances(): Promise<Map<number, bigint>> {
    const json = (await circle("/v1/balances", {
      token: "USDC",
      sources: env.chains.map((c) => ({ domain: c.domain, depositor: treasury })),
    })) as { balances?: { domain: number; depositor: string; balance: string }[] };
    const out = new Map<number, bigint>();
    for (const b of json.balances ?? [])
      if (b.depositor.toLowerCase() === treasury.toLowerCase()) out.set(b.domain, parseUsdc(b.balance));
    return out;
  }

  async function estimate(chain: string, value: bigint, salt: Hex): Promise<{ maxFee: bigint; maxBlockHeight: bigint }> {
    const draft = buildWithdrawal({ env: opts.env, chain, treasury, value, maxFee: 0n, maxBlockHeight: 0n, salt });
    const json = (await circle("/v1/estimate", [{ spec: draft.message.spec }])) as unknown;
    // Live answer: [{ burnIntent: { maxFee, maxBlockHeight, spec } }]; the docs' example wraps it in { body }.
    const list = Array.isArray(json) ? json : (json as { body?: unknown[] }).body;
    const bi = (list?.[0] as { burnIntent?: { maxFee?: string; maxBlockHeight?: string } } | undefined)?.burnIntent;
    if (!bi || !/^\d+$/.test(bi.maxFee ?? "") || !/^\d+$/.test(bi.maxBlockHeight ?? ""))
      throw new HttpError(502, `Circle's estimate had no maxFee and maxBlockHeight: ${JSON.stringify(json).slice(0, 300)}`);
    return { maxFee: BigInt(bi.maxFee!), maxBlockHeight: BigInt(bi.maxBlockHeight!) };
  }

  async function state(): Promise<unknown> {
    const b = await balances();
    return {
      network: opts.env,
      treasury,
      chains: env.chains.map((c) => ({
        key: c.key,
        name: c.name,
        chainId: c.chainId,
        explorer: c.explorer,
        balance: formatUsdc(b.get(c.domain) ?? 0n),
      })),
    };
  }

  async function prepare(body: { chain?: unknown; amount?: unknown }): Promise<unknown> {
    if (typeof body.chain !== "string" || typeof body.amount !== "string") throw new HttpError(400, "Send a chain and an amount.");
    if (body.amount.trim() === "") throw new HttpError(400, "Type an amount first: the grey 0.50 in the box is only an example.");
    let chain;
    let value: bigint;
    try {
      chain = chainFor(opts.env, body.chain);
      value = parseUsdc(body.amount);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (value <= 0n) throw new HttpError(422, "Enter an amount above zero.", { refusals: ["Enter an amount above zero."] });
    const balance = (await balances()).get(chain.domain) ?? 0n;
    const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
    const { maxFee, maxBlockHeight } = await estimate(chain.key, value, salt);
    const refusals = withdrawalRefusals({ value, maxFee, balance });
    if (refusals.length > 0)
      throw new HttpError(422, refusals.join(" "), { refusals, balance: formatUsdc(balance), maxFee: formatUsdc(maxFee) });
    const typedData = buildWithdrawal({ env: opts.env, chain: chain.key, treasury, value, maxFee, maxBlockHeight, salt });
    assertSafeBurnIntent(typedData, { env: opts.env, chain: chain.key, treasury });
    const id = randomBytes(16).toString("hex");
    pending.set(id, { typedData, chain: chain.key, expiresAt: now() + PENDING_TTL_MS });
    console.log(`${new Date(now()).toISOString()} prepared ${id}: ${formatUsdc(value)} USDC on ${chain.name}, fee up to ${formatUsdc(maxFee)}`);
    return {
      id,
      typedData,
      summary: {
        chain: chain.name,
        chainId: chain.chainId,
        amount: formatUsdc(value),
        maxFee: formatUsdc(maxFee),
        balance: formatUsdc(balance),
        balanceAfterAtLeast: formatUsdc(balance - value - maxFee),
        recipient: treasury,
        maxBlockHeight: maxBlockHeight.toString(),
      },
    };
  }

  async function submit(body: { id?: unknown; signature?: unknown }): Promise<unknown> {
    const p = typeof body.id === "string" ? pending.get(body.id) : undefined;
    if (!p || p.expiresAt < now()) {
      if (typeof body.id === "string") pending.delete(body.id);
      throw new HttpError(404, "No such prepared withdrawal (each is used once and expires after 15 minutes). Prepare it again.");
    }
    if (typeof body.signature !== "string" || !isHex(body.signature) || body.signature.length !== 132)
      throw new HttpError(400, "That is not a 65-byte signature.");
    const signature = body.signature as Hex;
    const signer = await recoverBurnIntentSigner(p.typedData, signature);
    if (signer.toLowerCase() !== treasury.toLowerCase())
      throw new HttpError(400, `Signed by ${signer}, not by the treasury ${treasury}. Nothing was sent to Circle.`);
    const chain = chainFor(opts.env, p.chain);
    const value = BigInt(p.typedData.message.spec.value);
    const maxFee = BigInt(p.typedData.message.maxFee);
    const balance = (await balances()).get(chain.domain) ?? 0n;
    const refusals = withdrawalRefusals({ value, maxFee, balance });
    if (refusals.length > 0) throw new HttpError(422, refusals.join(" "), { refusals, balance: formatUsdc(balance) });
    assertSafeBurnIntent(p.typedData, { env: opts.env, chain: chain.key, treasury });
    const answer = (await circle("/v1/transfer", [{ burnIntent: p.typedData.message, signature }])) as {
      attestation?: string;
      signature?: string;
      transferId?: string;
    };
    if (!answer.attestation || !answer.signature)
      throw new HttpError(502, `Circle did not attest the withdrawal: ${JSON.stringify(answer).slice(0, 300)}`);
    const id = body.id as string;
    pending.delete(id);
    console.log(`${new Date(now()).toISOString()} attested ${id}: ${formatUsdc(value)} USDC on ${chain.name}${answer.transferId ? ` (transfer ${answer.transferId})` : ""}`);
    const data = gatewayMintCalldata(answer.attestation, answer.signature);
    const record: WithdrawalRecord = {
      id,
      network: opts.env,
      chain: chain.key,
      treasury,
      amount: formatUsdc(value),
      maxFee: formatUsdc(maxFee),
      attestedAt: new Date(now()).toISOString(),
      typedData: p.typedData,
      signature,
      circle: { transferId: answer.transferId ?? null, attestation: answer.attestation, signature: answer.signature },
      mint: { chainId: chain.chainId, to: env.minter, data },
    };
    attested.set(id, { record, expiresAt: now() + ATTESTED_TTL_MS });
    const recorded = await keep(record);
    return {
      transferId: answer.transferId ?? null,
      recorded,
      mint: {
        chainId: chain.chainId,
        chainName: chain.name,
        rpcUrl: chain.rpcUrl,
        explorer: chain.explorer,
        nativeCurrency: chain.nativeCurrency,
        from: treasury,
        to: env.minter,
        data,
      },
    };
  }

  async function minted(body: { id?: unknown; txHash?: unknown; status?: unknown }): Promise<unknown> {
    const a = typeof body.id === "string" ? attested.get(body.id) : undefined;
    if (!a || a.expiresAt < now()) throw new HttpError(404, "No attested withdrawal with that id.");
    if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new HttpError(400, "That is not a transaction hash.");
    if (typeof body.status !== "string" || !MINT_STATUSES.includes(body.status)) throw new HttpError(400, "Status must be sent, success or failed.");
    a.record.mintTx = { hash: body.txHash as Hex, status: body.status as MintStatus, reportedAt: new Date(now()).toISOString() };
    console.log(`${a.record.mintTx.reportedAt} mint of ${a.record.id}: ${body.status} ${body.txHash}`);
    return { recorded: await keep(a.record) };
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Send JSON.");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
      chunks.push(chunk as Buffer);
    }
    try {
      const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new HttpError(400, "Send a JSON object.");
  }

  const postRoutes = new Map<string, (body: Record<string, unknown>) => Promise<unknown>>([
    ["/api/prepare", prepare],
    ["/api/submit", submit],
    ["/api/minted", minted],
  ]);

  const SECURITY_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };

  function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  }

  return async (req, res) => {
    try {
      if (!opts.allowedHosts.includes(req.headers.host ?? "")) throw new HttpError(403, "Wrong host.");
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/")
        return send(res, 200, WITHDRAW_PAGE_HTML, "text/html; charset=utf-8", {
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        });
      if (req.method === "GET" && url.pathname === "/app.js") return send(res, 200, WITHDRAW_PAGE_JS, "text/javascript; charset=utf-8");
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, JSON.stringify(await state()), "application/json");
      const post = postRoutes.get(url.pathname);
      if (req.method === "POST" && post) {
        const origin = req.headers.origin;
        if (origin !== undefined && !opts.allowedHosts.some((h) => origin === `http://${h}`)) throw new HttpError(403, "Wrong origin.");
        const body = await readJson(req);
        return send(res, 200, JSON.stringify(await post(body)), "application/json");
      }
      throw new HttpError(404, "Not found.");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const extra = e instanceof HttpError ? e.extra : {};
      if (status >= 500) console.error(`${new Date(now()).toISOString()} error:`, (e as Error).message);
      send(res, status, JSON.stringify({ error: (e as Error).message, ...extra }), "application/json");
    }
  };
}
