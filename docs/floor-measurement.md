# Floor measurement session

_The last input blocking a publishable print: build1-spec.md §5's "cost-floor column" — GPU-seconds
per basket, measured on a rented reference configuration served with vLLM, multiplied by a rental
rate and divided by an assumed utilisation — which produces `print ÷ floor`, the market-spread
statistic (`CLAUDE.md`'s vocabulary). `packages/print`'s schema and computation already support a
floor value end to end (`PrintInput.floor`, `computePrint`); this document and
`scripts/measure-floor.ts` are the missing input: a real measurement, and the tooling to turn it
into a print-consumable record. **Never invent this figure.** If a step below wasn't really run,
the floor column stays absent — `scripts/measure-floor.ts` enforces the quality-gate half of that
itself; the rest is on the operator running the session honestly._

---

## What this session produces

A floor record — `data/registry/floor-record-<timestamp>.json` — capturing the reference GPU
configuration, the vLLM version, the model served, which quality gates passed, the measured
GPU-seconds per basket, the utilisation assumption, and the computed
`floor_usd_per_basket`. `packages/print/src/cli/compute.ts` accepts it directly via a new
`floor-record=<path>` argument.

## Prerequisites

- A reference GPU rate snapshot. If the existing one in `data/registry/gpu-rate-snapshot-*.json`
  is stale, refresh it first: `pnpm --filter @datum/prices run fetch:gpu-rates` (pulls real
  Akash and Vast.ai listings for the reference GPU, `NVIDIA H100 SXM 80GB`).
- Real API keys for whichever provider serves the reference model, if the harness needs them for
  anything besides the vLLM endpoint itself (it doesn't, here — vLLM needs no API key).

## Step 1 — rent the reference GPU

Rent one `NVIDIA H100 SXM 80GB` by the hour — Akash or Vast.ai, matching whichever source you'll
cite as the rate (`gpu-rate-snapshot`'s two sources). Record the exact listing/instance you rented;
it's what `--source` and the snapshot's matching entry will refer to.

## Step 2 — serve an open-weight model with vLLM

Start vLLM on the rented instance, serving an open-weight model that you expect to pass all three
of `@datum/basket`'s quality gates (T1/T2/T3 — see `docs/siu-worked-example.md`'s "Quality gates"
section for what passing looks like). Record vLLM's exact version:

```bash
vllm --version
```

Confirm the server is reachable and OpenAI-chat-completions-compatible (vLLM's default) before
continuing — `curl http://<host>:8000/v1/models` should list the served model.

## Step 3 — point the harness at it and run the basket

`@datum/harness`'s existing OpenAI-compatible adapter (`createOpenAiCompatibleAdapter`,
`packages/harness/src/adapters/openai-compatible.ts`) works against any OpenAI-chat-completions
endpoint, including a local vLLM server — it only needs a `chatCompletionsUrl`. Add a temporary
entry to `data/registry/models.json` (or a scratch copy pointed at by a temporary registry file)
whose `endpoint` is your vLLM server's `/v1/chat/completions` URL and whose `provider` maps to
the OpenAI-compatible adapter, using a `model_string` matching what you served. **Pick a `run_id`
now** — e.g. `floor-measurement-2026-08-17` — you'll need it for both timing (below) and
`scripts/measure-floor.ts --run-id`.

**Start the timer before invoking the harness, stop it after the run completes:**

```bash
date -u +%s   # start
pnpm --filter @datum/harness run run   # however your registry/run_id wiring invokes it
date -u +%s   # end
```

Since the GPU is exclusively rented for this session, wall-clock seconds elapsed _is_ the
GPU-seconds measurement — no FLOPs estimation, nothing modeled. `gpu-seconds = end - start`.
Divide by the number of full basket repetitions run in that window if you ran more than one, to
get GPU-seconds _per basket_.

Confirm `data/runs/<run_id>/` now has real run records (`gate_passed` set per instance by the
harness's own grading — `scripts/measure-floor.ts` reads this directly, it does not re-grade).

## Step 4 — build the floor record

```bash
pnpm run measure-floor -- \
  --run-id floor-measurement-2026-08-17 \
  --gpu-rate-snapshot data/registry/gpu-rate-snapshot-<latest>.json \
  --source vastai \
  --vllm-version 0.6.3 \
  --model <served-model-string> \
  --gpu-seconds 1800 \
  --utilisation 0.7 \
  --notes "H100 SXM 80GB, single instance, <listing/instance id>"
```

`--source` picks one entry from the GPU rate snapshot explicitly — never an average across
sources, so the rate used is always traceable to one real listing. `--utilisation` is your own
honest assumption about how much of the rented GPU-hour is doing useful basket work versus idle
between runs in a realistic deployment (build1-spec.md §5: "divided by an assumed utilisation");
state your reasoning for it in `--notes`.

**If any of T1/T2/T3 never passed, the script refuses to write a record at all** — printing which
class(es) failed and exiting non-zero. Serve a model that clears all three, or don't publish a
floor from this session.

## Step 5 — feed it into a print

```bash
pnpm --filter @datum/print run compute <print-id> [snapshot-file] floor-record=data/registry/floor-record-<timestamp>.json
```

`computePrint` (`packages/print/src/compute/index.ts`) sets `body.floor` and computes
`body.market_spread = dated_siu ÷ floor.value` only when a floor is supplied — omitting
`floor-record=...` leaves both columns absent exactly as before this tooling existed.

## What this deliberately doesn't automate

Renting a GPU and starting vLLM are real-world, operator-performed actions this tooling cannot
do for you — `scripts/measure-floor.ts` starts only after they're done, taking your measured
inputs and turning them into a validated, structured, print-consumable record. If a step above
wasn't genuinely run — no real rental, no real vLLM instance, no real basket run — there is no
honest floor to record, and the column stays absent. That absence is itself meaningful and
already how `computePrint` behaves without a `floor-record=...` argument.
