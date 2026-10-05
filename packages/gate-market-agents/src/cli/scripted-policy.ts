/**
 * The scripted-policy mode: every seat's decision comes from a fixed script instead of a model call.
 *
 * **What it is for.** Of the six payment decisions in the last full debug run, all six were USDC, so
 * no claim existed and every fSIU path — mint-and-forward, payment from a held balance, redemption,
 * the bond paying a default, an unpresented claim expiring — had never run in the loop against the
 * real chain. The live chain has caught six stale-read defects that no local test reproduced, which
 * is the reason this runs live and not only locally. Forcing a *model* to pay in fSIU would change
 * what the experiment measures; a script changes nothing an agent can read.
 *
 * **What it is not.** Never evidence of behaviour. `--scripted` requires `--debug` and is
 * disqualified like every debug run (`debug-mode.ts`), and no model is called, so there is no
 * agent whose choices could be reported.
 *
 * **The seam.** The loop calls `agent.adapter(modelString, prompt, params)`. A scripted seat is an
 * adapter that reads the same prompt a model would and returns the next tool call, so the loop, the
 * tools, the board, the wake gates, the validator and the chain are all the real ones. Nothing in
 * any prompt changes, and no instruction to use either asset exists anywhere an agent can read: this
 * module is imported only by the flag path, and a test asserts a seat's prompt is byte-identical
 * with a scripted adapter and with a model's.
 *
 * **How a seat knows what to do.** From the text of its own prompt — the same structured sections a
 * model reads (`MARKET BOARD`, `A WORK CLAIM WAS TRANSFERRED TO YOU`, `A CLAIM WAS PRESENTED AGAINST
 * YOU`, …) — never from a side channel into the loop. The parsers below are tested against the loop's
 * own renderers, so a change to what agents are shown that the scripts cannot read fails a test
 * instead of silently stalling a run. A step whose cue never appears is reported as unperformed.
 *
 * **The walk** (the plan in `docs/plan-scripted-mode-and-arms-2026-10-05.md` §2):
 *
 * | window | what is exercised |
 * | --- | --- |
 * | 1, ISSUER-B | mint-and-forward; WORKER-CODE pays for testing out of the held claim (onward, in part); WORKER-CODE redeems the REMAINDER; ISSUER-B serves it; the testing seller leaves its share unpresented |
 * | 2, ISSUER-A | a claim routed to ISSUER-A and presented to it, never served; the unpresented share from window 1 is settled (Expired); the dollar route as a control |
 * | 3, ISSUER-A | the window-2 claim settled by its holder (Defaulted, the bond pays); the dollar route as a control |
 */
import { keccak256, stringToBytes } from "viem";
import type { Adapter, AdapterResult } from "@touchstone/harness";

export type ScriptedSeat = "ORCHESTRATOR" | "WORKER-CODE" | "WORKER-EXTRACT" | "ISSUER-A" | "ISSUER-B";
export const SCRIPTED_SEATS: readonly ScriptedSeat[] = [
  "ORCHESTRATOR",
  "WORKER-CODE",
  "WORKER-EXTRACT",
  "ISSUER-A",
  "ISSUER-B",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** What a script needs that is not in a prompt: how to word a quote request, and the pinned gate. */
export interface ScriptEnv {
  /** The two sellers' erc8004 ids, as a quote names them. */
  sellerIds: { "WORKER-CODE": string; "WORKER-EXTRACT": string };
  /** The print the run prices against. */
  print: { printId: string; printHash: string; rateUsdPerSiu: string; indexVersion: string };
  chain: string;
  /** Job sizes in SIU as decimal strings — the run's own `RUN_PURCHASES`, never retyped here. */
  sizes: { gate: string; testing: string };
  /** Seconds a quote lives. A quote that outlives its window only strands a reservation. */
  quoteExpirySeconds: number;
  /** The pinned, already-graded gate an issuer submits to deliver a redemption. */
  pinnedGateSource: string;
  /** A deliberately wrong submission for the testing seller to attack the gate with. */
  attackSource: string;
}

/** What a seat decides on one turn, in the shape the loop's own parser reads. */
export type ScriptedIntent =
  | { tool: string; args: Record<string, unknown> }
  | { wait: true }
  | { done: true; summary: string };

// ---------------------------------------------------------------------------------------------
// Cues. Every parser reads a section the loop itself renders, anchored on its header at the start
// of a line so that a tool description or a history line quoting the same words cannot match.
// ---------------------------------------------------------------------------------------------

/** The window a prompt belongs to, from the run-shape facts every seat's brief carries. */
export function windowOf(prompt: string): number | undefined {
  const m = /THIS IS WINDOW (\d+)\./.exec(prompt);
  return m ? Number(m[1]) : undefined;
}

/**
 * The lines of one prompt section: everything after `header` up to a blank line or the next line
 * that starts in column 0. The second stop matters — the board renders its sections back to back
 * with no blank line between, so a section that ran to the blank line would swallow the next one's
 * items (the quotes a buyer has RECEIVED would be read as work a seller is OWED).
 */
function sectionLines(prompt: string, header: RegExp): string[] {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => header.test(l));
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || /^\S/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

/** `Open quote requests addressed to you` — what a seller is asked to quote. */
export function openRequests(prompt: string): { requestId: string; from: string; siu: string }[] {
  return sectionLines(prompt, /^Open quote requests addressed to you/)
    .map((l) => /^\s+(qr-\d+): from ([A-Z-]+), ([\d.]+) SIU,/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ requestId: m[1], from: m[2], siu: m[3] }));
}

/** `Quotes you have received` — what a buyer may now pay. */
export function receivedQuotes(prompt: string): { requestId: string; seller: string }[] {
  return sectionLines(prompt, /^Quotes you have received/)
    .map((l) => /^\s+answers (qr-\d+): seller (\S+?),/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ requestId: m[1], seller: m[2] }));
}

/** `YOU HAVE BEEN PAID AND OWE THE WORK` — dollar-route quotes this seller must now deliver. */
export function owedInUsdc(prompt: string): string[] {
  return sectionLines(prompt, /^YOU HAVE BEEN PAID AND OWE THE WORK/)
    .map((l) => /^\s+answers (qr-\d+):/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

/** `A WORK CLAIM WAS TRANSFERRED TO YOU` — a claim now held, and the quote it settles, if any. */
export function claimTransferred(
  prompt: string,
): { tokenId: string; quantity: string; settles?: string } | undefined {
  const lines = sectionLines(prompt, /^A WORK CLAIM WAS TRANSFERRED TO YOU$/);
  const head = lines.map((l) => /^\s+tokenId (\d+), quantity (\d+)\./.exec(l)).find((m) => m !== null);
  if (!head) return undefined;
  const settles = lines.map((l) => /^\s+It settles your quote (qr-\d+)\./.exec(l)).find((m) => m !== null);
  return { tokenId: head[1], quantity: head[2], ...(settles ? { settles: settles[1] } : {}) };
}

/** `A CLAIM WAS PRESENTED AGAINST YOU` — what an issuer owes. */
export function presentedAgainstMe(
  prompt: string,
): { tokenId: string; holder: string; quantity: string } | undefined {
  const m = sectionLines(prompt, /^A CLAIM WAS PRESENTED AGAINST YOU$/)
    .map((l) => /^\s+tokenId (\d+), holder ([A-Z-]+), quantity (\d+)\./.exec(l))
    .find((x) => x !== null);
  return m ? { tokenId: m[1], holder: m[2], quantity: m[3] } : undefined;
}

/** `PENDING REDEMPTION ROUTED TO YOU` — the exact values `serve_redemption` is to be called with. */
export function pendingRedemption(prompt: string):
  | { tokenId: string; holder: string; quantity: string; passed: boolean; receiptRef: string }
  | undefined {
  const m = sectionLines(prompt, /^PENDING REDEMPTION ROUTED TO YOU$/)
    .map((l) =>
      /^\s+tokenId (\d+), holder ([A-Z-]+), quantity (\d+), real graded result: passed=(true|false), receiptRef (0x[0-9a-fA-F]+)/.exec(
        l,
      ),
    )
    .find((x) => x !== null);
  return m
    ? { tokenId: m[1], holder: m[2], quantity: m[3], passed: m[4] === "true", receiptRef: m[5] }
    : undefined;
}

/** One claim an earlier window left unsettled, as `renderSettleableText` lists it. */
export interface UnsettledClaim {
  tokenId: string;
  mintedInWindow: number;
  issuer?: string;
  heldBy?: string;
  presented?: boolean;
}

/** `CLAIMS LEFT UNSETTLED BY AN EARLIER WINDOW` — what anyone may now settle. */
export function unsettledClaims(prompt: string): UnsettledClaim[] {
  const out: UnsettledClaim[] = [];
  for (const line of sectionLines(prompt, /^CLAIMS LEFT UNSETTLED BY AN EARLIER WINDOW$/)) {
    const m = /^\s+tokenId (\d+) — minted in window (\d+)(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[3];
    out.push({
      tokenId: m[1],
      mintedInWindow: Number(m[2]),
      issuer: /issued by ([A-Z-]+)/.exec(rest)?.[1],
      heldBy: /held by ([A-Z-]+)/.exec(rest)?.[1],
      presented: /NEVER PRESENTED/.test(rest) ? false : /PRESENTED, so/.test(rest) ? true : undefined,
    });
  }
  return out;
}

/** The task-spec hash the claim facts tell a holder to present with. */
export function taskSpecHashIn(prompt: string): string | undefined {
  return /"taskSpecHash": "(0x[0-9a-fA-F]{64})"/.exec(prompt)?.[1];
}

// ---------------------------------------------------------------------------------------------
// The scripts.
// ---------------------------------------------------------------------------------------------

/** What a script sees of one turn. */
export interface Cue {
  prompt: string;
  window: number;
}

interface Memory {
  performed: Set<string>;
  /** Facts a seat learned from an earlier prompt that a later one no longer shows — a claim's
   *  tokenId is on the holder's notice only until the claim is passed on. */
  facts: Map<string, string>;
}

interface Step {
  /** Stable name; also the key of the expected-steps list a run is checked against. */
  id: string;
  window: number;
  /** Whether this step is warranted by this turn's prompt and this seat's memory. */
  when: (c: Cue, m: Memory) => boolean;
  act: (c: Cue, m: Memory) => ScriptedIntent;
  /** Learn from the prompt even when no step fires; run on every turn. */
  observe?: (c: Cue, m: Memory) => void;
}

const key = (window: number, id: string): string => `w${window}:${id}`;

/** Every step a seat is expected to perform, by window — the list a finished run is checked against. */
export const EXPECTED_STEPS: Readonly<Record<ScriptedSeat, Readonly<Record<number, readonly string[]>>>> = {
  ORCHESTRATOR: {
    1: ["request_gate", "pay_gate_with_claim"],
    2: ["request_gate", "pay_gate_with_claim"],
    3: ["request_gate", "pay_gate_in_usdc"],
  },
  "WORKER-CODE": {
    1: ["issue_gate_quote", "request_testing", "pay_testing_from_held_claim", "redeem_remainder"],
    2: ["issue_gate_quote", "present_claim", "request_testing", "pay_testing_in_usdc"],
    3: [
      "issue_gate_quote",
      "reserve_for_work",
      "settle_escrow",
      "request_testing",
      "pay_testing_in_usdc",
      "settle_defaulted_claim",
    ],
  },
  "WORKER-EXTRACT": {
    1: ["issue_testing_quote", "attack"],
    2: ["issue_testing_quote", "settle_expired_claim", "reserve_for_work", "attack", "settle_escrow"],
    3: ["issue_testing_quote", "reserve_for_work", "attack", "settle_escrow"],
  },
  "ISSUER-A": {},
  "ISSUER-B": { 1: ["deliver", "serve"] },
};

function requestQuote(env: ScriptEnv, seller: "WORKER-CODE" | "WORKER-EXTRACT", siu: string, model: string): ScriptedIntent {
  return {
    tool: "request_quote",
    args: {
      siu,
      model,
      rateUsdPerSiu: env.print.rateUsdPerSiu,
      indexVersion: env.print.indexVersion,
      printId: env.print.printId,
      printHash: env.print.printHash,
      sellerId: env.sellerIds[seller],
      chain: env.chain,
      expiresInSeconds: env.quoteExpirySeconds,
      pattern: "fixed",
    },
  };
}

function stepsFor(seat: ScriptedSeat, env: ScriptEnv): Step[] {
  const issueFor = (id: string, window: number, from: string): Step => ({
    id,
    window,
    when: (c) => openRequests(c.prompt).some((r) => r.from === from),
    act: (c) => ({
      tool: "issue_quote",
      args: { requestId: openRequests(c.prompt).find((r) => r.from === from)!.requestId },
    }),
  });
  const settleHeld = (id: string, window: number, seat: ScriptedSeat, presented: boolean): Step => ({
    id,
    window,
    when: (c, m) => unsettledClaims(c.prompt).some((u) => u.heldBy === seat && u.presented === presented && !m.facts.has(`settled:${u.tokenId}`)),
    act: (c, m) => {
      const claim = unsettledClaims(c.prompt).find((u) => u.heldBy === seat && u.presented === presented && !m.facts.has(`settled:${u.tokenId}`))!;
      m.facts.set(`settled:${claim.tokenId}`, "1");
      // The holder is named so the call is unambiguous when a token has more than one.
      return { tool: "settle_window_close", args: { tokenId: claim.tokenId, holder: seat } };
    },
  });
  const reserveThenSettle = (window: number): Step[] => [
    { id: "reserve_for_work", window, when: (c) => owedInUsdc(c.prompt).length > 0, act: () => ({ tool: "reserve_for_work", args: {} }) },
    {
      id: "settle_escrow",
      window,
      when: (c, m) => owedInUsdc(c.prompt).length > 0 && m.performed.has(key(window, "reserve_for_work")),
      act: () => ({ tool: "settle_escrow", args: {} }),
    },
  ];

  switch (seat) {
    case "ORCHESTRATOR":
      return [1, 2, 3].flatMap((w): Step[] => [
        {
          id: "request_gate",
          window: w,
          when: () => true,
          act: () => requestQuote(env, "WORKER-CODE", env.sizes.gate, "claude-sonnet-5"),
        },
        {
          id: w === 3 ? "pay_gate_in_usdc" : "pay_gate_with_claim",
          window: w,
          when: (c) => receivedQuotes(c.prompt).length > 0,
          act: (c) => {
            const requestId = receivedQuotes(c.prompt)[0].requestId;
            return w === 3
              ? { tool: "pay", args: { requestId, settler: ZERO_ADDRESS } }
              : { tool: "pay_with_claim", args: { requestId } };
          },
        },
      ]);

    case "WORKER-CODE": {
      const requestTesting = (window: number, gate: (c: Cue, m: Memory) => boolean): Step => ({
        id: "request_testing",
        window,
        when: gate,
        act: () => requestQuote(env, "WORKER-EXTRACT", env.sizes.testing, "claude-haiku-4-5"),
      });
      const payTestingInUsdc = (window: number): Step => ({
        id: "pay_testing_in_usdc",
        window,
        when: (c, m) => m.performed.has(key(window, "request_testing")) && receivedQuotes(c.prompt).length > 0,
        act: (c) => ({
          tool: "pay",
          args: { requestId: receivedQuotes(c.prompt)[0].requestId, settler: ZERO_ADDRESS },
        }),
      });
      const observeClaim = (c: Cue, m: Memory): void => {
        const held = claimTransferred(c.prompt);
        if (held && !m.facts.has(`claim:${c.window}`)) {
          m.facts.set(`claim:${c.window}`, held.tokenId);
          m.facts.set(`claimQuantity:${c.window}`, held.quantity);
        }
        const hash = taskSpecHashIn(c.prompt);
        if (hash) m.facts.set("taskSpecHash", hash);
      };
      const redeem = (window: number, id: string): Step => ({
        id,
        window,
        when: (_c, m) => m.facts.has(`claim:${window}`) && m.facts.has("taskSpecHash"),
        act: (_c, m) => ({
          tool: "redeem_claim",
          args: { tokenId: m.facts.get(`claim:${window}`)!, taskSpecHash: m.facts.get("taskSpecHash")! },
        }),
      });
      return [
        // Window 1 — a claim arrives, a part of it pays for testing, the REMAINDER is redeemed.
        { ...issueFor("issue_gate_quote", 1, "ORCHESTRATOR"), observe: observeClaim },
        requestTesting(1, (_c, m) => m.facts.has("claim:1")),
        {
          id: "pay_testing_from_held_claim",
          window: 1,
          when: (c, m) =>
            m.performed.has(key(1, "request_testing")) && m.facts.has("claim:1") && receivedQuotes(c.prompt).length > 0,
          act: (c, m) => ({
            tool: "transfer_claim",
            args: {
              agentId: "WORKER-EXTRACT",
              tokenId: m.facts.get("claim:1")!,
              requestId: receivedQuotes(c.prompt)[0].requestId,
            },
          }),
        },
        {
          ...redeem(1, "redeem_remainder"),
          when: (_c, m) => m.performed.has(key(1, "pay_testing_from_held_claim")) && m.facts.has("claim:1") && m.facts.has("taskSpecHash"),
        },
        // Window 2 — the claim routed to ISSUER-A is presented to it; the dollar route is the control.
        { ...issueFor("issue_gate_quote", 2, "ORCHESTRATOR"), observe: observeClaim },
        redeem(2, "present_claim"),
        requestTesting(2, (_c, m) => m.performed.has(key(2, "present_claim"))),
        payTestingInUsdc(2),
        // Window 3 — the window-2 claim, presented and never served, is settled by the holder the
        // bond pays; and the rest is owed in dollars. The settlement comes FIRST, deliberately: it is
        // only checked for what its settler was then shown if the settler takes another turn, and a
        // settlement that is the seat's last step may be followed by none.
        settleHeld("settle_defaulted_claim", 3, "WORKER-CODE", true),
        { ...issueFor("issue_gate_quote", 3, "ORCHESTRATOR"), observe: observeClaim },
        ...reserveThenSettle(3),
        requestTesting(3, (_c, m) => m.performed.has(key(3, "settle_escrow"))),
        payTestingInUsdc(3),
      ];
    }

    case "WORKER-EXTRACT":
      return [
        issueFor("issue_testing_quote", 1, "WORKER-CODE"),
        {
          id: "attack",
          window: 1,
          when: (c) => claimTransferred(c.prompt) !== undefined,
          act: () => ({ tool: "submit_attack", args: { submissionSource: env.attackSource } }),
        },
        // Window 2 — settle the share window 1 left unpresented (it expires and pays nobody), then
        // sell testing for dollars.
        issueFor("issue_testing_quote", 2, "WORKER-CODE"),
        settleHeld("settle_expired_claim", 2, "WORKER-EXTRACT", false),
        ...[2, 3].flatMap((w): Step[] => [
          ...(w === 3 ? [issueFor("issue_testing_quote", 3, "WORKER-CODE")] : []),
          reserveThenSettle(w)[0],
          {
            id: "attack",
            window: w,
            when: (_c, m) => m.performed.has(key(w, "reserve_for_work")),
            act: () => ({ tool: "submit_attack", args: { submissionSource: env.attackSource } }),
          },
          {
            ...reserveThenSettle(w)[1],
            when: (c, m) => owedInUsdc(c.prompt).length > 0 && m.performed.has(key(w, "attack")),
          },
        ]),
      ];

    case "ISSUER-B":
      return [
        {
          id: "deliver",
          window: 1,
          when: (c) => presentedAgainstMe(c.prompt) !== undefined,
          act: () => ({ tool: "submit_job", args: { source: env.pinnedGateSource } }),
        },
        {
          id: "serve",
          window: 1,
          when: (c) => pendingRedemption(c.prompt) !== undefined,
          act: (c) => {
            const p = pendingRedemption(c.prompt)!;
            return {
              tool: "serve_redemption",
              args: { tokenId: p.tokenId, holder: p.holder, quantity: p.quantity, passed: p.passed, receiptRef: p.receiptRef },
            };
          },
        },
      ];

    case "ISSUER-A":
      // Cannot serve, by design: it has no `serve_redemption` and the script does not pretend to.
      return [];
  }
}

const EMPTY_USAGE = { input: 0, output: 0, cached_input: 0, reasoning: 0 } as const;

function resultOf(intent: ScriptedIntent): AdapterResult {
  return {
    text: JSON.stringify(intent),
    stopReason: "end_turn",
    usage: { ...EMPTY_USAGE },
    latency_ms: 0,
    raw: {},
    deviations: [],
  };
}

export interface ScriptStatus {
  seat: ScriptedSeat;
  window: number;
  step: string;
  performed: boolean;
}

export interface ScriptedSeats {
  adapters: Record<ScriptedSeat, Adapter>;
  /** Every expected step and whether the seat issued it. A step is *issued*, not *succeeded*: the
   *  tool's own result is in the run's turn logs, and the verifier reads it from there. */
  status: () => ScriptStatus[];
}

/** One scripted adapter per seat, sharing nothing but the environment they were built from. */
export function scriptedSeats(env: ScriptEnv): ScriptedSeats {
  const memory = Object.fromEntries(
    SCRIPTED_SEATS.map((s) => [s, { performed: new Set<string>(), facts: new Map<string, string>() } as Memory]),
  ) as Record<ScriptedSeat, Memory>;

  const adapters = Object.fromEntries(
    SCRIPTED_SEATS.map((seat) => {
      const steps = stepsFor(seat, env);
      const mem = memory[seat];
      const adapter: Adapter = async (_model, prompt) => {
        const window = windowOf(prompt);
        if (window === undefined) {
          throw new Error(`scripted ${seat}: this prompt carries no "THIS IS WINDOW n." line, so the script cannot place it.`);
        }
        const cue: Cue = { prompt, window };
        for (const s of steps) if (s.window === window) s.observe?.(cue, mem);
        const next = steps.find(
          (s) => s.window === window && !mem.performed.has(key(window, s.id)) && s.when(cue, mem),
        );
        if (next) {
          mem.performed.add(key(window, next.id));
          return resultOf(next.act(cue, mem));
        }
        // Nothing warranted. A seat that has done everything it will do this window leaves; one
        // that is still owed a cue (a seller awaiting a request, an issuer awaiting a claim) waits.
        const owed = (EXPECTED_STEPS[seat][window] ?? []).filter((id) => !mem.performed.has(key(window, id)));
        const leaves = seat !== "ISSUER-A" && seat !== "ISSUER-B" && owed.length === 0;
        return resultOf(leaves ? { done: true, summary: "script complete for this window" } : { wait: true });
      };
      return [seat, adapter];
    }),
  ) as Record<ScriptedSeat, Adapter>;

  return {
    adapters,
    status: () =>
      SCRIPTED_SEATS.flatMap((seat) =>
        Object.entries(EXPECTED_STEPS[seat]).flatMap(([w, ids]) =>
          ids.map((step) => ({
            seat,
            window: Number(w),
            step,
            performed: memory[seat].performed.has(key(Number(w), step)),
          })),
        ),
      ),
  };
}

/** A deliberately wrong module: it exports the function and returns its input unchanged. */
export const STUB_ATTACK_SOURCE =
  "export function dedupeSorted(arr) {\n  return arr; // identity: never removes a duplicate\n}\n";

/** The task-spec hash a scripted holder presents with is the one its own brief states; this is only
 *  here so a test can build the same string the runner builds. */
export function taskSpecHashFor(jobId: string): string {
  return keccak256(stringToBytes(`gate-hardening:${jobId}`));
}
