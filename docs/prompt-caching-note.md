# Note: prompt caching for the Anthropic calls: deferred, with the conditions for doing it

*2026-10-13. Status: **deferred by the project owner's decision ("we wait")**. Nothing is built. This file records what was found so that the decision can be picked up without redoing the work.*

## 1. What prompted it

The Anthropic Console showed: *"Your prompt cache hit rate is low. Caching repeated content like system prompts could save Touchstone Assay up to 35% of its direct API spend."* It covers direct API traffic only.

## 2. Where it is done

In code, in each API request. **The Console has no switch for it**; it only reports an estimate. The guide is <https://platform.claude.com/docs/en/build-with-claude/prompt-caching> (read 2026-10-13; the first 100,000 of its 160,435 characters, which covered enabling, price, minimums, usage fields and invalidation).

## 3. What the guide says (as the page states it)

- **Enabling:** one top-level `cache_control: {"type": "ephemeral"}` on the request ("automatic caching"), or `cache_control` on individual content blocks (up to 4 breakpoints). Order of the cached prefix: tools, system, messages.
- **TTL and price (per million tokens):** 5-minute default, refreshed at no cost on each use; 1-hour option costs more. claude-sonnet-5: base $2, 5-minute write $2.50 (1.25×), read $0.20 (0.1×). claude-haiku-4-5: base $1, write $1.25, read $0.10.
- **Minimum cacheable prompt:** claude-sonnet-5 **1,024** tokens; claude-haiku-4-5 **4,096** tokens. Below the minimum nothing is cached and no error is returned.
- **Usage fields:** `cache_creation_input_tokens`, `cache_read_input_tokens`, and `input_tokens`, which **excludes** cached tokens. Total input = read + creation + `input_tokens`.
- **Invalidation:** a change to thinking parameters always invalidates the messages level; a hit needs a 100% identical prefix.
- **Output:** "Prompt caching has no effect on output token generation." Caching changes cost and latency, not the response.

## 4. How our code behaves today

`packages/harness/src/adapters/anthropic.ts` sends the whole prompt as one plain user message and **never sets `cache_control`**. A `cache_control: "disabled"` flag exists on the T2 task's parameters, but no adapter reads it. So today no Anthropic call is cached.

## 5. Where caching would and would not help

| Traffic | Helps? | Why |
|---|---|---|
| **Daily print** | **No, and it should stay off** | Every task prompt is different, so there is nothing repeated to reuse. Also `docs/methodology.md` (Cache policy) prices what a one-off buyer pays; caching would change what the print measures. |
| **Probe battery, sonnet** | **Yes** | Each distinct prompt is sent 12 or more times, and in the seeded random order repeats of one prompt fall within the 5-minute window. Rough estimate, **not measured:** input is about half of a sonnet call's cost, so a stage-1-sized run (about $9.8 of sonnet cost) could save about $3 to $4. |
| **Probe battery, haiku** | **No** | Its prompts are about 3,900 tokens, under the 4,096 minimum. |
| **Battery arm C (thinking on)** | Own cache only | Changing the thinking setting breaks sharing with arm A, so arm C caches separately. |
| **Lab market runs** | **Small** | Only the static prefix (brief plus tool list) repeats across turns, so the prompt would have to be split at a fixed point and marked with an explicit breakpoint. A few cents a run at most; haiku seats would not cache at all. |

The Console's "up to 35%" mostly reflects one large battery day ($11.89 for stage 1, against about $0.51 a day for the print). Going forward, the saving appears only if more sonnet-heavy batteries are run.

## 6. What building it would involve (more than two files, so it needs the owner's go)

1. **An opt-in setting in the Anthropic adapter**, e.g. a parameter read only by that adapter and set only by the battery and probe runners, **never by the print**. Same pattern as `omit_temperature` and `thinking`. Start with the automatic top-level form for the battery; add an explicit breakpoint for the market loop only if it proves worth it.
2. **A cost fix, which is the important part.** Our cost arithmetic (`callCostUsd` in `lab/battery-run.ts`, `realizedTurnCostUsd` in the lab budget, and so what the credit guard and the spend ledger see) counts `input_tokens` and `output_tokens` only. With caching on, `input_tokens` excludes cached tokens, so **spend would be under-counted** unless writes are priced at 1.25× and reads at 0.1×. The adapter must also report the cache tokens.
3. **Tests** for the request body, the usage mapping and the corrected cost, and a pilot of a few calls to confirm hits.
4. **A note in the plan** that this is an infrastructure change that alters cost and latency only, not what any agent sees or does.

## 7. When to revisit

- Another sonnet-heavy battery is planned (for example the second battery, §15 of `docs/marketplace_plan.md`, about $7 to $9 and sonnet-heavy), or
- sonnet seats start to dominate the market-run spend, or
- the Anthropic credit becomes tight.

**Stage 2 of the battery (haiku, arm C) would not benefit**, so it is not a reason to build this.

## 8. Do not

- Turn caching on for the daily print or any measured price path.
- Turn it on without the cost fix in §6.2: it would make the credit guard and the ledger read low.
