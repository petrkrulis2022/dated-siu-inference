# What to provide for a reconciliation

_A print is "final" only when a signed `ReconciliationRecord` exists for it — never by editing
`print.status`, which stays `"provisional"` on every print's signed body forever
(`docs/methodology.md` §7). This checklist is what to gather before running
`packages/print/src/cli/reconcile.ts` against a specific print._

## 1. Pick the print

**Correction, 2026-09-25: only reconcile a print dated 2026-09-25 or later.** This section
originally said 2026-09-14 onward (commit `48ba69c`) was reconciliation-ready because it fixed
"two real Gemini bugs." That was wrong for one of the two: the discarded-retry-call fix was
genuinely live from 2026-09-14, but the cached-input pricing fix was not — a separate bug
(`buildModelInputs` never forwarding a snapshot's `price_cached_in_usd_per_1m`, see
`docs/methodology.md`'s `rules-2026-09-25b`) meant cached tokens stayed priced at zero on every
real print through 2026-09-24 regardless. Reconciling any print from that window tests only the
retry-discard fix; a residual gap against a provider's real invoice on those dates is expected,
not a new problem, and does not mean the retry-discard fix itself is incomplete. The first print
genuinely computed with both fixes live is the first one published 2026-09-25 or later. Reconciling
an earlier print will refuse for reasons already known and disclosed in its own `correction_notes`
— not a useful test.

### Standing cadence, settled 2026-09-17

**Every Friday, for that week's Wednesday print.** Matches `Touchstone_Assay_design_doc_v4.md`'s
own roadmap intent ("weekly reconciliation against provider invoices once attribution is clean")
— attribution is now clean enough (§4 below), so this is the real steady-state rhythm, not a
placeholder. Weekly, not daily, because the value is a **track record of prints that hold up
under real scrutiny, repeatedly** — the moat is the series, not that every single day gets
independently certified. Reconciliation isn't time-limited either way; any past print can still
be reconciled later if ever wanted.

A fixed two-day gap (Wednesday → Friday) is a reasonable *default* based on what was seen with
Google's own settlement timing specifically — it is not a confirmed guarantee for Anthropic,
OpenAI, or xAI, which haven't been checked the same way. **The schedule says when to check, not
that the check can be skipped.** If any provider's dashboard still shows that Wednesday as
processing/estimated on the Friday, wait a day rather than reconcile against a number that could
still move — see §2.

**Correction, 2026-09-25: 2026-09-16 does not verify this — see the correction at the top of §1.**
It was picked to specifically verify both Gemini fixes had closed the real gap; only one of the
two was actually live that day. No reconciliation has in fact been run yet
(`data/reconciliations/` does not exist as of this correction). The first real one should instead
target the first Wednesday print dated 2026-09-25 or later, run two days after per §2 below.

## 2. Wait for real, finalized billing — not same-day

**Do not gather figures the same day the print publishes.** Every provider dashboard used here
can show same-day usage before it settles on their own side. Based on how this played out for
Gemini, that's realistically **a day or two after** the print's own date — confirm each
provider's dashboard shows that day as settled, not "processing" or "estimated," before pulling a
number from it.

## 3. Check the print's own basket first

Providers needed can change as the registry does (models get admitted or excluded). Don't assume
last time's list — check the target print's own `basket_costs`:

```bash
node -e "
const p = require('./data/prints/<PRINT_ID>.json');
const reg = require('./data/registry/models.json');
const byId = new Map((reg.models || reg).map(m => [m.id, m.provider]));
console.log(new Set(Object.values(p.basket_costs).map(bc => byId.get(bc.model_id))));
"
```

As of 2026-09-14 through 2026-09-17, that's five: **openrouter, anthropic, openai, google, xai.**

## 4. Get the right figure per provider — account total, or per-key only

A provider figure is only usable if it can be attributed to this project **alone**. Checked
directly against this codebase (`grep` for each key across every package), current findings:

| Provider | Use | Why |
|---|---|---|
| **OpenRouter** | Account total | Its activity log is already per-model — clean by construction |
| **Google (Gemini)** | Account total | The `siu-runs-prints` key has been solely dedicated to this project since its creation — confirmed, no other project has ever used it |
| **xAI (Grok)** | Account total | `XAI_API_KEY` appears nowhere else in the codebase except the harness |
| **Anthropic** | **Per-key**, not account total | Same key also powers the chat widget + weekly digest (`packages/chat-server`) |
| **OpenAI** | **Per-key**, not account total | Same key also powers the demo seller agents (`packages/agents`) |

If any of these keys ever gets reused somewhere new, re-check with the same grep before trusting
"account total" again — this table reflects current reality, not a permanent guarantee.

## 5. What to send me

For the target print, one real dollar figure per provider from step 3, each the right scope from
step 4. A screenshot or export from each provider's own billing dashboard is fine — I don't need
raw invoices, just the final USD number per provider for that specific date.

## 6. What happens next

I run the real CLI — nothing invented, nothing pre-decided (from `packages/print/`, matching
every other CLI's own cwd convention):

```bash
pnpm --filter @touchstone/print run reconcile <print-id> --openrouter=<usd> --anthropic=<usd> --openai=<usd> --google=<usd> --xai=<usd>
```

It reads the print's own already-signed `cost_of_production_usd` (never recomputed), sums what
you gave it, and checks the relative delta against a 2% tolerance:

- **Within 2%**: signs, anchors, and writes a real `ReconciliationRecord` to
  `data/reconciliations/<print_id>.json` — this print is now genuinely final.
- **Outside 2%**: prints a full report and writes nothing. The print stays provisional, honestly
  — same as every attempt so far. Nothing is lost by trying; a refusal is not a failure, it's the
  system working as designed.
