# DRAFT methodology note: the discarded first call of a retried Gemini run

**Status: DRAFT, 2026-10-20. Not published. No rule, print or number has been changed.** Written for the owner to approve, amend or reject; if approved it becomes a dated entry in `docs/methodology.md` (a Revision history row and a section), announced with the next print. The public version would drop this status block and the "Decision requested" section.

## 1. What happened

`gemini-3.1-pro-preview` cannot turn its reasoning off (a request for a zero thinking budget is refused: "This model only works in thinking mode"). The basket gives every model the same small output budget per task (T1 and T3: 512 tokens, T2: 256). Gemini's reasoning uses that budget up before it writes an answer, so the provider reports `MAX_TOKENS` with a non-zero reasoning count. The Google adapter then **retries once with a larger budget** (the task's own plus up to three times that, `REASONING_BUDGET_MULTIPLE`), and the retry answers. This is the "Reasoning-token budget accommodation" of 2026-08-30. Google bills **both** calls.

How often: **479 of 592** Gemini run records in the repository (81%). In the published blended prints, 185 of 229 records before 2026-09-14 and 387 of 478 from that date on. **No other model retries**: 0 of about 5,600 records across the eleven other registry models (the Anthropic and OpenAI adapters have the same retry in code and it has never fired; the OpenAI-compatible adapter has none, because reasoning tokens there are billed separately and never consume the budget).

What the print did with the first call:

- **Prints dated 2026-08-30 to 2026-09-13:** the retry's response replaced the first call's result, so the discarded call was **not priced**. Gemini's cost was the successful call alone. Its raw response was not kept, so that call's cost cannot be reconstructed for those prints (this is already stated in the methodology, with those prints permanently `provisional`).
- **Prints dated 2026-09-14 on:** both calls' usage is summed (the fix of 2026-09-13, first carried by the print of 2026-09-14), so the discarded call **is priced**.

## 2. How much it moved the published prints

Every figure below is a recomputation with the print's own code (`computePrint`, from each print's declared run records and its own price snapshot). **All 150 published print files (blended and tier series, 2026-08-18 to 2026-10-20) reproduce exactly** before anything is changed, so the baseline is the published number. The only change is that each Gemini run's discarded first call, taken from the saved raw response, is not priced. Nothing else is touched.

- **Gemini's own row** (basket cost per SIU, USD): in the 31 prints from 2026-09-14 to 2026-10-20 with a fresh Gemini measurement, leaving out the discarded call lowers it by **43% to 46% (median 45%)**. On 2026-10-20: 0.039780 as published, 0.022028 without.
- **The blended Dated SIU headline** (an equal-weight mean of ten models' basket costs): lower by **16.3% to 23.4% (median 16.5%)** over the same prints. The 23.4% is 2026-09-18, when only eight models were in the mean. On 2026-10-20: 0.01084 as published, 0.009068 without.
- **The Frontier series** (Gemini is the one closed-weights model with this behaviour, so it is in this series): lower by **17.1% to 25.1% (median 17.3%)**. On 2026-10-20: 0.01712 as published, 0.01416 without.
- **The Commodity series is not affected.** It has no Gemini row.
- **A step in the published series.** The headline went from 0.0089 on 2026-09-13 to 0.0110 on 2026-09-14, a rise of 24%. **Without the discarded call it goes from 0.0089 to 0.0092, a rise of 3%.** Almost all of that day's rise is the first call starting to be priced, not a market movement. The prints of 2026-08-30 to 2026-09-13 are on the "successful call only" basis, the prints from 2026-09-14 on are not, and the series does not say so on its face.
- **Quotes.** The MCP server prices a quote from `exchange_rate_table.usd_per_siu`. On the published basis Gemini's rate is about 80% higher than on the successful-call basis.

The full per-print table is in the appendix.

## 3. What our own documents say, and where they disagree

1. **2026-08-30, the accommodation rule:** "a real buyer sets a budget that accommodates the model's reasoning, pays for those tokens, and gets a correct answer — the index should reflect that." and "a benchmark artifact, not a market fact". Read on its own this points to the **successful call only**.
2. **2026-09-13, the fix:** the adapter's comment says Google bills both calls, so "this project's own number must sum both too, or it understates real cost". It was recorded as a pricing bug, in line with invariant 1 (prices come from executed runs and what was billed).
3. **The class-cost rule (build1-spec §6.1)** already sums every attempt up to the first pass, including attempts that failed the gate, so a call that did not produce a passing answer is a cost the index has always counted. A truncated call is arguably one of those.

These are three defensible readings. The data above shows what each gives. It does not decide between them.

## 4. What is not known, and not claimed

- **Whether a buyer would pay for both calls** depends on whether the buyer knows the budget Gemini needs in advance. We have not measured that. The basket's fixed budget is the same for every model by design; the discarded call exists because that shared budget meets one model's mandatory reasoning, so it is a property of the basket as much as of Gemini.
- **The pre-2026-09-14 prints' first call is unrecoverable** (the raw response was not saved), so those prints cannot be restated on the "both calls" basis. Only the other direction (removing the first call from later prints) can be computed, which is what this note does.
- **Invoices:** the provider invoice would include both calls. That is evidence about our production cost (`cost_of_production_usd` already sums every attempt), not about the price of a task. We have not re-run the reconciliation on this question.
- The recomputed figures are not a claim of a print's true economic value, in the same way as the rounding recomputation in the methodology.

## 5. Options (a decision for the owner)

- **A. Keep the rule, disclose it.** Publish this note, mark the 2026-09-14 step on the series, and state on the site that Gemini's row includes a discarded call. No number changes.
- **B. Keep the headline, add the other basis beside it.** Publish the "successful call only" figure for the headline and for Gemini as a sensitivity row on every print from the next revision on (the print already carries a sensitivity block), so both bases are visible and neither is silent.
- **C. Change the rule to successful call only,** as a versioned revision effective from a stated date. Published prints are never edited; the recomputed series is shown beside them with a `correction_notes` entry, as the rounding correction was (excluded from the signed payload, so no signature or anchor changes). Quotes derived from the exchange rate fall for Gemini from that date.

**Recommendation: B now, and C after a stated notice period, announced in the same release.** The 2026-09-14 step is demonstrably an artefact, which is the strongest argument that the headline should not carry it unannounced; B makes both bases public at once without a silent move, and C then follows only if you decide the successful-call basis is the one the index means. If you think the as-executed basis is the right one, A is the honest minimum.

## 6. Decision requested

1. Which of A, B or C.
2. If B or C: the effective date, the revision id (`rules-2026-10-xx`), and the wording of the announcement.
3. Whether the tier series and the MCP quote path are to be restated in the same release.

Nothing is published until you say.

## 7. Reproduction

For every print file: build the recomputation input with the print package's own `buildVerifyInput`, run `computePrint` (baseline; it must equal the published figures, and does for all 150 files), then run it again with each Gemini record's usage replaced by the final call's usage from its saved raw response (`raw.final.usageMetadata`), for records whose usage is the sum of both calls. Carried-forward Gemini rows are adjusted the same way. The script is kept with the analysis outputs and is committed with the note if you approve it; it writes nothing to the repository.

## Appendix: per print, blended and Frontier

| Print      | Published headline | Without the discarded first call | Change | Gemini row, published | Gemini row, without | Gemini records retried                     | Frontier series, published | Frontier, without | Change |
| ---------- | ------------------ | -------------------------------- | ------ | --------------------- | ------------------- | ------------------------------------------ | -------------------------- | ----------------- | ------ |
| 2026-09-13 | 0.0089             | 0.0089                           | +0.0%  | 0.020386              | 0.020386            | 11 of 14                                   | 0.0138                     | 0.0138            | +0.0%  |
| 2026-09-14 | 0.0110             | 0.0092                           | -16.4% | 0.041788              | 0.023476            | 14 of 17                                   | 0.0174                     | 0.0144            | -17.2% |
| 2026-09-15 | 0.0107             | 0.0089                           | -16.8% | 0.038260              | 0.020653            | 14 of 17                                   | 0.0168                     | 0.0139            | -17.3% |
| 2026-09-16 | 0.0108             | 0.0090                           | -16.7% | 0.040044              | 0.021976            | 13 of 16                                   | 0.0171                     | 0.0141            | -17.5% |
| 2026-09-17 | 0.0111             | 0.0091                           | -18.0% | 0.038513              | 0.020772            | 14 of 17                                   | 0.0188                     | 0.0152            | -19.1% |
| 2026-09-18 | 0.0094             | 0.0072                           | -23.4% | 0.038420              | 0.020830            | 14 of 17                                   | 0.0175                     | 0.0131            | -25.1% |
| 2026-09-19 | 0.0109             | 0.0090                           | -17.4% | 0.039125              | 0.021284            | 12 of 15                                   | 0.0186                     | 0.0150            | -19.4% |
| 2026-09-20 | 0.0108             | 0.0090                           | -16.7% | 0.039089              | 0.021162            | 12 of 15                                   | 0.0170                     | 0.0141            | -17.1% |
| 2026-09-21 | 0.0107             | 0.0089                           | -16.8% | 0.038780              | 0.020999            | 12 of 15                                   | 0.0169                     | 0.0140            | -17.2% |
| 2026-09-22 | 0.0107             | 0.0089                           | -16.8% | 0.038640              | 0.021000            | 14 of 17                                   | 0.0169                     | 0.0140            | -17.2% |
| 2026-09-23 | 0.0108             | 0.0090                           | -16.7% | 0.040273              | 0.022299            | 13 of 16                                   | 0.0171                     | 0.0141            | -17.5% |
| 2026-09-24 | 0.0108             | 0.0090                           | -16.7% | 0.039094              | 0.021212            | 12 of 15                                   | 0.0170                     | 0.0140            | -17.6% |
| 2026-09-25 | 0.0111             | 0.0091                           | -18.0% | 0.039236              | 0.021403            | 12 of 15                                   | 0.0189                     | 0.0153            | -19.0% |
| 2026-09-26 | 0.007626           | 0.007626                         | +0.0%  | excluded that day     |                     |                                            |                            |                   |        |
| 2026-09-27 | 0.01100            | 0.009189                         | -16.5% | 0.041237              | 0.023131            | 13 of 16                                   | 0.01738                    | 0.01436           | -17.4% |
| 2026-09-28 | 0.01096            | 0.009158                         | -16.4% | 0.041148              | 0.023109            | 13 of 16                                   | 0.01732                    | 0.01431           | -17.4% |
| 2026-09-29 | 0.01097            | 0.009162                         | -16.5% | 0.041142              | 0.023078            | 13 of 16                                   | 0.01733                    | 0.01432           | -17.4% |
| 2026-09-30 | 0.01093            | 0.009128                         | -16.5% | 0.041142              | 0.023078            | none run (carried forward from 2026-09-29) | 0.01251                    | 0.01251           | +0.0%  |
| 2026-10-01 | 0.01093            | 0.009141                         | -16.4% | 0.040208              | 0.022273            | 12 of 15                                   | 0.01726                    | 0.01428           | -17.3% |
| 2026-10-02 | 0.01092            | 0.009125                         | -16.4% | 0.040208              | 0.022273            | none run (carried forward from 2026-10-01) | 0.01264                    | 0.01264           | +0.0%  |
| 2026-10-03 | 0.01081            | 0.009035                         | -16.4% | 0.039807              | 0.022021            | 12 of 15                                   | 0.01707                    | 0.01411           | -17.3% |
| 2026-10-04 | 0.01084            | 0.009073                         | -16.3% | 0.039489              | 0.021767            | 11 of 14                                   | 0.01711                    | 0.01416           | -17.2% |
| 2026-10-05 | 0.01117            | 0.009334                         | -16.4% | 0.042723              | 0.024314            | 14 of 17                                   | 0.01767                    | 0.01460           | -17.4% |
| 2026-10-06 | 0.01085            | 0.009065                         | -16.5% | 0.039747              | 0.021914            | 12 of 15                                   | 0.01712                    | 0.01415           | -17.3% |
| 2026-10-09 | 0.01083            | 0.009054                         | -16.4% | 0.039990              | 0.022200            | 12 of 15                                   | 0.01711                    | 0.01414           | -17.4% |
| 2026-10-10 | 0.01087            | 0.009075                         | -16.5% | 0.039881              | 0.021970            | 12 of 15                                   | 0.01715                    | 0.01417           | -17.4% |
| 2026-10-11 | 0.01087            | 0.009090                         | -16.4% | 0.040379              | 0.022608            | 12 of 15                                   | 0.01716                    | 0.01420           | -17.2% |
| 2026-10-12 | 0.01090            | 0.009120                         | -16.3% | 0.040571              | 0.022755            | 12 of 15                                   | 0.01722                    | 0.01425           | -17.2% |
| 2026-10-13 | 0.01078            | 0.009006                         | -16.5% | 0.039820              | 0.022124            | 12 of 15                                   | 0.01702                    | 0.01407           | -17.3% |
| 2026-10-14 | 0.01085            | 0.009072                         | -16.4% | 0.039953              | 0.022130            | 12 of 15                                   | 0.01714                    | 0.01417           | -17.3% |
| 2026-10-15 | 0.01074            | 0.008983                         | -16.4% | 0.039136              | 0.021591            | 11 of 14                                   | 0.01695                    | 0.01403           | -17.2% |
| 2026-10-16 | 0.01089            | 0.009106                         | -16.4% | 0.040094              | 0.022272            | 12 of 15                                   | 0.01720                    | 0.01423           | -17.3% |
| 2026-10-17 | 0.01087            | 0.009092                         | -16.4% | 0.040094              | 0.022272            | none run (carried forward from 2026-10-16) | 0.01259                    | 0.01259           | +0.0%  |
| 2026-10-18 | 0.01088            | 0.009082                         | -16.5% | 0.040191              | 0.022249            | 12 of 14                                   | 0.01717                    | 0.01418           | -17.4% |
| 2026-10-19 | 0.01096            | 0.009151                         | -16.5% | 0.041042              | 0.022978            | 13 of 16                                   | 0.01731                    | 0.01430           | -17.4% |
| 2026-10-20 | 0.01084            | 0.009068                         | -16.3% | 0.039780              | 0.022028            | 11 of 13                                   | 0.01712                    | 0.01416           | -17.3% |
