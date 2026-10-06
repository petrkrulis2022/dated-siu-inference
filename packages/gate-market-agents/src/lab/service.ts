/**
 * The currency lab's service: the loop's lab hooks and the `deliver_job` backend in one object, over the
 * lab's books. It is told what each tool call did, vets each call's arguments, runs the work, gives the
 * escrow fee back, and opens each round when the last has gone quiet.
 *
 * Operator-side throughout. Nothing here is shown to an agent except through the board (`board.ts`), the
 * refusals (`guards.ts`) and `deliver_job`'s result — and none of those names an asset or advises.
 */
import type { LabHooks, LabToolEvent } from "../loop/lab-hooks.js";
import type { LabService as DeliverService } from "../deps.js";
import type { AgentId } from "../identity/resolve.js";
import type { ToolName } from "../tools/index.js";
import { LabBooks, MAX_DELIVERY_ATTEMPTS, type Asset } from "./books.js";
import { ISSUER_SEAT, LAB_ALIASES, traderForSeat, type TraderLabel } from "./economy.js";
import { guardLabCall, type GuardConfig } from "./guards.js";
import { renderLabAction, renderLabInfo } from "./board.js";
import { claimForUsd, escrowFeeMinor, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu, jobSiu } from "./money.js";
import { claimMintCostMinorUnits } from "../loop/parity.js";
import { LAB_TOOL_DESCRIPTIONS, resolveLabCall, rewriteLabText } from "./tools.js";
import { jobFor, type WorkExecutor } from "./jobs.js";

export interface LabServiceDeps {
  books: LabBooks;
  guard: GuardConfig;
  seed: number;
  /** Performs and grades a job on behalf of its seller. */
  executorFor: (trader: TraderLabel) => WorkExecutor;
  /** Operator: give the escrow's fee back to the seller who paid it. */
  rebate: (seller: AgentId, minorUnits: bigint) => Promise<{ txHash?: string }>;
  escrowFeeBps: number;
  /** Real cost of a work execution, decimal USD, for the run's own ledger. */
  recordWorkCost?: (usd: string) => void;
  /** Called after a round opens, e.g. to take a snapshot of every trader's holdings. */
  onRoundOpened?: (round: number) => Promise<void>;
  /** The one token every trader holds: what a payment from a held balance gives. */
  tokenId: string;
  /**
   * A trader's confirmed holdings, read from the chain. With it, a payment the trader cannot afford is refused before
   * anything is sent, in one sentence whichever asset it is in. Without it (a test) every payment goes to the chain.
   */
  holdings?: (trader: TraderLabel) => Promise<{ usdcMinor: bigint; fsiuMilliSiu: bigint }>;
}

export type LabOperatorAction =
  | { kind: "fee_rebate"; seller: AgentId; requestId: string; settledMinorUnits: string; rebatedMinorUnits: string; txHash?: string }
  | { kind: "round_opened"; round: number };

export interface WorkLogEntry {
  requestId: string;
  seller: TraderLabel;
  buyer: TraderLabel;
  attempt: number;
  passed: boolean;
  reason?: string;
  costUsd: string;
}

const PAYMENT_ASSET: Partial<Record<ToolName, Asset>> = {
  pay: "usdc",
  pay_with_claim: "fsiu",
  transfer_claim: "fsiu",
  settle_split: "split",
};

export class LabService implements LabHooks, DeliverService {
  readonly operatorActions: LabOperatorAction[] = [];
  readonly workLog: WorkLogEntry[] = [];
  /** Trader labels an agent may use in a call's own arguments (`LabHooks.aliases`). */
  readonly aliases = LAB_ALIASES;

  constructor(private readonly d: LabServiceDeps) {}

  #who(agentId: AgentId): TraderLabel | "ISSUER" | undefined {
    if (agentId === ISSUER_SEAT) return "ISSUER";
    return traderForSeat(agentId);
  }

  // ---- LabHooks -----------------------------------------------------------------------------

  infoTextFor(agentId: AgentId): string {
    const me = traderForSeat(agentId);
    return me === undefined ? "" : renderLabInfo(this.d.books, this.d.guard, me);
  }

  actionTextFor(agentId: AgentId): string {
    const me = traderForSeat(agentId);
    return me === undefined ? "" : renderLabAction(this.d.books, me);
  }

  async guard(agentId: AgentId, tool: ToolName, rawArgs: unknown): Promise<string | null> {
    const who = this.#who(agentId);
    if (who === undefined) return null;
    const refusal = guardLabCall(this.d.books, this.d.guard, who, tool, rawArgs);
    if (refusal !== null) return refusal;
    if (who === "ISSUER" || this.d.holdings === undefined) return null;
    return this.#affordability(who, tool, rawArgs);
  }

  // ---- the lab's names for its tools ---------------------------------------------------------

  toolDescription(tool: ToolName): string | undefined {
    return LAB_TOOL_DESCRIPTIONS[tool];
  }

  resolveCall(_agentId: AgentId, name: string, args: unknown) {
    return resolveLabCall(
      {
        sellerNameOf: (id) => {
          const sale = this.d.books.sale(id);
          return sale === undefined ? undefined : sale.seller === "ISSUER" ? ISSUER_SEAT : sale.seller;
        },
        tokenId: this.d.tokenId,
      },
      name,
      args,
    );
  }

  rewriteText(text: string): string {
    return rewriteLabText(text);
  }

  /**
   * What a payment costs against what the wallet holds — confirmed reads, one sentence, the same form whichever asset it
   * is paid in. A payment the trader cannot afford is refused here, before it is sent, so it neither reaches the chain
   * nor is retried as though the node were lagging; a payment this lets through that the chain then refuses is a
   * stale balance, and the loop's own retry is the right answer to that.
   */
  async #affordability(me: TraderLabel, tool: ToolName, rawArgs: unknown): Promise<string | null> {
    const id = (rawArgs as { requestId?: unknown } | undefined)?.requestId;
    if (typeof id !== "string") return null;
    const sale = this.d.books.sale(id);
    if (sale === undefined) return null;
    const p = this.d.guard.printNano;
    const size = jobSiu(this.d.guard.params);
    const price = quotedPrice(
      size,
      sale.kind === "trade" ? tradeRateUsdPerSiu(p, this.d.guard.params) : rawWorkRateUsdPerSiu(p),
    ).minorUnits;
    const claim = claimForUsd(quotedPrice(size, sale.kind === "trade" ? tradeRateUsdPerSiu(p, this.d.guard.params) : rawWorkRateUsdPerSiu(p)).usd, p);
    let cost: bigint;
    let asset: "usdc" | "fsiu";
    if (tool === "pay" || tool === "settle_split") {
      // A split is a minted part and a dollar part that together come to the whole price.
      cost = price;
      asset = "usdc";
    } else if (tool === "pay_with_claim") {
      cost = claimMintCostMinorUnits(claim, p);
      asset = "usdc";
    } else if (tool === "transfer_claim") {
      cost = claim;
      asset = "fsiu";
    } else {
      return null;
    }
    const held = await this.d.holdings!(me);
    const have = asset === "usdc" ? held.usdcMinor : held.fsiuMilliSiu;
    if (have >= cost) return null;
    const unit = asset === "usdc" ? "USDC minor units" : "mSIU of fSIU";
    return `This payment costs ${cost} ${unit}; the wallet holds ${have} ${unit}.`;
  }

  async afterToolCall(e: LabToolEvent): Promise<void> {
    const who = this.#who(e.agentId);
    if (who === undefined) return;
    const { books } = this.d;

    if (e.tool === "request_quote" && e.requestId !== undefined && who !== "ISSUER") {
      const sellerId = (e.result as { seller_id?: string } | undefined)?.seller_id;
      const seller = sellerId === undefined ? undefined : books.counterpartyOf(sellerId);
      if (seller !== undefined) books.requestPosted(e.requestId, who, seller);
      return;
    }

    if (e.tool === "issue_quote") {
      const requestId = (e.intentArgs as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string") books.quoteIssued(requestId);
      return;
    }

    const asset = PAYMENT_ASSET[e.tool];
    if (asset !== undefined) {
      // A transfer that names no quote settles nothing and is not a payment.
      const requestId = (e.intentArgs as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string") books.paid(requestId, asset);
      return;
    }

    if (e.tool === "settle_escrow" && e.settledRequestId !== undefined) {
      books.settled(e.settledRequestId);
      const settled = BigInt((e.result as { settledMinorUnits?: string } | undefined)?.settledMinorUnits ?? "0");
      const fee = escrowFeeMinor(settled, this.d.escrowFeeBps);
      if (fee > 0n) {
        const { txHash } = await this.d.rebate(e.agentId, fee);
        this.operatorActions.push({
          kind: "fee_rebate",
          seller: e.agentId,
          requestId: e.settledRequestId,
          settledMinorUnits: settled.toString(),
          rebatedMinorUnits: fee.toString(),
          ...(txHash !== undefined ? { txHash } : {}),
        });
      }
    }
  }

  async advanceRound(): Promise<boolean> {
    const opened = this.d.books.advanceRound();
    if (opened) {
      this.operatorActions.push({ kind: "round_opened", round: this.d.books.round });
      await this.d.onRoundOpened?.(this.d.books.round);
    }
    return opened;
  }

  // ---- deliver_job --------------------------------------------------------------------------

  async deliverJob(caller: AgentId, requestId: string): Promise<unknown> {
    const { books } = this.d;
    const me = traderForSeat(caller);
    if (me === undefined) throw new Error("deliver_job: only a trader delivers jobs.");
    const sale = books.sale(requestId);
    if (sale === undefined) throw new Error(`deliver_job: there is no request ${requestId}.`);
    if (sale.kind !== "trade") throw new Error(`deliver_job: ${requestId} is not a job; it is a unit of raw work.`);
    if (sale.seller !== me) throw new Error(`deliver_job: ${requestId} is not a job you sold.`);
    if (!sale.paid) throw new Error(`deliver_job: ${requestId} has not been paid yet.`);
    if (sale.delivered) throw new Error(`deliver_job: ${requestId} has already been delivered.`);
    if (sale.attempts >= MAX_DELIVERY_ATTEMPTS) {
      throw new Error(`deliver_job: ${requestId} has had its ${MAX_DELIVERY_ATTEMPTS} attempts.`);
    }
    if (books.unitsOf(me) < 1) throw new Error("deliver_job: you hold no unit of raw work, and delivering uses one.");
    const need = books.economy.needs.find((n) => n.id === sale.needId);
    if (need === undefined) throw new Error(`deliver_job: ${requestId} answers no need.`);

    const result = await this.d.executorFor(me)(jobFor(this.d.seed, need));
    this.d.recordWorkCost?.(result.costUsd);
    books.attempted(requestId, result.passed);
    this.workLog.push({
      requestId,
      seller: me,
      buyer: sale.buyer,
      attempt: sale.attempts,
      passed: result.passed,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      costUsd: result.costUsd,
    });
    return result.passed
      ? { delivered: true, requestId, buyer: sale.buyer, unitsLeft: books.unitsOf(me) }
      : {
          delivered: false,
          requestId,
          reason: result.reason ?? "the output did not match the record",
          attemptsLeft: MAX_DELIVERY_ATTEMPTS - sale.attempts,
        };
  }
}
