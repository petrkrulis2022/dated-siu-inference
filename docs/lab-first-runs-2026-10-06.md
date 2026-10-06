# The currency lab — first two model runs, in detail

*Written 2026-10-06 from the run records. Every number below is generated from the reports in `data/lab/runs/`, not retyped. Companion to `docs/marketplace_plan.md` (decisions D25 and D29).*

## 1. What this covers, and where everything is

| | run 1: the pilot | run 2: the rerun |
| --- | --- | --- |
| run id | `lab-2026-10-06T15-41-54-035Z` | `lab-2026-10-06T18-00-30-905Z` |
| instrument version | none stamped (built before the pay guard, D24) | **3** |
| counted in any result | **no**, and the pool refuses it | no: one run proves nothing, but it is countable |
| seed | 1 | 1 (the same schedule) |
| turns taken | 121 | 52 |
| realized cost | $0.692936 inference + $0.000000 graded work | $0.256017 inference + $0.002855 graded work |
| needs met | 0 of 8 | 2 of 8 |
| how it ended | stopped by a spending cap set too low (a harness fault) | by itself: every agent waiting |

**Files** (all under `data/lab/runs/`):

- `lab-2026-10-06T18-00-30-905Z-report.json` — the machine-readable report of the rerun: every sale, payment moment, capacity event, snapshot, operator action, refusal, cost. Committed to the repository. `lab-2026-10-06T15-41-54-035Z-report.json` is the pilot's.
- `lab-2026-10-06T18-00-30-905Z-open.json` — the record the runner writes the moment the endowment exists (token, window close, holders); `swept: true` once the capacity was returned.
- `lab-2026-10-06T18-00-30-905Z/` — the recorder's folder: `messages/<seat>/<turn>.json` (the **full prompt each agent was shown and its raw reply**), `contexts/` (each agent's history as it saw it), `friction/` (what the agents said they could not express), `metrics.json`. **Local only, not committed** (3 to 7 MB a run; ignored by `data/lab/.gitignore`).
- This document. `pnpm run lab-report` pools the committed reports under the approved rule; `node` can read the JSON directly (see §9).

## 2. The economy these runs played

Seed 1: four traders, three rounds, eight needs. Print `2026-10-05-commodity` at 0.001437 USD per SIU (a job is 1 SIU: quote 0.0017 USD; a raw-work unit quote 0.0014 USD). Every trader opened with 2874 USDC minor units and 2000 mSIU of fSIU, equal in value at the print.

| trader | seat | model | delivers | needs (buys from, round) |
| --- | --- | --- | --- | --- |
| TRADER-1 | ORCHESTRATOR | claude-haiku-4-5 | TYPE-4 | TYPE-3 from TRADER-2 (r1); TYPE-2 from TRADER-3 (r2) |
| TRADER-2 | WORKER-CODE | gpt-5.4-mini | TYPE-3 | TYPE-2 from TRADER-3 (r1); TYPE-1 from TRADER-4 (r2) |
| TRADER-3 | WORKER-EXTRACT | claude-haiku-4-5 | TYPE-2 | TYPE-1 from TRADER-4 (r1); TYPE-4 from TRADER-1 (r3) |
| TRADER-4 | ISSUER-A | gpt-5.4-mini | TYPE-1 | TYPE-4 from TRADER-1 (r1); TYPE-3 from TRADER-2 (r2) |

## 3. The four things you asked for, for the rerun

**Did the harness run to the end?** Yes. Abort: none; contamination: none; bookkeeping errors: 0; pool restored: True (32000 → 32000 mSIU); snapshots: opening, round 2 opened, round 3 opened, then the score before the window closed. How each agent stopped: TRADER-4 waiting, TRADER-2 waiting, TRADER-3 waiting, TRADER-1 nothing_to_act_on, ISSUER-B nothing_to_act_on. No spending-cap stop.

**Did any call fail on format?** **No call was malformed.** Counted from the agents' own histories (the report did not yet record refusals when this run was made), **15 calls did not go through**: **9 were refused because the wallet could not cover the payment** (each in the new one-sentence form, *"This payment costs X USDC minor units; the wallet holds Y USDC minor units."*), **3 were `request_quote` calls the lab declined because the trader had no open need for what it asked** (TRADER-2 once, TRADER-4 twice), and **3 were `deliver_job` calls made before buying a unit of raw work** (TRADER-1, TRADER-3, TRADER-4). Every one of them is a well-formed call that a rule of the lab, or the state of the wallet, said no to; none was unparseable, wrongly named or wrongly argued.

**How many opportunities arose?** **1, and it was reused.** An opportunity is a payment made while holding *received* fSIU at least as large as the amount due. TRADER-1 paid for a raw-work unit from a held balance that included 1,184 mSIU it had been paid by TRADER-3. Nothing else in the run met the definition.

**Which routes did each trader use?** The last two columns are payments that went through; the calls column counts every attempt, so a refused call appears there and not in the routes.

| trader | model | turns | calls it attempted (refused ones included) | jobs paid for, by route | raw work paid for, by route | needs met |
| --- | --- | ---: | --- | --- | --- | ---: |
| TRADER-1 | claude-haiku-4-5 | 18 | request_quote ×4, pay_with_usdc ×4, deliver_job ×3, issue_quote ×2, pay_with_new_claim ×2, pay_with_held_claim ×2, settle_escrow ×1 | dollars, dollars | held claim, held claim | 0 |
| TRADER-2 | gpt-5.4-mini | 6 | request_quote ×3, waits ×2, issue_quote ×1 | — | — | 0 |
| TRADER-3 | claude-haiku-4-5 | 11 | request_quote ×3, pay_with_usdc ×3, issue_quote ×2, deliver_job ×1, waits ×1, pay_with_held_claim ×1 | dollars, held claim | — | 1 |
| TRADER-4 | gpt-5.4-mini | 13 | request_quote ×5, pay_with_usdc ×4, waits ×2, issue_quote ×1, deliver_job ×1 | dollars | — | 1 |

## 4. What each trader did, turn by turn

Taken from the recorder's messages and each agent's own history. "Outcome" is what the agent was told. Names are the ones the agent used (the lab's renamed payment tools).

### TRADER-1 — claude-haiku-4-5, delivers TYPE-4

| turn | what it did | outcome | its stated reason |
| ---: | --- | --- | --- |
| 1 | request_quote → TRADER-2 (a job, 0.0017244/SIU) | ok | Initiating Round 1 by requesting TYPE-3 from TRADER-2, which is my first critical need. This starts the chain: I need TYPE-3 to enable TRADER-4 to get TYPE-4 from me, whi |
| 2 | pay_with_usdc(qr-1) | ok | Settle the TYPE-3 quote from TRADER-2 (my round 1 need) with USDC to unblock the delivery chain and enable TRADER-4 to satisfy their TYPE-4 need from me. |
| 3 | issue_quote(qr-4) | ok | TRADER-4 is requesting TYPE-4 (my skill). I must issue this quote to enable Round 1's chain: TRADER-4 delivers TYPE-1 to TRADER-3, who delivers TYPE-2 to TRADER-2, who de |
| 4 | request_quote → TRADER-3 (a job, 0.0017244/SIU) | ok | Requesting TYPE-2 from TRADER-3 to satisfy my round 2 need. This is the only open need I can act on now. |
| 5 | pay_with_usdc(qr-6) | REFUSED: This payment costs 1700 USDC minor units; the wallet holds 1174 USDC minor units. | Settling the TYPE-2 quote from TRADER-3 with USDC to meet my Round 2 need. This is essential to the delivery chain: I need TYPE-2 now to eventually deliver TYPE-4 and com |
| 6 | request_quote → ISSUER-B (raw work, 0.001437/SIU) | ok | I owe 1 TYPE-4 delivery (qr-4) but hold 0 units of raw work. I must buy a unit from ISSUER-B to fulfill this obligation. I have 1174 USDC minor units (1.174 USD), which i |
| 7 | pay_with_new_claim(qr-6) | REFUSED: This payment costs 1701 USDC minor units; the wallet holds 1174 USDC minor units. | I need TYPE-2 from TRADER-3 (Round 2 need). I'm short on USDC (1174 mSIU vs 1700 needed), so I'll mint new fSIU to settle this quote. This gets me the TYPE-2 I need while |
| 8 | pay_with_new_claim(qr-9) | REFUSED: This payment costs 1401 USDC minor units; the wallet holds 1174 USDC minor units. | Pay for raw work unit with new fSIU claim to free up USDC for TYPE-2 purchase; I need raw work to deliver the TYPE-4 job I'm already paid for (qr-4). |
| 9 | deliver_job(qr-4) | REFUSED: deliver_job: you hold no unit of raw work, and delivering uses one. | I have been paid for qr-4 (TYPE-4 job for TRADER-4). I need to acquire raw work first to deliver it, but I'm out of USDC and fSIU. However, I should attempt delivery now  |
| 10 | pay_with_held_claim(qr-9) | ok | I need raw work to deliver qr-4. I hold 2 SIU of fSIU (2000 mSIU). Paying for the raw work unit with my held claim costs 1400 mSIU, leaving me 600 mSIU and able to delive |
| 11 | deliver_job(qr-4) | delivered | I hold 1 unit of raw work from paying qr-9 with a claim. I owe delivery on qr-4 (TYPE-4 for TRADER-4, paid in USDC). Delivering now completes my Round 1 obligation and fr |
| 12 | settle_escrow | ok | Release the escrowed USDC from the TYPE-4 job I delivered to TRADER-4 in Round 1, freeing up capital to pursue my Round 2 need (TYPE-2 from TRADER-3). |
| 13 | pay_with_usdc(qr-6) | ok | I have 2574 USDC minor units after escrow settlement (1174 initial + 1700 from escrow release - 300 spent on raw work unit). The TYPE-2 quote from TRADER-3 costs 1700 USD |
| 14 | issue_quote(qr-11) | ok | TRADER-3 has requested TYPE-4 in Round 3, which is my specialty. I must issue this quote to enable the transaction chain that will let me meet my needs. |
| 15 | request_quote → ISSUER-B (raw work, 0.001437/SIU) | ok | I owe 1 delivery (qr-11 for TRADER-3) but hold 0 units of raw work. I need to acquire raw work from ISSUER-B to fulfill this obligation. Requesting a fresh quote since my |
| 16 | pay_with_usdc(qr-12) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | Pay for raw work unit so I can deliver the TYPE-4 job (qr-11) that TRADER-3 paid for, meeting one of my two needs. |
| 17 | pay_with_held_claim(qr-12) | ok | I need raw work to deliver qr-11 (TYPE-4 for TRADER-3). I hold 2 SIU of fSIU and can pay for this raw work unit with a held claim, avoiding the USDC shortfall. |
| 18 | deliver_job(qr-11) | delivered | I have been paid for qr-11 (TYPE-4 for TRADER-3) and hold 1 unit of raw work. Delivering this job will meet 1 of my 2 needs and generate a 150% credit. This is my only op |

### TRADER-2 — gpt-5.4-mini, delivers TYPE-3

| turn | what it did | outcome | its stated reason |
| ---: | --- | --- | --- |
| 1 | issue_quote(qr-1) | ok | Answer TRADER-1's open request so we can complete the round-1 TYPE-3 chain. |
| 2 | request_quote → TRADER-3 (a job, 0.0017244/SIU) | ok | Buy my round-1 TYPE-2 need from TRADER-3 so I can later deliver the paid TYPE-3 job. |
| 3 | request_quote → TRADER-4 (a job, 0.0017244/SIU) | REFUSED: you have no open need that TRADER-4 can deliver. Your need of TYPE-1 from TRADER-4 opens in round 2. You have no open needs now. | I need TRADER-4’s TYPE-1 delivery to satisfy my round-2 need, so I’m requesting its quote now. |
| 4 | waits |  | Waiting for round 2 so I can buy the TYPE-1 need from TRADER-4 while preserving turns. |
| 5 | request_quote → TRADER-4 (a job, 0.0017244/SIU) | ok | Open the round-2 TYPE-1 quote from TRADER-4 so I can settle my remaining need. |
| 6 | waits |  |  |

### TRADER-3 — claude-haiku-4-5, delivers TYPE-2

| turn | what it did | outcome | its stated reason |
| ---: | --- | --- | --- |
| 1 | request_quote → TRADER-4 (a job, 0.0017244/SIU) | ok | Requesting TYPE-1 from TRADER-4 (round 1), which is my first need and currently open. This initiates the chain: I need TYPE-1 to deliver TYPE-2 to TRADER-2, whose TYPE-3  |
| 2 | pay_with_usdc(qr-2) | ok | I need TYPE-1 from TRADER-4 in round 1. This quote from TRADER-4 is my path to meeting that need. I have sufficient USDC (0.002874 USD initial, quote costs 0.0017 USD). P |
| 3 | issue_quote(qr-3) | ok | TRADER-2 is requesting TYPE-2 (my skill); I must issue the quote to enable the job delivery chain. This is a foundational move in Round 1. |
| 4 | issue_quote(qr-6) | ok | TRADER-1 is requesting TYPE-2 (my skill) for Round 2. I must answer to keep the market moving and build reciprocal trust for my Round 3 need (TYPE-4 from TRADER-1). |
| 5 | request_quote → ISSUER-B (raw work, 0.001437/SIU) | ok | I owe 1 TYPE-2 delivery (qr-6) but hold 0 units of raw work. I must acquire raw work from ISSUER-B to fulfill this obligation. I have sufficient USDC balance to pay for t |
| 6 | pay_with_usdc(qr-10) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | I need raw work to deliver the TYPE-2 job I've been paid for (qr-6). I have sufficient USDC balance to pay for this unit from ISSUER-B, and I owe more deliveries (1) than |
| 7 | deliver_job(qr-6) | REFUSED: deliver_job: you hold no unit of raw work, and delivering uses one. | I have been paid for qr-6 (TYPE-2 job for TRADER-1) but hold 0 raw work units. I need to request raw work first before I can deliver. However, my previous attempt to pay  |
| 8 | pay_with_usdc(qr-10) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | I owe delivery on qr-6 but hold no raw work. The prior attempt to pay for raw work failed due to insufficient balance. I need to acquire at least one unit of raw work to  |
| 9 | waits |  | I owe a TYPE-2 delivery (qr-6) but have no raw work units. I need to acquire one from ISSUER-B (qr-10), but lack 226 USDC minor units (need 1400, have 1174). I'm waiting  |
| 10 | request_quote → TRADER-1 (a job, 0.0017244/SIU) | ok | I need TYPE-4 from TRADER-1 for round 3. First, I must acquire raw work to deliver the TYPE-2 job I'm already obligated to (qr-6), then I can deliver it and use the escro |
| 11 | pay_with_held_claim(qr-11) | ok | I need TYPE-4 from TRADER-1 (round 3 need). I hold 2 SIU of fSIU, so I can pay this 0.0017 USD quote with held claim rather than USDC, preserving my limited USDC for the  |

### TRADER-4 — gpt-5.4-mini, delivers TYPE-1

| turn | what it did | outcome | its stated reason |
| ---: | --- | --- | --- |
| 1 | issue_quote(qr-2) | ok | Answer TRADER-3's open request for our TYPE-1 job so we can later deliver it if paid. |
| 2 | request_quote → TRADER-1 (a job, 0.0017244/SIU) | ok | Buy TRADER-1's round-1 TYPE-4 now so I can meet my only open need and keep the chain moving. |
| 3 | waits |  |  |
| 4 | request_quote → TRADER-2 (a job, 0.0017244/SIU) | ok | I need the round-2 TYPE-3 job from TRADER-2 and can buy it now. |
| 5 | request_quote → ISSUER-B (raw work, 0.001437/SIU) | ok | Need one raw-work unit before I can deliver qr-2. |
| 6 | pay_with_usdc(qr-4) | ok | Pay for the TYPE-4 input I need from TRADER-1 so I can later deliver TRADER-3's TYPE-1 job. |
| 7 | request_quote → TRADER-1 (a job, 0.0017244/SIU) | REFUSED: you have no open need that TRADER-1 can deliver. You have no open needs now. | I need raw work to deliver my paid TYPE-1 job. |
| 8 | request_quote → TRADER-2 (a job, 0.0017244/SIU) | REFUSED: you have no open need that TRADER-2 can deliver. You have no open needs now. | Need to buy TYPE-3 from TRADER-2 for round 2 before I can deliver my paid TYPE-1 job. |
| 9 | deliver_job(qr-2) | REFUSED: deliver_job: you hold no unit of raw work, and delivering uses one. | Deliver the paid TYPE-1 job to meet my open need and progress the window. |
| 10 | pay_with_usdc(qr-8) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | Buy raw work now so I can deliver the paid TYPE-1 job. |
| 11 | pay_with_usdc(qr-8) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | Settle the raw-work unit in USDC so I can then deliver the open TYPE-1 job. |
| 12 | pay_with_usdc(qr-8) | REFUSED: This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units. | Settle the raw-work quote now so I can deliver my pending TYPE-1 job and meet the remaining need. |
| 13 | waits |  | Waiting for a state change that lets me acquire raw work or otherwise clear the open obligation. |

### ISSUER-B — the issuer service (no model; answers requests, releases escrows)

| turn | what it did | outcome | its stated reason |
| ---: | --- | --- | --- |
| 1 | issue_quote(qr-8) | ok |  |
| 2 | issue_quote(qr-9) | ok |  |
| 3 | issue_quote(qr-10) | ok |  |
| 4 | issue_quote(qr-12) | ok |  |

## 5. The ledger: every sale, and where each stood at the end

| request | what | buyer | seller | quoted | paid in | escrow released | delivered |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qr-1 | job | TRADER-1 | TRADER-2 | yes | usdc | — | — |
| qr-2 | job | TRADER-3 | TRADER-4 | yes | usdc | — | — |
| qr-3 | job | TRADER-2 | TRADER-3 | yes | not paid | n/a | — |
| qr-4 | job | TRADER-4 | TRADER-1 | yes | usdc | yes | yes |
| qr-5 | job | TRADER-4 | TRADER-2 | no | not paid | n/a | — |
| qr-6 | job | TRADER-1 | TRADER-3 | yes | usdc | — | — |
| qr-7 | job | TRADER-2 | TRADER-4 | no | not paid | n/a | — |
| qr-8 | raw work | TRADER-4 | ISSUER-B | yes | not paid | n/a | n/a |
| qr-9 | raw work | TRADER-1 | ISSUER-B | yes | fsiu | n/a | n/a |
| qr-10 | raw work | TRADER-3 | ISSUER-B | yes | not paid | n/a | n/a |
| qr-11 | job | TRADER-3 | TRADER-1 | yes | fsiu | n/a | yes |
| qr-12 | raw work | TRADER-1 | ISSUER-B | yes | fsiu | n/a | n/a |

A job paid in dollars sits in escrow until its seller delivers and releases it; a job paid in fSIU has left the buyer's wallet at once. **All eight jobs were asked for; six were quoted; the two never quoted (qr-5 and qr-7) were asked of the two gpt-5.4-mini traders** — qr-5 of TRADER-2, whose last screen listed it as an open request, and qr-7 of TRADER-4.

## 6. Holdings and results

fSIU in mSIU / USDC in minor units / needs met, from the chain's own balances at each snapshot:

| snapshot | TRADER-1 | TRADER-2 | TRADER-3 | TRADER-4 |
| --- | --- | --- | --- | --- |
| opening | 2000 / 2874 / 0 | 2000 / 2874 / 0 | 2000 / 2874 / 0 | 2000 / 2874 / 0 |
| round 2 opened | 2000 / 1174 / 0 | 2000 / 2874 / 0 | 2000 / 1174 / 0 | 2000 / 2874 / 0 |
| round 3 opened | 1025 / 1174 / 0 | 2000 / 2874 / 0 | 2000 / 1174 / 0 | 2000 / 1174 / 1 |
| final (before close) | 1234 / 1174 / 0 | 2000 / 2874 / 0 | 816 / 1174 / 1 | 2000 / 1174 / 1 |

Result (USDC + fSIU at the print + 1.5 × the print per need met), nano-USD, against where each opened:

| trader | opened | final | change | needs met |
| --- | ---: | ---: | ---: | ---: |
| TRADER-1 | 5,748,000 | 2,947,258 | -2,800,742 | 0 |
| TRADER-2 | 5,748,000 | 5,748,000 | +0 | 0 |
| TRADER-3 | 5,748,000 | 4,502,092 | -1,245,908 | 1 |
| TRADER-4 | 5,748,000 | 6,203,500 | +455,500 | 1 |

**A scoring point worth a decision.** TRADER-1 ends 2.80 million nano-USD below where it opened, and it did most things right. In dollars it is 1,700 minor units down: it paid for two jobs (qr-1 and qr-6, 3,400) that were never delivered, and was paid 1,700 for the one job it delivered for dollars (qr-4). In fSIU it is 766 mSIU down, worth 1.10 million: it paid two raw-work units with held claims (1,950 mSIU) so that it could deliver, and was paid 1,184 mSIU for qr-11. And the 150% credit for its own two needs never arrived, because the sellers never delivered. The two undelivered jobs are money in escrow, which the score does not count for the buyer. If an undelivered escrow is still the buyer's until released, the score should say so; as built, a buyer whose seller waits looks like it lost half its value.

## 7. Why the economy stalled — three causes, with the evidence

### 7.1 Both gpt-5.4-mini traders waited with work in front of them

TRADER-2 took 6 turns, made no payment, and waited on turns 4 and 6 (the second with a bare `{"wait":true}` and no reason). This is what its last turn showed it (the board and its own action list, verbatim from `messages/WORKER-CODE/6.json`):

```
MARKET BOARD
Open quote requests addressed to you (call issue_quote with { requestId } to answer one):
  qr-5: from TRADER-4, 1 SIU, model gpt-5.4-mini, rate 0.0017244 USD/SIU, pattern fixed
YOU HAVE BEEN PAID AND OWE THE WORK — real USDC is in escrow in your favour and is not yours until you deliver and settle:
  qr-1: amount_usd_max 0.0017.
Quotes you have received (settle one by naming its requestId, in whichever asset you choose):
  qr-3: quote from seller erc8004:0x2cd53E449F6cF45c51f600e167b4D2630128c8F3, amount_usd_max 0.0017, expires 2026-10-06T19:01:33.528Z

THE LAB — ROUND 2 OF 3
  You are TRADER-2. You deliver TYPE-3 jobs, and only you can.
  A job is 1 SIU, priced at 0.0017244 USD per SIU; its quote is 0.0017 USD.
  A unit of raw work is 1 SIU, sold by ISSUER-B at the published print, 0.001437 USD per SIU; its quote is 0.0014 USD. Delivering a job uses one unit of raw work.

WHO DELIVERS WHAT
  TRADER-1 delivers TYPE-4.
  TRADER-2 delivers TYPE-3.
  TRADER-3 delivers TYPE-2.
  TRADER-4 delivers TYPE-1.
...
OPEN FOR YOU NOW
Jobs you have been paid for and have not delivered (you hold 0 units of raw work):
  qr-1: TYPE-3 for TRADER-1
  You owe 1 delivery and hold 0 units of raw work.
```

Four things to do were on that screen: answer qr-5, deliver qr-1 (paid, in escrow), buy a unit of raw work to be able to, and pay qr-3. It replied `{"wait":true}` with no reason. TRADER-4 (the other gpt-5.4-mini seat) completed one payment in dollars (qr-4), was then refused a 1,400-unit raw-work payment — *"This payment costs 1400 USDC minor units; the wallet holds 1174 USDC minor units."* — and **sent the same call again, unchanged, on its next two turns, and was refused the same way each time**, then waited. All the while it held 2,000 mSIU that would have paid it. It never called `pay_with_held_claim` or `pay_with_new_claim`.

The haiku-4-5 traders answered the same refusal differently. TRADER-1 was refused three payments in a row (turns 5, 7 and 8: dollars, then a new claim twice), and on turn 10 reasoned *"I hold 2 SIU of fSIU … paying for the raw work unit with my held claim costs 1400 mSIU"* and paid with it; it did the same again on turn 17 after another refusal. TRADER-3 used a held claim once. So the one-sentence refusal, which says what the payment costs against what the wallet holds and nothing about what to do, was enough for one model to find the held route and not for the other. That is a difference between the two models, seen in both runs, and not between the runs.

### 7.2 One trader's holdings were stranded between two assets

TRADER-3 ended with 1,174 USDC minor units and 816 mSIU. Its raw-work quote (qr-10) was 1,400 in dollars or 975 mSIU in claim. Together its holdings are worth more than the quote; separately neither covers it, and no route pays partly from a held claim and partly in dollars (`pay_split` mints its claim part, and minting costs dollars). So it could not buy the unit, could not deliver qr-6, and TRADER-1 never got its job. This is structural: it would strand the same trader whichever model played it.

### 7.3 The opening endowment pays for the first purchases, and that is not "received" fSIU

Each trader opens with 2,000 mSIU, enough for one job (1,184) or two raw-work units (975 each). A payment from that endowment is not an opportunity, because the trader did not receive it. Opportunities arise only once a trader has been *paid* in fSIU and then pays out at least that much. In a run where all eight sales happen, with some paid in fSIU, that could be a few per run; with two of eight needs met and buyers paying in dollars four times in seven, it was one.

## 8. Run 1, the pilot, in brief

Kept for what it found; never counted. 0 opportunities, 0 of 8 needs, $0.692936 realized over 121 turns.

| trader | model | turns | calls it made |
| --- | --- | ---: | --- |
| TRADER-1 | claude-haiku-4-5 | 12 | request_quote ×4, pay ×4, issue_quote ×1, pay_with_claim ×1, deliver_job ×1, waits ×1 |
| TRADER-2 | gpt-5.4-mini | 29 | pay_with_claim ×14, request_quote ×4, issue_quote ×3, wait ×2, pay ×2, waits ×2, deliver_job ×1, get_balances ×1 |
| TRADER-3 | claude-haiku-4-5 | 40 | pay ×28, pay_with_claim ×8, request_quote ×2, issue_quote ×1, get_balances ×1 |
| TRADER-4 | gpt-5.4-mini | 38 | pay_with_claim ×27, request_quote ×5, issue_quote ×3, wait ×2, waits ×1 |

What went wrong, in order of weight: (1) a spending cap enforced against projected spend (about five times what a turn realizes) stopped the loop at about 125 turns, with round 3 unopened — fixed; (2) the board's `answers qr-2: …` line led TRADER-3 to call `pay` with the id "answers qr-2" in 28 of its 40 turns — fixed (D28); (3) `pay_with_claim` was read as "spend the fSIU I hold": TRADER-4 called it 27 times, 24 refused for want of dollars, and no trader tried `transfer_claim` once — fixed by renaming (D26); (4) a seller paid its own quote by minting a claim for itself (D24) — fixed by a guard. 38 of its 39 write retries were genuine refusals, each costing 8 seconds — fixed by checking funds before sending (D27).

## 9. Cost, timing, and how to read the raw files

Rerun: inference $0.256017 (Anthropic $0.183395, OpenAI $0.072622), graded work $0.002855: about $0.005 a turn, input about 6,000 tokens and output 100 to 300. The loop took about 14 minutes and the run then idled to the end of its 30-minute window, because claims can only be expired after the window closes. Write retries: 0 (none were needed). The pilot's $0.693 and the earlier plan's estimates are in the plan, §13.

To look at the raw material:

```
# the report, as JSON
python3 -m json.tool data/lab/runs/lab-2026-10-06T18-00-30-905Z-report.json | less
# what an agent was shown on a given turn, and what it replied
python3 -c "import json;m=json.load(open('data/lab/runs/lab-2026-10-06T18-00-30-905Z/messages/WORKER-CODE/6.json'));print(m['prompt']);print('REPLY:',m['rawText'])"
# pool every committed report under the approved rule
pnpm run lab-report   # from packages/gate-market-agents
```

## 10. What these two runs do and do not say

They say the harness now runs to the end and measures what it is meant to: the payment tools are named for what they do, a quote is paid by the trader who asked for it, an unaffordable payment is refused in one sentence whichever asset it is in, and the spending cap means what it says. They say nothing about whether agents reuse fSIU: with one opportunity in one run, nothing could be said. What they show is that, as designed, the experiment would produce few opportunities, for the three reasons in §7, and that is worth deciding before twenty runs are spent on it. The options are in `docs/marketplace_plan.md` (D29) and in the message that accompanied this report.
