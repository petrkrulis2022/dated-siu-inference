# Findings about using Blockworks data through an agent (draft)

**Status: DRAFT, 2026-10-20, for the owner's review. Not sent.** A running list for the report that D101 and D105 promise Blockworks. It is **product-only** (D70): it names no token, currency or market of ours, and it holds no Blockworks data, only how the interfaces behave. Each finding says what was seen, where it is recorded, and whether it was seen on the live service or on our own stand-in server built from the published tool descriptions. New findings are added with their date and evidence; none is added without evidence.

## 1. Publication lag depends on the time of day (found 2026-10-19, live)

**Seen.** The same pull, at different hours, sees different "latest" days. Pulled at 14:22Z on 2026-10-17, the stablecoin series ended one day back and the asset-supply series reached the day itself. Pulled at about 06:30Z on the 18th and the 19th, the stablecoin series ended **two** days back and the asset-supply series ended one day back, with no point for the day. **Evidence:** three daily snapshots (stored, hash-recorded); `docs/marketplace_plan.md` D113.
On 2026-10-20 the same effect showed through the MCP: at 12:49Z it served stablecoin-by-issuer series that ended one day later than the Data API snapshot pulled at 06:19Z, for all 100 series compared, with the identifiers and the first points identical (plan D116).
**Why it matters.** An agent that asks for "the latest day" gets figures one or two days stale depending on the hour it asks, with no signal in the response about which. A task that names a calendar day can find the day missing.
**Suggest or ask.** The publication time of each dataset, or a "latest complete day" field in the catalog, so an agent can say which day its figures are as of.

## 2. `end` is exclusive on the Data API and inclusive on the Token Unlocks API (found 2026-10-17, live; the agent behaviour 2026-10-18, stand-in)

**Seen.** On the live Data API `start` is inclusive and `end` exclusive; the live Token Unlocks `endTime` is inclusive (31 calendar days give 31 snapshots). **Evidence:** D94. Whether the MCP reads `end` the same way is not confirmed live; our stand-in server follows the tool description, which says so. On that stand-in, with synthetic data, models asked for a quarter as 1 January to 31 March, which leaves out the last day, and the graded answer was wrong for that reason alone; one model fixed it with a second read once and not the next time. **Evidence:** D106 (dry runs 3 and 4, synthetic data, not a live observation).
**Why it matters.** An off-by-one on the last day of every window, silently, for any agent that reads "to 31 March" as including it.
**Suggest or ask.** State the rule in each tool description, or answer a window whose `end` is a bare calendar date with the whole day.

## 3. A read that names no `selections` returns every metric (found 2026-10-18, catalog live; cost measured on the stand-in)

**Seen.** The live catalog shows the perp volume model with 96 metrics per point, lending 10, the two stablecoin models 35 and 36, asset-supply 2, and a read that names no `selections` gets every one of them. **Evidence:** D106 (two live catalog calls). On our stand-in server, padded to those counts, an unselective volume read was about 40 times the bytes of a selective one, and a scripted agent that named no fields ended its session on the size of the conversation before it could answer. Every real model we ran named its `selections`, so the trap did not bite in practice.
**Why it matters.** The cost, in tokens, of forgetting one argument.
**Suggest or ask.** A small default set of metrics, or a warning in the tool description.

## 4. Rate limits are undocumented, and a 429 carries no hint (found 2026-10-17, live)

**Seen.** The Data API answered 429 after about 25 requests in 95 seconds at one a second, and again on the second of two requests six seconds apart. There was no `Retry-After` and no rate-limit headers, and the documentation states no limit; none is documented for Token Unlocks or the MCP either. The first full day took 77 requests, 20 of them 429, and about two hours at one request a minute. **Evidence:** D94, D100, D101.
**Why it matters.** An agent cannot pace itself, and a caller that slows down to be safe cannot know how slow is enough.
**Suggest or ask.** The limits per second, minute, hour and day for the Data API, Token Unlocks and the MCP, and whether a 429 is followed by a cool-down. (Question 11 in plan §16.12.)

## 5. Documentation and behaviour differ in places (found 2026-10-17, live)

**Seen.** A single-row lookup returns one object, not a list. An events window with no events is an empty list inside a data object, not `data: null`. A Token Unlocks schedule that starts after the token's projected end date is a 400. Some perp venues have a null `slug` and `projectID` (8 of 31), so only `id` is a safe key, and `id` is called both a "short name" and a "Project ID" in the documentation. **Evidence:** D94, plan §16.12 question 3.
**Suggest or ask.** Correct the pages, and say which identifier is stable (question 3).

## 5a. The MCP's tool descriptions and behaviour differ, and its results are not the Data API's body (found 2026-10-20, live)

**Seen.** The `timeseries_data` schema says "Series keys to read, at most 20". A call that names more than 10 is refused ("too many series requested: 20 exceeds the maximum of 10"), and a call that leaves out `series` is refused when it would return more than 20 (201 in our case). The model sent the same refused 20-series call five times in one turn before it changed anything. Separately, a `timeseries_data` result is `{model, granularity, point_schema, series, totalPoints}` and a `tabular_data` result is `{model, rows, totalRows, totalPages, page, pageSize}`: the same content the Data API returns inside a `data` wrapper, without it, so a parser written for one does not read the other. **Evidence:** the first live data session (plan D116), 22 tool calls.
**Suggest or ask.** State the real limit (10 named series) in the schema and the tool description, and say in the MCP's documentation that its results are not the Data API's body.

## 6. The MCP login (checked 2026-10-19 and 2026-10-20, live)

**Seen.** The server follows standard MCP OAuth (discovery, dynamic client registration, PKCE, refresh tokens). The one-time browser sign-in was on 2026-10-18; the stored login has since been renewed without anyone present three times (once on the 19th, when the access token was about 28 hours old, and twice on the 20th). **Evidence:** D105, D110, D114 and the daily check's log.
**Ask.** How long a refresh token stays valid, and whether there is a non-interactive credential for unattended runs. (Not yet in the §16.12 list; to be added.)
