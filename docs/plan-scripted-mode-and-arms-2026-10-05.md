# Plan: a scripted-policy mode, then the arm V / H change set

Written 2026-10-05 per the working agreement (this touches well over two files). **Plan only for
steps b–f; nothing of them is built.** Done so far: the debug artefacts are committed (step a), the
dollar-exit question is answered (§1), and the pre-registration and the second-market plan are
written (`preregistration-arm-v-h-2026-10-05.md`, `plan-second-market-2026-10-05.md`).

## 1. Reported first: the window-1 dollar exit is not possible without a redeploy

USDC leaves `WorkClaim` and `CapacityBond` in exactly three places: the minter's payment to the
issuer at mint, the bond deposit, and `CapacityBond.draw`, which only the Defaulted path of
`settleWindowClose` calls — after the window has closed, for a *presented, unserved* claim. **No
function lets a holder return a claim to its issuer for USDC.** A sell-back at the print would need a
new function, so a redeploy of the whole trio. A bilateral sale through existing tools (transfer the
claim to the issuer, issuer pays) needs the issuer agent to agree each time and is not a sale at the
print in force; it would also be an agent-facing capability that does not exist. Per the instruction:
**dropped.** Spec §4.6bb. Liquidity is recorded as a confound, proposed caption text:

> fSIU has no dollar exit in this testbed: a claim can be redeemed for work or passed on, and cannot
> be sold back to its issuer for USDC. USDC can be spent anywhere. Liquidity therefore favours USDC
> by construction, and this run does not isolate it from preference.

## 2. Scripted-policy mode (step b)

**Seam.** The loop calls `agent.adapter(modelString, prompt, params)`. A scripted seat is an adapter
that returns the next tool call from a fixed script and never calls a model. The loop, the tools,
the board, the wake gates, the validator and the chain are untouched, so what is exercised is the
real thing. Nothing in any prompt changes and no instruction to use either asset exists anywhere an
agent can read it: the scripts live in one module (`cli/scripted-policy.ts`) that only the flag
imports, and a test asserts that every seat's prompt is byte-identical with and without it.

**Flags.** `--scripted` requires `--debug`, adds its own disqualification reason, skips the provider
pre-flight (no model is called), and costs gas only. `--window-seconds N` (default 2400, which stays
the production value) shortens windows for it; `WINDOW_SECONDS` is one exported constant used in
four places, so this is small.

**Two venues, one script.**
1. *Local devnet in vitest, with warped time.* Every path, in seconds, free, and a regression test
   forever — the §4.6ai test that cannot share the code's assumptions because it reads the chain.
2. *Base Sepolia, live,* with short windows (a few minutes each; the run is then tens of minutes, not
   two hours). Needed because stale reads and real latency only exist live.

**The walk.** (R = a claim; every number below is read from the real print at run time.)

| window | seat | script | what it exercises |
| --- | --- | --- | --- |
| 1 (ISSUER-B) | ORCHESTRATOR | quote WORKER-CODE for 10 SIU; `pay_with_claim` | mint-and-forward; parity sizing; mint cost; B-backed |
| 1 | WORKER-CODE | quote WORKER-EXTRACT for 4 SIU; keyed `transfer_claim` of R1 | **onward payment from a held balance**; heldReceived > 0 |
| 1 | WORKER-CODE | present R1's remainder to B | redemption for work |
| 1 | ISSUER-B | author the pinned gate, `serve_redemption` | served; claim flows; received > redeemed |
| 1 | WORKER-EXTRACT | issue the quote; use the 4 SIU share of R1; leave it unpresented | testing bought with a claim; **Expired** at close |
| 2 (ISSUER-A) | ORCHESTRATOR | `pay_with_claim` to WORKER-CODE | routed to A after the drain |
| 2 | WORKER-CODE | present R2 to A; buy testing in USDC | **a claim presented to A**; the USDC route as control |
| 2 | ISSUER-A | no action | cannot serve |
| 3 | all | USDC control; WORKER-CODE settles R2 after window 2 closed | **Defaulted**, bond pays; outcome copy |

Then the **decision rule** is computed over the events with the block report's own code, and must
mark WORKER-CODE eligible and onward and ORCHESTRATOR never eligible.

**Pass criteria, all checked against the chain, not the report:** the claim sizes equal ceil(price /
print); the mint costs equal the payer's real USDC movement; the Defaulted payout equals the claim's
value at the print; the Expired claim paid nobody; the issuer-side headroom ends whole; every
`capacityEvent` carries its `settlesRequestId`, mint cost and (for settlements) `settlementOutcome`.

**What it will probably find.** Onward payment followed by redeeming the *remainder* has never run:
the redemption tracker records the minted quantity, and an issuer asked to serve that quantity from a
holder who now holds less will revert. That is exactly the kind of defect "fix whatever it finds" is
for, and the reason the walk includes it.

## 3. Decided fixes (can land with step b)

- **Plain contract errors.** A table of every custom error in the four contracts, each with one
  plain, true sentence ("you have already reserved this quote"), applied where a tool error reaches an
  agent. A test parses the four Solidity sources and fails if any declared error lacks an entry, so a
  new error cannot ship unexplained.
- **Schedule sentence.** The schedule lists every purchase the run makes, WORKER-CODE's testing
  purchase included, so "the whole schedule" is true. Facts only.
- **`max_tokens` with no text.** Retry the turn once, log both attempts; if it recurs the run is
  marked infrastructure-failed and excluded (the same abort path as a failed drain), never failed as
  `no_gate`. Cost: a second attempt of a turn that can cost $0.30 to $0.44.
- **Headroom sentence.** Already out of `pay_with_claim`; capacity facts stay in the brief. A test
  pins it.

## 4. The change set (step c)

| item | what | where |
| --- | --- | --- |
| 1 schedule | every purchase, window, job, class, size, opening time; uniform; facts only | `scheduleFacts` |
| 2 treasury facts | identical in every brief; the blocklist extended to directives about holding, keeping, converting or redeeming | briefs, `pack/validate.ts`, tests |
| 3 dollar exit | **dropped (§1); caption confound** | caption |
| 4 worked syntax | `pay_with_claim {requestId, forWindow}` equal to the other routes (§4.6q) | briefs |
| 5 two arms | `--arm V\|H`; same seeds via `--seed`; the arm in manifest, report, caption | runner |
| 6 measurement | per agent per turn: fSIU held vs work scheduled ahead; every disposal by route; forward purchases and whether held when the window opened | loop, report, block report |
| 7 caption | the arm label; the liquidity confound | `BLOCK_CAPTION` |

## 5. Where the instruction and the code or an earlier commitment do not line up

1. **The treasury fact "any fSIU not spent or redeemed by its window's close expires" is imprecise.**
   A claim that was *presented* and not served does not expire: it is settled against the issuer's
   bond and pays the holder. The asset text already says so correctly. Proposed: the treasury fact
   reuses the asset text's own sentences, so the two cannot disagree.
2. **"Profit is your USDC at the end minus your USDC at the start" interacts with two things.** A
   claim *received* as payment is worth no USDC to its holder until redeemed, and redeemed for work
   it never is — so a profit-reading agent sees paying onward from a held balance as costless in
   dollars, and sellers see no escrow fee on the claim route. Both are real consequences of the
   instrument, and the second is the seller-side asymmetry already recorded (§4.6az), now bearing on
   an incentive the brief states. It is your design and I will build it; it should be a conscious
   one.
3. **Arm H: what is removed?** "No schedule shown" leaves a choice. The brief today also says "THIS
   RUN HAS 3 WINDOWS" and that balances, claims and capacity carry across. Assumed: arm H keeps the
   window count and the carry-over fact and removes only the per-window list (job, size, opening
   time) — the smallest difference that is still the treatment. Say if the count should go too.
4. **"Same seeds"** needs a `--seed` flag; today the run seed is random. Added in step c.
5. **The sequence omits the full-cost confirmation run** that the runbook requires before any freeze
   (a cheap-substituted run never calls xAI or Google). Proposed: step e is one *full-cost* model
   run per arm, which also validates the roster. Estimated at the measured $1.77 to $3.07 each.
6. **Scripted runs are real-time on a real chain.** Even with short windows a live run is tens of
   minutes. The devnet venue is the fast one.

## 6. Sequence and cost

a. artefacts committed — done. b. scripted run (devnet, then live), fix what it finds, plus §3.
c. the change set. d. scripted run again over the final briefs. e. one model run per arm, full-cost.
f. five per arm. Anything changed after step e resets the freeze. The scripted runs cost gas only;
e is two runs; f is ten, at the measured per-run range — an estimate until e is measured.
