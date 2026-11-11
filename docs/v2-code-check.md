# Read-only code check of the v2 counted run

Diagnosis only. No edits, runs, or commits were made; no model API was called. Scope: the v2 counted
run log `data/private/blockworks/cr/economy/economy-counted-model-stand-in-2026-11-08T11-13-21-246Z/`
(`log.jsonl`, `report.md`, `scoring.md`), config `data/lab/cr/economy-params.v2.json` (frozen D138),
and the engine source in `packages/cr-lab/src/economy/` and `packages/cr-lab/src/studio/`.

All line numbers are current against the `part5` branch at the time of this check.

---

## 1. Board shows paid quotes as live

**Answer:** Confirmed. A quote's board entry drops only at `status === "lapsed"`; `"delivered"` and
`"failed"` stay on the board forever, and the escrow fields that back the "in escrow" wording are set
once at accept time and never cleared on settlement — so a demand agent's own board, long after its
quote is paid, still reads "N USDC in escrow."

**Evidence.**

`board.ts:147-149` (the board's own quote filter):
```ts
quotes: w.quotes.filter(
  (x) => (x.demand === agent || x.researcher === agent) && x.status !== "lapsed",
),
```
Only `"lapsed"` is excluded. `world.ts:109` defines `status: "posted" | "accepted" | "delivered" | "failed" | "lapsed"`,
and `world.ts:957` sets `q.status = passed ? "delivered" : "failed"` on settlement — neither value is
`"lapsed"`, so a settled quote stays in the filtered list indefinitely.

`board.ts:280-294` (the render):
```ts
const escrowed =
  q.agu !== undefined
    ? `, ${show(q.agu)} AGU-lab in escrow`
    : q.usdcEscrowed !== undefined
      ? `, ${show(q.usdcEscrowed)} USDC in escrow`
      : "";
...
lines.push(
  `  - ${q.id}: ${q.researcher} → ${q.demand}, brief on ${q.tasks.join(" + ")} for ${bound}, ${q.status}${escrowed}`,
);
```
`q.usdcEscrowed` is set once at `world.ts:760` (`q.usdcEscrowed = usdcOwed`) and is never reset or
deleted anywhere in `#deliverBrief` (`world.ts:922-980`) after settlement. So the line is
self-contradictory once delivered: it prints the correct status word ("delivered") immediately
followed by a stale "in escrow" clause that is no longer true.

Quote binding: `world.ts:707` (`need: need.id`) — a quote is bound to a specific need id, not matched
by task pair alone; `#acceptQuote` (`world.ts:736-739`) also checks `n.need === q.need`.

**Reconstructed board line for quote-12** (not run — assembled by hand from the deterministic
template above against the logged field values, since `renderBoard` was not executed): quote-12 was
posted by RESEARCH-2 to DEMAND-1 (`log.jsonl` seq 112, priceUnit `usdc`, `priceUsdcMicro: "1500"`),
accepted by DEMAND-1 (seq 120), and delivered-and-paid (seq 198-200, `verdict: "pass"`, `"usdc":"1500"`)
— all inside window 1 (day `2026-11-03`). From that point on, every board DEMAND-1 or RESEARCH-2 saw
for the rest of the run included:
```
  - quote-12: RESEARCH-2 → DEMAND-1, brief on CR-PL + CR-UO for 0.001500 USDC (binding), delivered, 0.001500 USDC in escrow
```
This is **not** the exact window-3-round-0 board transcript (no raw prompt text is ever logged — see
"what can't be answered" below) but is the exact, deterministic quote-12 line that board text would
have carried at any round from window 1 round 2 onward, window 3 included.

**What can't be answered from stored records.** The task asks for "the exact board text one demand
agent saw" in full. `renderBoard` is called fresh every turn and its output is fed straight into the
prompt (`runner.ts:187`: `` const prompt = `${opts.instructions?.(...) ?? ""}\n\n${renderBoard(board)}` ``)
but the prompt itself is never written to the log — only structured fields are. Regenerating the
*complete* board (not just the one quote-12 line) would require executing `boardFor`/`renderBoard`
against the reconstructed world state, which this check's own rules forbid. **Unresolved by design**
of this check, not by a gap in the evidence for the one line above.

---

## 2. Why accepts were refused

**Answer:** DEMAND-3/quote-40 — confirmed, the per-window spend cap. DEMAND-2/quote-93 — likely the
same cap, but the log cannot prove it names quote-93 specifically (see caveat).

**Evidence.** `world.ts:733-792` (`#acceptQuote`): the only two refusal branches with user-visible text
are `` `no posted quote ${id} for you` `` (`world.ts:736-737`, fires when the quote doesn't exist, isn't
the caller's, or is no longer `"posted"` — i.e. identical wording whether it never existed or was
already resolved) and `` `mandate: spending limit of ${show(m.spendLimitAguPerWindow)} AGU-lab this window` ``
(`world.ts:744-748`) — note this second branch **never interpolates the quote id**, which matters below.

DEMAND-3, quote-40 (posted seq 316, window 2 = day `2026-11-04`, 0.004 USDC): every `accept_quote` turn
from DEMAND-3 in that window was refused with the identical text:
```
seq 336  round 1  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 351  round 2  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 379  round 3  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 414  round 4  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 430  round 5  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 455  round 6  "mandate: spending limit of 2.000000 AGU-lab this window"
seq 479  round 7  "mandate: spending limit of 2.000000 AGU-lab this window"
```
No escrow-open for quote-40 appears anywhere in the log — it never became `"accepted"`. **Confirmed.**

DEMAND-2, quote-93 (posted seq 744, window 4 = day `2026-11-06`, 0.003 USDC): DEMAND-2's accept_quote
turns in that window show the SAME "mandate: spending limit..." text starting at seq 762 (round 1,
immediately after quote-93 posted) and repeating through round 7. But because the mandate-refusal
branch never names the quote id, the log cannot distinguish "refused while trying quote-93" from
"refused while trying some other posted-but-unaccepted quote to DEMAND-2 that same window." **Likely,
not confirmed**: the timing (first mandate refusal is the very next round after quote-93 posts, and no
escrow-open for quote-93 appears anywhere) is consistent with quote-93 being the one hitting the cap,
but the log's own refusal text is a genuine information gap here, independent of the critique's
question — worth noting as its own small finding.

**How the cap converts a USDC price to AGU-lab-equivalent** (`world.ts:741`):
```ts
const aguEquivalent = this.aguFor(q.priceMicroSiu);
```
This always uses `q.priceMicroSiu` — for a USDC-bound quote, that value was fixed once, at
`#postQuote` time (`world.ts:700-701`, via `microSiuForUsdcCeil(priceUsdcMicro, rate)` at the
commodity print rate *then in effect*) and is never re-derived at acceptance (the rate-locking rule,
`world.ts:696`). `aguFor` (`world.ts:288-292`) then converts that locked SIU figure through the
**reserve NAV read live at the moment of the accept attempt** (`this.chain.nav()`), not the print
rate: `ceilDiv(price * den, num)`. So two different rates are combined — the quote's own price is
locked to the print rate at post time, but the cap check re-floats it against whatever the AGU-lab
NAV is *right now*. This is a real design subtlety, not obviously a bug — flagged under "design
choices" below since nothing in the comments states it's deliberate, but nothing suggests it's wrong
either.

---

## 3. Hedger late counter

**Answer:** The window-by-window arithmetic is internally consistent with its own definition, but that
definition never banks a surplus from early over-delivery against later windows' obligations — so an
agent that delivers far ahead of schedule can still accumulate a "late" count later, exactly as the
critique describes. This is a real discrepancy against the build plan's own stated design (see below),
not merely an artifact of reading the numbers wrong.

**Evidence — the on-time/late computation** (`world.ts:1517-1543`, `closeWindow`'s own end-of-window
step):
```ts
if (this.totalWindows !== undefined && this.params.hedger.latePenaltyUsdcPerBrief !== undefined) {
  const hedger = this.params.agents.hedger;
  const owedByNow = Math.ceil((this.params.hedger.briefsSold * k) / this.totalWindows);
  const owedBefore = k > 1 ? Math.ceil((this.params.hedger.briefsSold * (k - 1)) / this.totalWindows) : 0;
  const dueThisWindow = owedByNow - owedBefore;
  const deliveredThisWindow = this.forwardDelivered - this.#hedgerDeliveredAtLastClose;
  const onTimeThisWindow = Math.min(deliveredThisWindow, dueThisWindow);
  const lateThisWindow = Math.max(dueThisWindow - deliveredThisWindow, 0);
  ...
  this.#hedgerDeliveredAtLastClose = this.forwardDelivered;
```
`onTimeThisWindow` caps credit at `dueThisWindow` — any delivery beyond what's due *this window* is
simply discarded (counted in neither `onTime` nor `late`), and `#hedgerDeliveredAtLastClose` then
absorbs that entire delta, so the surplus is never available to offset a shortfall in a *later*
window. `dueThisWindow` itself comes only from the fixed proportional schedule
(`ceil(briefsSold*k/totalWindows)`), independent of how much has actually been delivered.

**Rendering** (`step-page.ts:61`):
```ts
return `objective update: ${str(e, "onTimeThisWindow") ?? "0"} on time, ${str(e, "lateThisWindow") ?? "0"} late (owed by now: ${str(e, "owedByNow") ?? "?"}, delivered: ${str(e, "deliveredByNow") ?? "?"})`;
```
This is the exact source of the quoted "0 on time, 1 late (owed by now: 6, delivered: 10)" phrasing,
reading the `"objective"` kind log entry (`world.ts:1538`).

**Design-intent discrepancy.** The build plan for this item (item 8, HEDGER paragraph, the plan
document this build was executed from) states: *"at `closeWindow`, compare cumulative delivered vs.
owed"* — a cumulative comparison would naturally bank any early surplus, since once lifetime delivered
exceeds lifetime owed, "late" would never fire again regardless of per-window timing. The **implemented**
code instead compares only the current window's *delta* of delivered against that window's *delta* of
due (`deliveredThisWindow`/`dueThisWindow` above), which is not equivalent when delivery is front-loaded.
This looks like a real deviation from the stated design, not a deliberate redefinition — flagged as a
likely bug below.

**`deliver_forward`'s own refusal** (`world.ts:1046-1049`):
```ts
if (this.forwardDelivered >= this.params.hedger.briefsSold)
  return { ok: false, note: "every forward brief is delivered" };
```
This is a **lifetime** cap (`briefsSold`, 10 in `economy-params.v2.json`), not a per-window one — so
the hedger is free to deliver far ahead of the proportional schedule (which the log confirms: 10 of 10
delivered well before window 7), and is refused only once the lifetime total is exhausted. This
confirms the critique's "from window 4 on, its deliveries were refused" literally: that refusal is
`"every forward brief is delivered"` firing on the lifetime cap, not a per-window throttle.

**Is the late count correct by the code's own definition?** Yes, arithmetically — `onTimeThisWindow`/
`lateThisWindow` follow exactly from the formulas above, no off-by-one found. The problem is the
definition itself not banking surplus, which the plan's own prose describes doing.

---

## 4. Can a demand agent use a front claim to meet a need?

**Answer: No.** Confirmed, not unresolved. Nothing a demand agent holds or receives — including a
front claim it bought and presented itself — can mark its own need `"met"` anywhere in the code.

**Evidence.** `present_claim` → `#present` (`world.ts:608-650`): produces a `TaskOutput` via
`#addOutput` (same mechanism `#commission` uses for a research agent) and logs `claim-present`/`gate`/
`claim-serve` entries. It never touches `this.needs` at all — no line in `#present` reads or writes
any `Need`.

The only place a need is ever marked met is `world.ts:965`, inside `#deliverBrief`:
```ts
if (passed && need !== undefined) need.status = "met";
```
and `#deliverBrief` (`world.ts:922-923`) starts with:
```ts
if (role !== "research") return { ok: false, note: "only research agents deliver briefs" };
```
A demand agent's role is `"demand"`, never `"research"`, so a demand agent's own call to
`deliver_brief` is refused unconditionally — it cannot present its own output against its own need.
Nor can a research agent complete the loop on a demand agent's behalf: `#deliverBrief`'s output lookup
(`world.ts:934-947`) filters by `x.owner === agent` (the caller, i.e. the research agent), so an output
owned by a demand agent (from its own `present_claim`) is invisible to any research agent's
`deliver_brief` call too — ownership of a `TaskOutput` never transfers.

So `order_front_claim`/`buy_claims`/`present_claim` give a demand agent a passing *output*, but there
is no code path from "a demand agent holds a passing output" to "a demand agent's need is met." This
makes kill criterion 4 ("no demand agent ever bought ahead for a visible need") structurally
unfalsifiable for the front-claim route specifically — a demand agent could not have made it hold
differently by buying claims, however motivated.

---

## 5. The 14 unreadable turns

**Answer:** They are in the raw run log (not a presentation artifact), they reconcile cleanly with
"336/336 turns parsed" once the code's own two separate failure categories are understood, and the
"duplicate" rows are a deliberate, documented instrumentation feature, not retries or double logging.

**Evidence — the 14 entries are real, raw log lines**, all `window: "2026-11-09"` (window 7),
`"parsed": false`, `"serviceFailure": "model call failed (status 400)"`:
```
seq 1444 round 5 DEMAND-1     seq 1445 round 5 RESEARCH-2
seq 1446 round 6 DEMAND-3     seq 1447 round 6 DEMAND-2
seq 1448 round 6 RESEARCH-1   seq 1449 round 6 DEMAND-1
seq 1450 round 6 RESEARCH-2   seq 1451 round 6 HEDGER
seq 1452 round 7 RESEARCH-2   seq 1453 round 7 RESEARCH-1
seq 1454 round 7 DEMAND-3     seq 1455 round 7 DEMAND-1
seq 1456 round 7 HEDGER       seq 1457 round 7 DEMAND-2
```
Every one of rounds 6 and 7 (the last two rounds of the whole run) is **100% service failure, all six
agents** — meaning no real agent action happened in the final two rounds of window 7 at all.

**Reconciling "336/336 turns parsed" with "14 lost to service failures".** These are two different
counters, confirmed in `runner.ts:130-134` (`WindowStats`) and the per-turn loop (`runner.ts:180-220`):
```ts
for (const a of order) {
  ...
  s.turns++;
  ...
  if (rep.serviceFailure !== undefined) {
    s.serviceFailures++;
    w.log.write(..., { seat: a.seat, parsed: false, serviceFailure: rep.serviceFailure });
    ...
    continue;
  }
  const parsed = parseToolCall(rep.toolCall, a.role, board);
  if (!parsed.ok) {
    s.parseFailures++;
    ...
  }
```
`s.turns++` fires once per (agent, round) slot unconditionally — exactly 48 per window (6 agents × 8
rounds), which is where report.md's fixed "48 turns" per window comes from (confirmed: window 7's 34
real successes + 14 service failures = 48 exactly). A service failure increments `serviceFailures`,
**never** `parseFailures`. The headline check (`report.ts:51-54`):
```ts
{ name: "turns parsed ≥ 90%", ok: turns > 0 && (turns - failures) * 10 >= turns * 9, detail: `${turns - failures} of ${turns}` }
```
reads `failures = stats.reduce((n, s) => n + s.parseFailures, 0)` (`report.ts:28`) — **not**
`serviceFailures`. So "336 of 336 turns parsed" is mathematically correct under its own definition (zero
JSON/tool-call parse failures occurred anywhere in the run) but is a different claim from "336
attempted turns succeeded" — 14 of the 336 counted "turns" never reached the model at all. The
per-window table's separate "14 lost to service failures" line is accurate and is not in tension with
the headline once the two metrics are read as measuring different things — see "Bugs vs design
choices" for whether this presentation is a problem.

**Note:** the stop-rule that would otherwise halt a misbehaving run (`runner.ts:266-267`,
`` if (s.turns >= 20 && s.parseFailures * 5 > s.turns) throw new StopRule(...) ``) also only watches
`parseFailures`, never `serviceFailures` — so a window with 100% service failure in its last two
rounds (as happened here) triggers no stop-rule at all.

**"Duplicate" turn rows are not duplicates.** `seededOrder`/the per-round loop logs exactly one
*mirror* entry (`"mirror": true, "executed": false`) immediately before the real executed turn, for
the SIU-first-vs-dollars-first comparability sample (`report.md`'s own "Mirrored sample (SIU first
versus dollars first; the mirror is never executed)" section; `WindowStats.mirrors`,
`runner.ts:136-142`). Confirmed directly for all four pairs flagged:
```
seq 1361 RESEARCH-2 r1  {"mirror":true,"executed":false,...,"tool":"message"}
seq 1362 RESEARCH-2 r1  {"parsed":true,"tool":"message","ok":true,"note":"message sent to all"}
seq 1371 HEDGER      r2  {"mirror":true,"executed":false,...,"tool":"deliver_forward"}
seq 1372 HEDGER      r2  {"parsed":true,"tool":"deliver_forward","ok":false,"note":"every forward brief is delivered"}
seq 1408 RESEARCH-2 r3  {"mirror":true,"executed":false,...,"tool":"buy_data"}
seq 1410 RESEARCH-2 r3  {"parsed":true,"tool":"buy_data","ok":true,"note":"bought today's lending data for 0.001000 USDC"}
seq 1414 RESEARCH-2 r4  {"mirror":true,"executed":false,...,"tool":"commission_task"}
seq 1419 RESEARCH-2 r4  {"parsed":true,"tool":"commission_task","ok":true,"note":"..."}
```
Each pair is one mirror sample + the one real turn it mirrors — deliberate, not an error.

---

## 6. Scorer on empty samples and currency

### (a) Kill criterion 1: is "0.0%" really 0 of 0?

**Answer: No — it is 0 of 6, not 0 of 0.** The scorer does correctly return `null`/"n/a" for a true
empty sample; the printed "0.0%" means a real, non-empty but misleadingly-composed sample (see 6b).

**Evidence.** `scoring.ts:317-326` (`scoreConversionToUsdc`):
```ts
const receipts = modelAgentReceipts(log, params, exitClassBySeqOf(log, tags));
const converted = receipts.filter((r) => r.convertedToUsdc).length;
const share = receipts.length === 0 ? null : converted / receipts.length;
return { converted, opportunities: receipts.length, share, fails: share !== null && share >= 0.9 };
```
and the formatter, `scoring.ts:552`: `` const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`); ``
— `pct(null)` prints `"n/a"`, not `"0.0%"`. Since `scoring.md` prints `"0.0%"` for kill criterion 1,
`receipts.length` was **not** 0; it was 6, with `converted === 0`. The separate "n/a (no sample)" seen
elsewhere in `scoring.md` belongs to a *different* measure (`scoreThesis`'s exit-based thesis check,
which counts `kind: "exit"` log entries — zero of those exist in this run, a genuinely empty sample).
The two "n/a-shaped" results are easy to conflate but come from different functions over different facts.

### (b) Circulation "6 of 6" and the kill-criteria conversion/hops measures: all USDC, none AGU-lab

**Answer: Confirmed**, and this is the central, highest-confidence finding of this check. All three
measures that sound like they're about AGU-lab — kill criterion 1 (conversion), kill criterion 2
(median hops), and the separate circulation score — are computed over the exact same 6-row sample,
and every one of those 6 rows is a USDC payment.

**Evidence.** `modelAgentReceipts` (`scoring.ts:256-284`), whose own doc comment (`scoring.ts:249-250`)
says *"Every **AGU-lab** receipt (an escrow paid to a model agent...)"* — but the implementation never
filters by asset/currency:
```ts
const agents = modelAgentIds(params);
const opens = log.filter((e) => e.kind === "escrow-open");
const settles = log.filter((e) => e.kind === "escrow-settle" && (asBigInt(e.paid) ?? 0n) > 0n);
const openByEscrow = new Map(opens.map((o) => [o.escrow as string, o]));
...
for (const s of settles) {
  const open = openByEscrow.get(s.escrow as string);
  if (open === undefined) continue;
  const seller = open.to as string;
  if (!agents.has(seller)) continue;
  ...
}
```
There is no check anywhere in this function for `"agu" in open` vs `"usdc" in open`. Reconstructing
every settled escrow in the run whose recipient (`open.to`) is one of the six model-agent ids
(`modelAgentIds`, `scoring.ts:61-62`: the two research agents, three demand agents, and the hedger)
gives exactly 6 rows, and every one is USDC:
```
seq 199  escrow-13  RESEARCH-2  usdc  1500  quote-12
seq 221  escrow-15  RESEARCH-1  usdc  1500  quote-14
seq 435  escrow-48  RESEARCH-1  usdc  2200  quote-41
seq 653  escrow-71  RESEARCH-2  usdc   280  quote-68
seq 856  escrow-96  RESEARCH-1  usdc  2200  quote-95
seq1016  escrow-113 RESEARCH-1  usdc   700  quote-112
```
(Six rows, six research-agent brief payments, all in USDC.) Zero model agents received an AGU-lab-
denominated escrow receipt anywhere in the run. `scoreCirculation` (`scoring.ts:294-304`) calls the
same `modelAgentReceipts` with no currency filter either, so its "6 of 6 receipts spent onward
(100.0%) — HOLDS" and kill criterion 2's "median hops stays at one: 2 (6 receipts)" are the same
USDC-only sample relabeled as if it were about AGU-lab. This also means kill criterion 1's "0.0%" is
not "agents received AGU-lab and chose not to convert it" (a real revealed-preference reading) but
"of 6 USDC receipts, 0 were classified as 'converted to USDC'" — a near-tautology, since a USDC
receipt was never something-else to convert. The honest reading for all three measures, given this
run, is "no AGU-lab-denominated sample exists," i.e. n/a — exactly the critique's correction.

**Also affects `report.ts`'s own dev-window verdict**, which imports the same unfiltered accounting
(`report.ts:48`, `hops = onwardSpends(log)`): "PASS AGU-lab circulated at least two hops: 6 onward
spends of AGU-lab received through an escrow" in `report.md`'s Verdict section is the identical
USDC-only sample, mislabeled in the same way there too.

### (c) Lapsed escrows: "0 paid, 0 refunded" despite a real refund

**Answer: Confirmed bug**, and yes — one score reads this exact line.

**Evidence — the log call that produces the text.** `world.ts:1456-1465` (inside `closeWindow`'s
lapse-cleanup):
```ts
for (const q of this.quotes) {
  if (q.status === "accepted" && q.escrow !== undefined) {
    this.chain.escrowExpire(q.escrow);
    q.status = "lapsed";
    this.#log(GATE_RUNNER, "escrow-settle", {
      escrow: q.escrow,
      expired: true,
      refunded: q.agu,
    });
  } else if (q.status === "posted") q.status = "lapsed";
}
```
This always reads `q.agu` for the refunded amount, regardless of `q.priceUnit` — `q.agu` is only ever
set for an SIU/AGU-denominated quote (`world.ts:779`); for a USDC-denominated quote it stays
`undefined`, and no `paid` field is written at all (unlike every other `escrow-settle` log call in the
file, e.g. `world.ts:904` and `world.ts:972`, which always include both `paid` and `refunded`). The
chain-level refund is unaffected and correct — `escrowExpire` (`memory-chain.ts:501-507`) always moves
the escrow's full `maxAmount` back to the buyer regardless of asset — this is purely a logging gap for
USDC-priced lapsed quotes (the majority of real quotes in this run).

**The rendering that produces "0 paid, 0 refunded"**: `step-page.ts:51`:
```ts
return `escrow settled: ${str(e, "paid") ?? "0"} paid, ${str(e, "refunded") ?? "0"} refunded`;
```
With both fields absent/undefined for a USDC-priced expiry, this renders exactly `"escrow settled: 0
paid, 0 refunded"`, even though real USDC moved back to the demand agent on-chain.

**Does any score read this line? Yes.** `report.ts:32-38` (the dev-window "failed and refunded"
criterion):
```ts
const refunds = log.filter(
  (e) =>
    e.kind === "escrow-settle" &&
    e.brief === undefined &&
    typeof e.refunded === "bigint" &&
    (e.refunded as bigint) > 0n,
).length;
```
`typeof e.refunded === "bigint"` is `false` for these entries (the field is `undefined` for a
USDC-priced lapse), so **every USDC-denominated lapsed-quote refund is silently excluded from this
count.** In this particular run the check still shows `"PASS ... 0 briefs failed, 2 refunds"` because
2 *failed-task* refunds (a different code path, `world.ts:904`/`972`, which always logs a real bigint)
happened to exist — so the bug did not flip this run's verdict, but it would undercount or zero out
this criterion in a run whose only refunds were lapsed-quote expiries.

---

## 7. Starting balances and studio source

### (a) Genesis balances, all seven agents (USDC and AGU-lab, in decimal units)

From `economy-params.v2.json` and the log's genesis entries (`log.jsonl` seq 1-16):

| Agent | USDC (config mint) | AGU-lab at genesis | Source |
|---|---|---|---|
| RESEARCH-1 | 0.05 | 0 | `researchUsdc: "50000"` (config), `world.ts:1093` |
| RESEARCH-2 | 0.05 | 0 | same |
| DEMAND-1 | 0.10 | 0 | `mandates.DEMAND-1.usdc: "100000"`, `world.ts:1094` |
| DEMAND-2 | 0.10 | 0 | same |
| DEMAND-3 | 0.10 | 0 | same |
| HEDGER | 0.05 (after conversion) | 3.760779 | see below |
| PARTICIPANT | 2.0 | 0 (fills from issuer lot creation) | `participant.usdc: "2000000"`, `world.ts:1087` |

Only the hedger's genesis wallet is split (`world.ts:1096-1115`): the full mint (`hedger.usdc:
"100000"` = 0.10 USDC) is minted, then half (0.05 USDC) is spent buying AGU-lab from the participant
at the then-live rate. The log confirms the exact fill:
```
seq 16  {"actor":"participant","kind":"participant-sell","to":"HEDGER","agu":"3760779","usdc":"50000","asked":"3760779","genesis":true}
```
Final hedger balance: 0.10 − 0.05 = **0.05 USDC**, **3.760779 AGU-lab** (3760779 / 1e6) — matching the
critique's "about 3.76 AGU-lab and about 0.05 USDC" exactly. No other agent (research or demand) gets
any genesis AGU-lab at all; only the hedger's wallet is split this way.

### (b) Which params file does `studio/agents.html` read?

**Answer: v1 (`economy-params.json`), confirmed — by two independent, compounding causes, not one.**

Cause 1 — the generator's own default. `cli/studio.ts:10,28`:
```ts
import { loadParams, PARAMS_PATH } from "../economy/params.js";
...
const params = loadParams(arg("params", PARAMS_PATH));
```
`PARAMS_PATH` (`params.ts:13`): `` export const PARAMS_PATH = join(CR_PUBLIC_DIR, "economy-params.json"); ``
— the v1 file. Unless the page is regenerated with `--params data/lab/cr/economy-params.v2.json`
explicitly, it reads v1. Confirmed by the configs themselves: v1's `counted.seats` is
`["claude-sonnet-5", "gpt-5.1"]` and v2's is `["claude-sonnet-5"]` only (`economy-params.json` /
`economy-params.v2.json`, both `.counted.seats`) — the committed `agents.html` shows the alternating
v1 schedule, so it was last generated without the `--params` override.

Cause 2 — even pointed at v2, the hedger's balance would still read wrong. `roster.ts:120-128`
(`buildRoster`'s hedger entry):
```ts
id: params.agents.hedger,
role: "hedger",
startingUsdc: show(params.hedger.usdc),
...
```
This echoes the **raw config field** (`params.hedger.usdc`, 0.10 in both v1 and v2 — the two files
have the identical genesis number) and sets no AGU-lab starting balance for the hedger at all.
`buildRoster` never calls `World.genesis()` or replicates its half-to-AGU-lab conversion
(`world.ts:1096-1115`) — it is a static echo of the committed numbers, not a simulation. So pointing
`cli/studio.ts` at v2 would still show "0.10 USDC, 0 AGU-lab" for the hedger; the displayed balance
would remain wrong regardless of which params file is loaded, because the derivation genuinely happens
only at `genesis()` runtime and `roster.ts` has no equivalent logic.

`roster.ts` also lists each agent's tools via the older `TOOLS_BY_ROLE` plain-name export rather than
the newer `toolDefsForRole` (full JSON-Schema tool definitions used by the real engine, `parse.ts`'s
`toolDefsForRole`) — consistent with the parent plan's own research note that this still needs
updating.

### (c) Role instructions and the "tight"/"budget"/"2 SIU" wording

**Full static instructions** (`model-agent.ts:108-130`, `COMMON` + role text + the trailing format
line): the fixed text given to every agent every turn is the `COMMON` array (market mechanics, how
payment/escrow/claims/redemption work, "your board shows a running result... computed in both
currencies"), one role-specific paragraph (`ROLE.demand`/`ROLE.research`/`ROLE.hedger`), and a closing
line about tool-call format. The word **"budget" appears exactly once**, neutrally: *"Your board shows
a running result for your role -- profit, **budget** headroom, or delivery bonus and penalty..."*
(`model-agent.ts:115`). The word **"tight" appears zero times** in the static instructions, and
**no fixed text anywhere states a brief's size in SIU** (a brief's real cost is always shown per-task
via `issuerPrices` on the board, e.g. 0.057762 / 0.300848 SIU for individual tasks — never a rounded
"2 SIU" figure).

Searching the full log's `message`/`reasoning` text instead (not the instructions) finds **"tight" 74
times** and multiple instances of agents stating "2 SIU" themselves, e.g.:
```
"...This is a good price versus the print cost of 2 SIU at $0.0014 = $0.0028..."
"...only slightly above the print-implied cost (~0.0028 USDC for 2 SIU at 0.0014/SIU)..."
```
The "2" here traces to the mandate's own `spendLimitAguPerWindow: "2000000"` (= 2.0 AGU-lab,
`economy-params.v2.json`) — at the reserve NAV shown as ≈1.0 SIU per AGU-lab early in the run, "2
AGU-lab spend cap" and "2 SIU" are numerically close, and the demand agents' own reasoning
conflates "my per-window spending cap" with "this brief's value," even though the board shows each
task's real (much smaller) SIU cost directly. **This is model-generated reasoning, not something the
system instructions or board text asserts** — confirmed by the instructions search above returning
zero hits for both "tight" and "2 SIU."

---

## Bugs vs design choices

**Confirmed bugs (code defects, not stated as intentional anywhere):**

1. Board never distinguishes a settled quote from a live one beyond the one-word status; the escrow
   fields (`agu`/`usdcEscrowed`) are never cleared on settlement, producing a self-contradictory
   "delivered ... in escrow" line (item 1).
2. The hedger's on-time/late tracking compares per-window deltas, not cumulative delivered-vs-owed as
   the build plan for this item itself specifies — early over-delivery is discarded rather than banked
   against later obligations (item 3).
3. `modelAgentReceipts` (and everything built on it: kill criterion 1, kill criterion 2, circulation,
   and the dev-window "AGU-lab circulated" check) never filters by currency, despite its own doc
   comment claiming "every AGU-lab receipt" — in this run it silently measured 6 USDC payments instead
   (item 6a/6b). This is the single highest-impact finding: two of the four fired kill criteria and the
   circulation/hops measures all rest on a sample that was never AGU-lab to begin with.
4. The lapsed-quote-expiry log entry always reads `refunded: q.agu`, which is `undefined` for a
   USDC-priced quote (the common case) and omits `paid` entirely — producing "0 paid, 0 refunded" text
   for a refund that really happened on-chain, and causing `report.ts`'s own "failed and was refunded"
   dev-window criterion to silently miss these refunds (item 6c).
5. The run's stop-rule only watches `parseFailures`, never `serviceFailures` — a window that goes 100%
   service-failure for its last two rounds (as window 7 did) triggers no safety stop (item 5, noted).
6. `agents.html` shows stale/wrong figures for two independent reasons that compound: it was generated
   without `--params` (so it reads v1, item 7b cause 1) *and*, separately, `roster.ts` never replicates
   `genesis()`'s hedger AGU-lab-split derivation even when pointed at the right file (item 7b cause 2).

**Structural/design gaps (not bugs exactly, but not obviously intended either):**

7. No demand-agent tool can ever mark its own need "met" — `present_claim`/`buy_claims`/
   `order_front_claim` produce outputs that are structurally invisible to `deliver_brief`'s gate, which
   is hard-restricted to the research role and to outputs the caller itself owns (item 4). Since item 9
   deliberately gives demand agents forward *visibility* into their own future needs, but nothing lets
   them act on that visibility alone, this looks like an unintentional gap rather than a deliberate
   choice — but no comment anywhere states the intended behavior either way, so it is reported here
   rather than asserted as a bug.

**Deliberate, documented design choices (not bugs):**

8. "Turns parsed ≥ 90%: 336 of 336" and "14 lost to service failures" are two different, correctly
   computed metrics (parse-rate vs. call-availability) that can legitimately both be true at once; the
   presentation (one bare headline number, with no cross-reference to the other) is what makes them
   look contradictory, not the arithmetic (item 5).
9. The "duplicate" turn rows are the pre-registered SIU-first/dollars-first mirror-sample mechanism,
   explicitly marked `mirror: true, executed: false` and documented in `report.md`'s own "Mirrored
   sample" section (item 5).
10. The spend cap combining a quote's print-rate-locked SIU price with the live reserve NAV at accept
    time (item 2) is unusual but not contradicted by any stated rule; flagged for awareness, not as a
    defect.
11. The "2 SIU" / "tight budget" language is model-generated reasoning over real board numbers, not a
    leading or incorrect system prompt (item 7c).
