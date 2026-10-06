/**
 * What a currency-lab trader is told once, before its first turn. Facts and worked syntax only.
 *
 * Plan §2.9: identical wording for every trader except its own skill, needs, address and label; the
 * canonical asset text; no instruction to hold, spend, convert or prefer either asset; the context
 * validator stays on. The structure enforces the first of those: `personalBlock` is the only part that
 * differs, and `sharedBlock` takes nothing about who is reading — a test compares them byte for byte.
 *
 * Everything the brief says about money is a primitive fact (what the calls are, what the credit is, how a
 * result is counted). It never says what follows from them: not which route leaves more dollars, not that
 * either asset keeps its worth, not that a result is the same either way. Those consequences are the
 * agent's to find (the 2026-10-05 decision on the gate briefs, applied here).
 */
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { ISSUER_SEAT, LAB_TRADERS, needsOf, type Economy, type TraderLabel } from "./economy.js";
import {
  creditNano,
  jobSiu,
  openingUsdcMinor,
  printNano,
  quotedPrice,
  rawWorkRateUsdPerSiu,
  tradeRateUsdPerSiu,
  unitsToDecimal,
} from "./money.js";
import { MAX_DELIVERY_ATTEMPTS } from "./books.js";

export type Counterparty = TraderLabel | "ISSUER";

export interface LabBriefInput {
  me: TraderLabel;
  economy: Economy;
  /** The one print the whole lab uses. */
  print: { printId: string; rateUsdPerSiu: string };
  /** This trader's own address, which every `get_balances` call about itself names. */
  address: string;
  /**
   * What a buyer needs to address each counterparty: the `seller_id` a quote request names and the
   * `model` string it carries. For the issuer the model is a label, not a model — the quote format
   * requires one and nothing reads it.
   */
  directory: Readonly<Record<Counterparty, { sellerId: string; model: string }>>;
  /** The fSIU every trader holds and trades: one token for the lab's whole window. */
  claim: { tokenId: string; classLabel: string; fromIso: string; untilIso: string };
  /** Turns this trader has in all (a turn is one call; waiting is not a turn). */
  maxTurns: number;
  chain: string;
}

const INDEX_VERSION = "SIU-2026a";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Who the reader is, and the three things that differ between traders: skill, needs, address. */
function personalBlock(i: LabBriefInput): string {
  const e = i.economy;
  const needs = needsOf(e, i.me);
  return [
    `YOU ARE ${i.me}.`,
    `  YOUR ADDRESS: ${i.address}`,
    `  YOUR SKILL: you deliver ${e.skillOf[i.me]} jobs, and no other trader can.`,
    `  YOUR NEEDS: ${needs.map((n) => `${n.type} from ${n.seller}, from round ${n.round}`).join("; ")}.`,
  ].join("\n");
}

/** Everything else. Takes nothing about the reader, so it cannot differ between readers. */
function sharedBlock(i: LabBriefInput): string {
  const e = i.economy;
  const p = e.params;
  const print = printNano(i.print.rateUsdPerSiu);
  const size = jobSiu(p);
  const tradeRate = tradeRateUsdPerSiu(print, p);
  const rawRate = rawWorkRateUsdPerSiu(print);
  const tradeQuote = quotedPrice(size, tradeRate).usd;
  const rawQuote = quotedPrice(size, rawRate).usd;
  const credit = unitsToDecimal(creditNano(print, p), 9);
  const openingUsdc = unitsToDecimal(openingUsdcMinor(print, p) * 1000n, 9);
  const traderLines = LAB_TRADERS.map(
    (t) =>
      `  ${t}: skill ${e.skillOf[t]}; sellerId "${i.directory[t].sellerId}"; model "${i.directory[t].model}"`,
  );

  return `THE LAB
  There are ${LAB_TRADERS.length} traders, ${LAB_TRADERS.join(", ")}, and ${ISSUER_SEAT}, which sells raw work.
  The lab has ${p.rounds} rounds in one delivery window, ${i.claim.fromIso} to ${i.claim.untilIso} UTC. Each trader has
  ${p.needsPerTrader} needs: jobs of types it cannot deliver itself, each purchasable from a stated round on.
  A round opens when no trader can act. The lab ends when the last round has gone quiet, or when a
  trader's turns are used. You have at most ${i.maxTurns} turns. Waiting is not a turn.
  Your turn shows, each time, every trader's needs by round and whether each is met, who delivers what,
  and what you can do now.

THE TRADERS
${traderLines.join("\n")}
  ${ISSUER_SEAT}: sellerId "${i.directory.ISSUER.sellerId}"; model "${i.directory.ISSUER.model}"

JOBS
  A job is ${size} SIU. A job of a type is delivered only by the trader whose skill it is. A job's
  price is ${tradeRate} USD per SIU, a quote of ${tradeQuote} USD. A quote request for a job is
  accepted only for a job you currently need, from the trader who delivers that type, at that size and
  that price.

RAW WORK
  Delivering a job uses one unit of raw work. ${ISSUER_SEAT} sells units: a unit is ${size} SIU at the
  published print, ${rawRate} USD per SIU, a quote of ${rawQuote} USD. A unit is credited to you when
  its quote is paid, and is used up when a delivery you make passes. A quote request to ${ISSUER_SEAT} is
  accepted only while you owe more deliveries than you hold units of raw work.

HOW TO BUY
  Step 1 — ask the seller for a quote (a job from its trader, or a unit from ${ISSUER_SEAT}; take sellerId
  and model from THE TRADERS above, and use the rate stated above for what you are buying):
    {"tool": "request_quote", "args": {"siu": "${size}", "model": "<model>",
      "rateUsdPerSiu": "<rate>", "indexVersion": "${INDEX_VERSION}", "printId": "${i.print.printId}",
      "printHash": "0x00", "sellerId": "<sellerId>", "chain": "${i.chain}",
      "expiresInSeconds": 3600, "pattern": "fixed"}}
  Step 2 — the seller answers; the quote appears on your board as "Quotes you have received".
  Step 3 — settle it. These are the ways, for a job and for a unit of raw work alike:
    in USDC:
      {"tool": "pay", "args": {"requestId": "<the requestId>", "settler": "${ZERO_ADDRESS}"}}
    in fSIU, minting a new claim worth the quote's price at the print:
      {"tool": "pay_with_claim", "args": {"requestId": "<the requestId>"}}
    in fSIU, passing on a claim you already hold:
      {"tool": "transfer_claim", "args": {"agentId": "<the seller's name>", "tokenId": "${i.claim.tokenId}",
        "requestId": "<the requestId>"}}
      (the quantity is set from the quote: the amount of claim worth its price at the print)
    partly in each (the claim part is a newly minted claim):
      {"tool": "settle_split", "args": {"requestId": "<the requestId>",
        "claimQuantityMilliSiu": "<how much of it to settle in claims>", "settler": "${ZERO_ADDRESS}"}}
  WHAT EACH COSTS
    Paying in USDC costs USDC. Paying with fSIU you hold costs that fSIU. Minting new fSIU costs USDC, at the
    print, paid to the issuer.
  A transfer_claim may also pass fSIU to a trader with no quote: {"tool": "transfer_claim",
    "args": {"agentId": "<name>", "tokenId": "${i.claim.tokenId}", "quantity": "<mSIU>"}}.

IF YOU ARE THE SELLER OF A JOB
  A request addressed to you appears on your board. {"tool": "issue_quote", "args": {"requestId": "<id>"}}
  answers it with exactly the terms asked. Issuing a quote is not being paid.
  Once the quote is paid you owe the delivery. To deliver you hold one unit of raw work (see RAW WORK),
  then: {"tool": "deliver_job", "args": {"requestId": "<id>"}}. A grader checks the result. A pass uses up
  the unit and meets the buyer's need; an attempt that does not pass leaves the unit with you. A job has at
  most ${MAX_DELIVERY_ATTEMPTS} attempts.
  A quote paid in USDC is held in escrow until you release it: {"tool": "settle_escrow", "args":
  {"requestId": "<id>"}}. It is refused until the job is delivered. A quote paid in fSIU has nothing to
  release; the claim is already yours.

THE FSIU IN THIS LAB
  All fSIU here is one token: tokenId ${i.claim.tokenId}, class ${i.claim.classLabel}, issued by ${ISSUER_SEAT}, for this lab's
  window. Each trader opened the lab holding ${unitsToDecimal(BigInt(p.openingMilliSiu), 3)} SIU of it (${p.openingMilliSiu} mSIU) and ${openingUsdc} USD in USDC.
  {"tool": "get_balances", "args": {"account": "<an address>", "tokenIds": ["${i.claim.tokenId}"]}} reads a balance.
  get_print shows the print: ${i.print.printId}, ${i.print.rateUsdPerSiu} USD per SIU.

${CANONICAL_ASSET_DESCRIPTION}

YOUR RESULT
  Your result is your USDC, plus your fSIU valued at the current print, plus a credit for each need met.
  The credit is ${unitsToDecimal(BigInt(p.creditMultiplierBps), 2)}% of the print per SIU of the job: ${credit} USD for a job of ${size} SIU. It is
  added to the result; it is not paid in either asset. Results are measured before the window closes.`;
}

/** The whole brief, in the order it is read. */
export function buildLabBrief(input: LabBriefInput): string {
  return `${personalBlock(input)}\n\n${sharedBlock(input)}`;
}

/** The part of a brief that does not depend on its reader — exposed so a test can compare readers. */
export const SHARED_BLOCK_MARKER = "\n\nTHE LAB\n";
export function sharedPartOf(brief: string): string {
  const at = brief.indexOf(SHARED_BLOCK_MARKER);
  if (at < 0) throw new Error("not a lab brief: no THE LAB section");
  return brief.slice(at);
}
