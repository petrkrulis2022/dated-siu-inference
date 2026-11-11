# Window 7's HTTP 400s in the v2 counted run: cause

Read-only. No code changed, no model API called. Run: `economy-counted-model-stand-in-2026-11-08T11-13-21-246Z` (D139). Sources: the run's `log.jsonl`, the spend
ledger `data/lab/cr/spend-ledger.jsonl` (wall-clock times; the run log has none), the cr-lab source on `part5`, and the daily print's GitHub Actions job logs for
7 to 11 November (read with `gh`, read-only).

## Answer

**Most likely cause: the Anthropic organisation's prepaid credit ran out at about 11:28:46 UTC on 8 November, partway through window 7 round 5. From that moment
every request was refused with HTTP 400 before any work was done, whichever agent sent it.** Confidence: **likely, strong**. Not confirmed, because the run kept no
response body or request id for these 14 calls (see Q1). It can be confirmed without any API call: the Anthropic Console's logs for the trial key
(`CR_ANTHROPIC_API_KEY`, workspace `blockworks-marketplace`) at 11:28:46 to 11:28:51 UTC on 8 November should show "Your credit balance is too low to access the
Anthropic API".

The 14 failures: 2 in round 5 (DEMAND-1, RESEARCH-2) and all six agents in rounds 6 and 7 (log seq 1444 to 1457).

## Evidence

**1. The failures are one unbroken run in call order, not scattered by agent.** In window 7 round 5, DEMAND-3, HEDGER, RESEARCH-1 and DEMAND-2 succeeded (seq 1435,
1437, 1441, 1443). Every call after DEMAND-2's failed, for all six agents, through the end of the run:

```
seq 1443  round 5  DEMAND-2    parsed: true   tool: accept_quote   (last success)
seq 1444  round 5  DEMAND-1    parsed: false  serviceFailure: "model call failed (status 400)"
seq 1445  round 5  RESEARCH-2  parsed: false  serviceFailure: "model call failed (status 400)"
seq 1446-1451  round 6  DEMAND-3, DEMAND-2, RESEARCH-1, DEMAND-1, RESEARCH-2, HEDGER  -- all status 400
seq 1452-1457  round 7  RESEARCH-2, RESEARCH-1, DEMAND-3, DEMAND-1, HEDGER, DEMAND-2  -- all status 400
```

**2. The wall clock shows an instant cutoff.** The ledger writes a line for every call, with `usd: "0.000000"` for a failed one:

```
2026-11-08T11:28:43.884Z  RESEARCH-1 w7 r5  0.011446
2026-11-08T11:28:45.838Z  DEMAND-2 w7 r5    0.007870   <- last success
2026-11-08T11:28:46.246Z  DEMAND-1 w7 r5    0.000000   <- first failure
...
2026-11-08T11:28:50.692Z  DEMAND-2 w7 r7    0.000000   <- 14th failure
```

All 14 came back within 4.4 seconds, about 0.3 s apart. A successful call in this run took about 2 to 2.5 s. The API refused each request before generating
anything. A 400 is not retried (`anthropic-loop.ts:33`, `const RETRYABLE = new Set([429, 500, 502, 503, 529]);`), so each failure is a single attempt.

**3. The same organisation's other key was refused the same way, for the same reason, on the following days.** The daily print uses its own Anthropic key
(Default workspace) on the same organisation's credit. Its job logs:

- 8 Nov, 00:40 UTC run: Claude calls succeeded. The run failed only on the tweet (`Tweet failed: 402 {"detail":"credits depleted"`, the X API).
- 9 Nov, 00:40 UTC run (job 128917155326): every Claude call refused:
  ```
  claude-sonnet-5 / T1: 5x billing_exhausted — "Anthropic request failed: 400"
    real response body: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API.
    Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CgrRfEXijQzMD886gnhFZ"}
  ```
  The same for T2 and T3, and for claude-haiku-4-5 T1 to T3.
- 10 Nov, 00:36 UTC and 11 Nov, 00:37 UTC runs: the same six lines.
- 7 Nov, 00:35 UTC run: tweet failure only, no Claude refusals.

So the organisation's Anthropic credit ran out between the 8 Nov 00:40 print and the 9 Nov 00:40 print. The counted run's first refusal, at 11:28:46 on 8 Nov,
is the earliest refusal on record in that interval.

**4. This project already knows what credit exhaustion looks like from Anthropic: a 400, not a 402.** `packages/harness/src/retry.ts:3-9` (main checkout):

```ts
 * Detects a provider rejecting a call because *our own* prepaid balance ran out — distinct from
 * every other 4xx/429 (bad key, bad request, genuine rate limit) because retrying never helps
 * and the fix is a top-up, not a backoff. Confirmed live, 2026-09-17/09-18/09-25: Anthropic
 * returns a genuine HTTP 400 with body `{"error":{"type":"invalid_request_error","message":
 * "Your credit balance is too low to access the Anthropic API. ..."}}`
```

**5. The workspace's own spend limit is the less likely cutoff.** Both cr-lab ledgers (`dsi-part5` and `dsi-cr-trial`, merged, duplicates removed) record
$40.29 spent on `CR_ANTHROPIC_API_KEY` from its first call (17 Oct) to the cutoff: $26.18 in October and $14.12 in November. That is under the $55 monthly limit
the owner set on the `blockworks-marketplace` workspace on 17 Oct. The organisation's credit is shared with the print's key and any other key on the account,
whose spend is not in these ledgers, so the balance's path to zero cannot be reconstructed from repo data. The Console's usage page has it.

## Q1. Does the runner record the error body or request size?

**No to both.** The body is read and then dropped:

- `anthropic-loop.ts:202-207`: a non-stream response's body is parsed into `json`.
- `anthropic-loop.ts:254`: `if (r.status !== 200) return { status: r.status, attempts: r.attempts };`. `json` is not passed on.
- `model-agent.ts:57-63`: the failure becomes `` `model call failed (status ${turn.status})` ``, the status alone.
- `runner.ts:191-196`: the log entry carries that string as `serviceFailure` and nothing else.

No request id is kept either. On request size, the prompt text is never written to the log (`runner.ts:187` builds it and passes it straight to the model). The
ledger guard's projected cost (`model-agent.ts:33-42`, `Math.ceil(prompt.length / 3)` input tokens) is used for the reservation and not written. For a
successful call, the ledger keeps the dollar cost but not the token counts.

## Q2. How prompt length grew per window

**It barely grew, and stayed far below any size limit.**

Each call is one fresh user message with no history: `model-agent.ts:54` (`this.chat.send(this.chat.init(prompt), ...)`) and `anthropic-loop.ts:240`
(`init: (prompt) => [{ role: "user", content: prompt }]`). The prompt is the role instructions plus the rendered board, and the tool definitions are sent
alongside it.

Only one board section carries over between windows: quotes (`board.ts:147-149`, every quote except lapsed ones). The rest are current-window only: needs
(`board.ts:141-146`), outputs (`board.ts:150`) and data bought (`board.ts:159-161`). Claims are current holdings (`board.ts:102-115`). Notices are emptied every
turn (`board.ts:97-98`: `w.notices.set(agent, [])`).

Quote lines on each agent's board at round 0 of each window, filled in by hand from the logged fields with `board.ts:280-294`'s line template (`renderBoard`
not run). Each cell gives lines / characters. Only 6 of the run's 14 quotes ever settled; the other 8 lapsed and left the board.

| Agent | w1 | w2 | w3 | w4 | w5 | w6 | w7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEMAND-1 | 0 / 0 | 0 / 0 | 1 / 123 | 2 / 246 | 2 / 246 | 2 / 246 | 2 / 246 |
| DEMAND-2 | 0 / 0 | 0 / 0 | 1 / 123 | 1 / 123 | 2 / 246 | 2 / 246 | 3 / 370 |
| DEMAND-3 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 123 | 1 / 123 |
| HEDGER | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| RESEARCH-1 | 0 / 0 | 0 / 0 | 1 / 123 | 2 / 246 | 2 / 246 | 3 / 369 | 4 / 493 |
| RESEARCH-2 | 0 / 0 | 0 / 0 | 1 / 123 | 1 / 123 | 2 / 246 | 2 / 246 | 2 / 246 |

The most any board carried over is about 490 characters, roughly 150 tokens. Settled quotes never leaving the board is a real defect (code-check item 1), but in
this run it added little length.

Measured independently from the ledger: mean cost per successful call, and the most input tokens that cost could buy if every cent were input
(claude-sonnet-5 at $2 per million input tokens, the repo's price snapshot `data/registry/price-snapshot-merged-2026-10-10T01-06-14.560Z.json`):

| Agent | w1 | w2 | w3 | w4 | w5 | w6 | w7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DEMAND-1 | $0.0080 / ≤4,716 | $0.0083 / ≤4,889 | $0.0081 / ≤4,462 | $0.0083 / ≤4,918 | $0.0079 / ≤4,607 | $0.0084 / ≤4,749 | $0.0085 / ≤4,592 |
| DEMAND-2 | $0.0080 / ≤5,027 | $0.0078 / ≤4,360 | $0.0082 / ≤4,559 | $0.0081 / ≤4,365 | $0.0082 / ≤5,191 | $0.0083 / ≤4,507 | $0.0082 / ≤4,520 |
| DEMAND-3 | $0.0084 / ≤4,633 | $0.0081 / ≤4,621 | $0.0080 / ≤4,619 | $0.0078 / ≤4,407 | $0.0076 / ≤4,551 | $0.0082 / ≤4,884 | $0.0086 / ≤4,909 |
| HEDGER | $0.0097 / ≤5,397 | $0.0097 / ≤5,070 | $0.0098 / ≤5,495 | $0.0090 / ≤4,702 | $0.0094 / ≤5,023 | $0.0094 / ≤5,196 | $0.0096 / ≤5,540 |
| RESEARCH-1 | $0.0109 / ≤6,879 | $0.0107 / ≤6,054 | $0.0115 / ≤7,085 | $0.0114 / ≤6,566 | $0.0115 / ≤6,719 | $0.0124 / ≤7,146 | $0.0115 / ≤6,420 |
| RESEARCH-2 | $0.0111 / ≤6,671 | $0.0106 / ≤5,703 | $0.0116 / ≤9,504 | $0.0111 / ≤5,970 | $0.0113 / ≤6,474 | $0.0113 / ≤6,250 | $0.0110 / ≤6,342 |

(The token bound is taken from the most expensive call in each cell.) Cost per call is flat from window 1 to window 7 for every agent. Across all 356 priced calls
(322 executed turns plus 34 mirror samples), the largest bound is 9,504 input tokens, a small fraction of any Claude context window. Prompt size did not cause
the 400s.

## Q3. Any other 400 cause

Each of these is ruled out by the same fact: identical requests from the same six agents were accepted seconds earlier and refused seconds later.

- **Malformed tool schema.** The tool definitions are fixed per role (`model-agent.ts:53`, `toolDefsForRole`). The same schemas were accepted on 356 calls,
  including each agent's own calls earlier in window 7. A bad schema fails on the first call.
- **Message ordering.** Every request is a single user message (`anthropic-loop.ts:240`), with no assistant turn or tool result, so no ordering rule can be broken.
- **A parameter.** Model, `max_tokens: 8000` (`model-agent.ts:28`), `tool_choice: {type: "any", disable_parallel_tool_use: true}` and
  `thinking: {type: "adaptive", display: "summarized"}` (`anthropic-loop.ts:244-253`) are the same on every call, and were accepted 356 times. A combination the
  API rejects fails from the first call.
- **Content in one request.** A body the API cannot accept would fail only for agents whose board carries it. Between the last success (11:28:45.838) and the
  first failure (11:28:46.246), the only events were RESEARCH-1's message to DEMAND-2 and DEMAND-2's refused accept. Nothing on all six boards changed, yet all six
  failed.
- **Rate limit or overload.** These arrive as 429 or 5xx/529 and are retried (`anthropic-loop.ts:33`, `208-212`). These were 400s, not retried.
- **Key expired or revoked.** That is a 401 or 403, not a 400. The trial key's recorded expiry is 16 November.

## Consequences (diagnosis only)

- Window 7 rounds 5 to 7 carry no agent decisions after seq 1443. Nothing stopped the run: the stop rule watches parse failures only (`runner.ts:265-266`;
  code-check item 5 cites 266-267, one line off).
- The run's own spend cap could not have prevented this. The ledger caps what this process spends, against a balance recorded by hand. It cannot see the
  organisation's credit, which other keys also draw down.
- As of the 11 Nov 00:37 UTC print run, the organisation's Anthropic credit was still refused. Any Anthropic call, including the phase 4 rehearsal, needs a
  top-up first.
- Outside this note's scope, recorded so it is not lost: the print's basket shows claude-sonnet-5 at `0.023623` and claude-haiku-4-5 at `0.007739` on 8, 9, 10
  and 11 November, the same figures every day, while every Claude call on 9 to 11 November was refused. The print appears to be carrying 8 November's Claude
  figures forward. Not looked into here.
