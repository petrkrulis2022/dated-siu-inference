# Plan: say why a constituent was not measured, in the published print, and tell the operator the same day

*PROPOSED 2026-10-09. Nothing here is built. It touches the signed print format and the daily workflow, so it waits for approval.*

## 1. What exists today (read from the code and from real prints, 2026-10-09)

| Case | What a reader of the print sees | What an operator is told |
|---|---|---|
| A constituent has a price but no run records (outage, billing, a refused sampling mismatch) | A row in `basket_costs` and in `exchange_rate_table` with `excluded_reason`, which says only *what* is missing: `undefined class: T1 (no run records for this class); T2 …; T3 …`. **The cause is not in it.** (Example: gemini-3.1-pro-preview, 2026-09-26.) | The workflow log's infrastructure-failure summary. Only billing exhaustion also fails the run. |
| A constituent has no price in the snapshot (`unpriced`) | **Nothing.** It never reaches the computation. | A `console.warn` line. |
| A constituent is carried forward (blended print only, up to 3 days) | `carried_forward_from: "<date>"` on its row. | Nothing. |
| The print is refused (fewer than 4 genuinely measured models overall, or fewer than 4 in a tier) | No print. | An incident file in `data/prints/incidents/` with the infrastructure-failure text, and a failed run. |

So a dropped model is sometimes named and never explained, and sometimes not named at all. (My earlier statement that a dropped model is "invisible unless a correction note is written" was too broad: the first row is visible, with a generic reason.)

**Two facts about the tier series that matter for the question in §5.** The commodity tier has exactly four constituents and a minimum of four genuinely measured models, so **losing any one of them, for any reason, refuses the day's blend and the commodity print** (this is what happened on 2026-10-07: "only 2 of 4 commodity-tier models qualified"). Carried-forward rows never count toward a gate, so carry-forward would not help there. The frontier tier has six constituents and the same minimum, so it can lose two and still publish, with the mean shifted and no carry-forward (carry-forward is blend-only).

## 2. The proposal

### 2.1 An `exclusions` field in the signed print body (optional)
One entry for every registered constituent that is not measured fresh in that print, whatever the reason:

```
exclusions: [
  { model_id, status: "excluded" | "carried_forward",
    cause: "sampling_mismatch" | "billing_exhausted" | "rate_limit" | "server_error" | "timeout" | "network" |
           "auth_or_bad_request" | "malformed_response" | "policy_refusal" | "quality_gate_failed" |
           "no_price_in_snapshot" | "no_run_records" | "unknown",
    detail: "<one sentence, the adapter's own>",           // e.g. "SAMPLING MISMATCH: gpt-5.1 is declared at temperature 0 and its request went out at provider-default …"
    carried_forward_from?: "<date>" }                        // only for carried rows
]
```
- Built at publish time from facts the run already holds: the orchestrator's failure categories (`outcomes`), the `unpriced` list, and the compute result's excluded and carried rows. A model with several failures gets one entry (its commonest category, with a count in `detail`).
- It is **informational**, like `prior_attempts` and `constituent_changes`: part of the signed body (so it cannot be edited after the fact), not recomputed by `verify`. `basket_costs` and `excluded_reason` stay exactly as they are, so every figure still recomputes from run records.
- Present on the blended print and on each tier series, filtered to that series' constituents.
- Optional in the schema, so every existing print still validates and verifies. No historical print is changed.
- `methodology_revision` stays unchanged (no published value changes); the methodology gets one dated note.

### 2.2 A same-day alert
After the print is published, tweeted and committed (not before, as the billing step), a workflow step reads a greppable `EXCLUSION_SUMMARY {json}` line that the publisher prints whenever the print has any `exclusions`, and opens a GitHub issue: *"Print 2026-10-10: 1 constituent not measured fresh"*, listing each model, its status (**excluded** or **carried forward**), its cause, and its carried date. The run stays green, so the print is never lost over one model. It fires for **carried-forward rows as well as exclusions**: a price carried for three days is a model that was not measured, and the operator should know on day one. A day with no exclusions opens nothing. Needs `issues: write` on the workflow's token. GitHub emails the repository owner for a new issue if their notification settings allow it.

## 3. Files (about ten)
`packages/sdk/schemas/print.schema.json` and its generated type; `packages/sdk` validation test; `packages/print/src/publish.ts` and `cli/publish-unattended.ts` (build the entries, print the summary line); `packages/print/src/compute` (expose the carried and excluded rows it already knows); `verify` (accept, do not recompute); `site/` (show the field where the print is shown, prominently on the tier series); `.github/workflows/publish-print.yml` (the issue step); tests for each; `docs/methodology.md` (one dated note). Rollout: merge on a day with no print pending; the next scheduled print is the first to carry it. Rollback: remove the optional field; nothing else depends on it.

## 4. Tests that would be required
Field validates and is optional; every existing print still verifies; an excluded model, a carried model, an unpriced model and a sampling mismatch each produce the right entry; a tier series lists only its own constituents; a day with none produces no field and no summary line; the summary line is exactly what the workflow step greps; a publisher run with a forced mismatch publishes (green) with the entry present.

## 5. Questions for you
1. **Tier series.** The headline blend is protected by carry-forward for up to three days; the tier series are not. Options: **(a)** show the new field prominently on both series and leave carry-forward alone (my recommendation now: it makes the cause public, and changes no figure); **(b)** also carry forward in the frontier series (a methodology change, retro-validated first, as the blend's was; it would not help the commodity series, whose gate counts only fresh measurements); **(c)** change the commodity tier so one lost constituent is not a veto (a fifth constituent, which is a registry-policy decision, or a lower minimum, which is a methodology decision). I suggest (a) now and (c) as its own decision.
2. **Alert channel.** A GitHub issue (email to you by default), or something you watch more closely? The run staying green is deliberate.
3. **Quality-gate failures** (a constituent measured but not passing): include them in the field? I propose yes, with cause `quality_gate_failed` and the failing class.
