/**
 * What a currency-lab trader is told once, before its first turn. Facts and worked syntax only.
 *
 * Plan §2.9: identical wording for every trader except its own skill, needs, address and label; the
 * canonical asset text; no instruction to hold, spend, convert or prefer either asset (it says only that, valued at the current print,
 * converting changes nothing about a result and is never required — D35); the context
 * validator stays on. The asset text is the canonical one with the two sentences about USDC's escrow replaced by what is so
 * of the lab (`asset-text.ts`, D36). The structure enforces the first of those: `personalBlock` is the only part that
 * differs, and `sharedBlock` takes nothing about who is reading — a test compares them byte for byte.
 *
 * Everything the brief says about money is a primitive fact (what the calls are, what each costs, what the supply is,
 * what the credit is, how a result is counted). It never says what follows from them: not which route leaves more dollars, not that
 * either asset keeps its worth, not that a result is the same either way. Those consequences are the
 * agent's to find (the 2026-10-05 decision on the gate briefs, applied here).
 */
import { LAB_ASSET_DESCRIPTION } from "./asset-text.js";
import { ISSUER_SEAT, LAB_TRADERS, needsOf, type Economy, type TraderLabel } from "./economy.js";
import { jobSiu, printNano, unitsToDecimal } from "./money.js";
import { MAX_DELIVERY_ATTEMPTS } from "./books.js";

export type Counterparty = TraderLabel | "ISSUER";

export interface LabBriefInput {
  me: TraderLabel;
  economy: Economy;
  /** Round 1's print: the real print the lab starts from. Later rounds' prints move (D41) and are shown on each turn. */
  print: { printId: string; rateUsdPerSiu: string };
  /** What each trader opens with: the fSIU, and the USDC. Derived from the print and the schedule (D31, D41). */
  opening: { fsiuMilliSiu: bigint; usdcMinor: bigint };
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
  const size = jobSiu(p);
  const tradeMultiple = unitsToDecimal(BigInt(p.tradeMultiplierBps), 4);
  const creditMultiple = unitsToDecimal(BigInt(p.creditMultiplierBps), 4);
  const openingUsdc = unitsToDecimal(i.opening.usdcMinor * 1000n, 9);
  const openingMilliSiu = i.opening.fsiuMilliSiu;
  const round1Print = unitsToDecimal(printNano(i.print.rateUsdPerSiu), 9);
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

THE PRINT
  The print can move at each round. It is a scenario value used only inside this lab; it is not the
  published index. Round 1's print is ${round1Print} USD per SIU. Your turn shows the print of every round so far
  and how much it moved. A quote is priced from the print of the round it is asked for in, and keeps that price.

JOBS
  A job is ${size} SIU. A job of a type is delivered only by the trader whose skill it is. A job's
  price is ${tradeMultiple} times the print per SIU; your turn shows the price and the quote for the round in force.
  A quote request for a job is accepted only for a job you currently need, from the trader who delivers
  that type, at that size and that price.

RAW WORK
  Delivering a job uses one unit of raw work. ${ISSUER_SEAT} sells units: a unit is ${size} SIU at the
  print, so its price is the print per SIU; your turn shows the price and the quote for the round in force.
  A unit is credited to you when its quote is paid, and is used up when a delivery you make passes. A quote
  request to ${ISSUER_SEAT} is accepted only while you owe more deliveries than you hold units of raw work.

HOW TO BUY
  Step 1 — ask the seller for a quote (a job from its trader, or a unit from ${ISSUER_SEAT}; take sellerId
  and model from THE TRADERS above, and use the rate your turn states for what you are buying, in the round in force):
    {"tool": "request_quote", "args": {"siu": "${size}", "model": "<model>",
      "rateUsdPerSiu": "<rate>", "indexVersion": "${INDEX_VERSION}", "printId": "${i.print.printId}",
      "printHash": "0x00", "sellerId": "<sellerId>", "chain": "${i.chain}",
      "expiresInSeconds": 3600, "pattern": "fixed"}}
  Step 2 — the seller answers; the quote appears on your board as "Quotes you have received".
  Step 3 — settle it, by any of these. Each names the quote by its requestId, each works for a job and for a
  unit of raw work alike, and each reaches the seller at the moment you make it:
    {"tool": "pay_with_usdc", "args": {"requestId": "<the requestId>"}}
    {"tool": "pay_with_held_claim", "args": {"requestId": "<the requestId>"}}
    {"tool": "pay_split", "args": {"requestId": "<the requestId>", "claimQuantityMilliSiu": "<mSIU of the claim part>"}}
  WHAT EACH COSTS
    Paying in USDC costs USDC. Paying with fSIU you hold costs that fSIU. Paying with both costs the fSIU you give
    and the rest of the price in USDC.

IF YOU ARE THE SELLER OF A JOB
  A request addressed to you appears on your board. {"tool": "issue_quote", "args": {"requestId": "<id>"}}
  answers it with exactly the terms asked. Issuing a quote is not being paid.
  Once the quote is paid you owe the delivery. To deliver you hold one unit of raw work (see RAW WORK),
  then: {"tool": "deliver_job", "args": {"requestId": "<id>"}}. A grader checks the result. A pass uses up
  the unit and meets the buyer's need; an attempt that does not pass leaves the unit with you. A job has at
  most ${MAX_DELIVERY_ATTEMPTS} attempts.
  A payment reaches you at the moment it is made, in whichever asset it is in; there is nothing to release.

THE FSIU IN THIS LAB
  All fSIU here is one token: tokenId ${i.claim.tokenId}, class ${i.claim.classLabel}, issued by ${ISSUER_SEAT}, for this lab's
  window. Each trader opened the lab holding ${unitsToDecimal(openingMilliSiu, 3)} SIU of it (${openingMilliSiu} mSIU) and ${openingUsdc} USD in USDC.
  The fSIU in the lab is that opening supply. Nothing creates more during the run.
  {"tool": "get_balances", "args": {"account": "<an address>", "tokenIds": ["${i.claim.tokenId}"]}} reads a balance.

${LAB_ASSET_DESCRIPTION}

YOUR RESULT
  Your result is your USDC, plus your fSIU valued at the current print, plus a credit for each need met.
  The credit is ${unitsToDecimal(BigInt(p.creditMultiplierBps), 2)}% of the current print per SIU of the job (${creditMultiple} times the print for a job of ${size} SIU). It is
  added to the result; it is not paid in either asset. Results are measured before the window closes, at the print then
  in force. Valued at the current print, converting between the two assets changes nothing about your result, and you
  are never required to convert.`;
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
