import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import { withBackoff, type Adapter } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import {
  CODE_COMMERCIAL_INTENT,
  PINNED_TEST_SUITE,
} from "@touchstone/task-pack-gate-hardening";
import type { HeldOutInstance, ReferenceTaskInstance } from "@touchstone/task-pack-gate-hardening";
import type { ModelPrices } from "../budget/inference-cost.js";

/**
 * The pieces every real P5 runner needs identically — extracted when the three-window runner was
 * added (2026-09-28) so the two cannot drift on the things that must not differ between them: the
 * registry prices they cost turns against, which real print they price work at, and the exact
 * technical contract a gate author is held to. Everything window-shaped (briefs, rosters, tool
 * grants, scarcity schedule) deliberately stays in each runner, because that is what actually
 * differs between a one-window run and a three-window one.
 */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
export const LEDGER_PATH = join(REPO_ROOT, "data/gate-market/experiment-ledger.json");

/** Real, current registry prices (data/registry/price-snapshot-merged-2026-09-25T00-59-34.865Z.json,
 * the latest snapshot at the time these runners were written) — never invented. */
export const PRICES: Record<string, ModelPrices> = {
  "gpt-5.1": { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" },
  "mistral-small-3.2-24b-instruct": { priceInUsdPer1M: "0.09", priceOutUsdPer1M: "0.3" },
  "claude-sonnet-5": { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" },
  "gemini-3.1-pro-preview": { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" },
  "grok-4.6": { priceInUsdPer1M: "2", priceOutUsdPer1M: "6" },
};

/**
 * The real rate every mint/quote in a P5 run attests to and reads. Loads the most recently
 * published real `<date>-commodity.json` print under data/prints/ directly — not via
 * `@touchstone/print`'s own CLI loaders (`cli/load-inputs.ts`'s `repoRoot()` assumes
 * `process.cwd()` is `packages/print` itself, an assumption these scripts must not borrow from a
 * different package's cwd). Commodity, not blended: both testbed issuers' capacity models are
 * commodity-class, so it is the correct grade for their claims.
 */
export function loadLatestCommodityPrint(): Print {
  const printsDir = join(REPO_ROOT, "data/prints");
  const files = readdirSync(printsDir)
    .filter((f) => f.endsWith("-commodity.json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`loadLatestCommodityPrint: no "<date>-commodity.json" print found under ${printsDir}.`);
  }
  return JSON.parse(readFileSync(join(printsDir, latest), "utf-8")) as Print;
}

export function withPinnedTestSuite(instance: ReferenceTaskInstance): ReferenceTaskInstance {
  return { ...instance, files: { ...instance.files, "pinned-test-cases.txt": PINNED_TEST_SUITE } };
}

export function withPinnedTestSuiteHeldOut(held: HeldOutInstance): HeldOutInstance {
  return { ...held, referenceInstance: withPinnedTestSuite(held.referenceInstance) };
}

export function toHex(raw: string | undefined, name: string): Hex {
  if (!raw) throw new Error(`${name} is not set.`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

/** `runFullRunWindow` calls each agent's adapter directly, unwrapped — fine for a single request,
 * but a real multi-turn, multi-provider live run hits OpenRouter's shared free-tier 429s
 * intermittently under load with no other change (confirmed live, both here and in
 * packages/agents/src/cli/demo.ts). `withBackoff` already exists for exactly this. */
export function withRetry(adapter: Adapter): Adapter {
  return (model, prompt, params) => withBackoff(() => adapter(model, prompt, params));
}

/** The gate-authoring contract WORKER-CODE is held to — identical in every runner by design: a
 * gate authored under different terms in different runs could not be compared across them. */
export const TECHNICAL_CONTRACT = `
THE FUNCTION UNDER TEST: a submission provides a named export \`dedupeSorted(arr)\` from a file
  called answer.mjs. It must remove consecutive duplicate values from a sorted array of numbers,
  preserving order.

COMMERCIAL INTENT:
  ${CODE_COMMERCIAL_INTENT}

THE PINNED TEST SUITE (the real, operator-authored test cases your gate must run — reproduced
here exactly, and also available to your gate at runtime as data):
---
${PINNED_TEST_SUITE}---
  Each line above is a real node:test case body. It assumes \`test\` (from "node:test"), \`assert\`
  (from "node:assert/strict") and \`dedupeSorted\` (the submission's own export) are already
  imported and in scope wherever it runs.

HOW A GATE IS AUTHORED (technical contract, not a solution):
  Your gate's source is a JavaScript ES module. It must export:
    export async function gate({ referenceDir, submissionDir }) {
      // referenceDir + "/pinned-test-cases.txt" holds the exact test-case bodies shown above.
      // submissionDir + "/answer.mjs" is the submission being graded.
      // Genuinely execute the pinned cases against THIS submission's own dedupeSorted every time.
      // Return { accept: <boolean>, reason: <string> }.
    }
  It runs inside a sandbox with node:fs and node:child_process available (spawning the node
  binary itself, at process.execPath, is allowed) — no network, no other imports beyond node
  builtins. Any file your gate needs to write must be written under referenceDir.

  YOUR GATE MUST ESTABLISH THAT ITS OWN SUITE RAN TO COMPLETION. A submission decides how much
  of your suite it lets you reach: it can end your test process early, and it can produce output
  that looks like your own success report. A gate that concludes from the cases that happened to
  report — or from anything the submission was able to print — accepts work it never checked.
  Decide from what you can establish yourself. How you do that is yours to work out; that you do
  it is not optional, and a submission that defeats you this way is in the adversarial set.

TO SUBMIT A GATE, respond with exactly:
  {"tool": "submit_job", "args": {"source": "<your full gate module source as a JSON string>"}}
  If it does not pass every check, you will see exactly which check failed and why on your next
  turn — revise and resubmit within your turn budget.
`;

/**
 * What a claim IS, stated to everyone who can hold one, in the same words everywhere.
 *
 * Added 2026-09-30 for two reasons, one of them a correction. The briefs used to tell a holder
 * to "confirm the balance with get_balances, then present it with exactly: {redeem_claim ...}",
 * which is a single prescribed path presented as the thing one does with a claim — and it
 * supplied exact call syntax for redeeming and for nothing else. Withholding the syntax for the
 * alternatives is itself a steer, the same shape as the turn-cost asymmetry that manufactured
 * the "9 of 9 chose fSIU" figure (spec §4.6f). Every option below therefore gets the same
 * treatment: what it does, and exactly how to call it.
 *
 * These are facts about the instrument, not advice. Nothing here says which to use, and nothing
 * anywhere else should either — a push toward holding would contaminate the measurement exactly
 * as the push toward redeeming did, only in the other direction. If agents still redeem
 * immediately now that the alternatives are real and equally documented, that is the finding.
 */
export function claimFactsFor(taskSpecHash: string): string {
  return `
WHAT A WORK CLAIM IS, AND EVERYTHING YOU CAN DO WITH ONE
  A claim is a dated, transferable right to a quantity of work from ONE issuer's bonded
  capacity. Holding it is a position: it is fixed in SIU, so its dollar value is whatever the
  published print says a SIU costs.

  You have all of the following. Nothing here says which to use, or when.

  REDEEM IT for the work, inside its delivery window:
    {"tool": "redeem_claim", "args": {"tokenId": "<tokenId>", "taskSpecHash": "${taskSpecHash}"}}
    You present it; the issuer then serves it and may serve part of the quantity rather than all.

  TRANSFER IT to another agent, free, at any time, in whole or in part:
    {"tool": "transfer_claim", "args": {"agentId": "<AGENT>", "tokenId": "<tokenId>",
      "quantity": "<mSIU>"}}
    A claim is divisible: transferring part of it leaves you holding the rest.

  PAY WITH IT — settle something you are buying, without redeeming first:
    {"tool": "pay_with_claim", "args": {"agentId": "<AGENT>", "quantity": "<mSIU>"}}

  IF THE ISSUER DOES NOT DELIVER, the bond pays you instead. Once the delivery window closes
  with the claim unredeemed, it can no longer be redeemed for work: if you presented it and were
  not served, it is claimable against that issuer's bond; if you never presented it, it simply
  expires and pays nothing.

  A claim carries the delivery window it was minted for. Holding it past that window does not
  move the window.
`;
}

/**
 * The instrument asymmetry, stated identically wherever it is shown — to agents, in run output,
 * and in docs/gate-market-spec.md §4.4. Both routes draw on one finite bonded pool as of
 * 2026-09-28; what remains different between them is a property of the two instruments, not of
 * the plumbing, and saying so in one place keeps the three statements from drifting apart.
 */
export const ONE_POOL_DISCLOSURE = `
CAPACITY IS ONE POOL, AND THE TWO WAYS OF PAYING ARE NOT THE SAME INSTRUMENT
  Every issuer bonds a finite amount of capacity per task class, shared between all buyers,
  first-come-first-served. Both ways of paying draw on that same pool:
    - A dated work claim (fSIU) consumes an issuer's headroom when it is minted. It reserves
      capacity for a FUTURE delivery window, and it is TRANSFERABLE — it can be held, passed on,
      and redeemed by whoever ends up holding it.
    - A dollar payment consumes the same headroom when the seller commits capacity to the job.
      That reservation is for IMMEDIATE work only: it is not transferable, not holdable, and ends
      when the escrow does.
  The issuer is paid for a claim. The issuer is not paid for a reservation on the dollar route —
  a real gap in this testbed, disclosed rather than papered over with an invented fee.
`;
