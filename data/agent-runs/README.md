# data/agent-runs/

Rich, unpublished per-transaction telemetry from the demo buyer/seller agents
(`packages/agents`) — one file per `AgentRunRecord`
(`packages/sdk/schemas/agent-run-record.schema.json`), named
`<run_id>-<role>.json`. Written by `packages/agents/src/agent-run-log.ts`'s
`logAgentRun`, from `handleInferCore` (seller) and `runBuyerDemo` (buyer) after
a real settlement.

**This is not a source of evidence for anything published.** It is git-tracked
for the same reason `data/runs/` is — so it isn't lost — but it plays no role
in computing a print, and `docs/methodology.md` §2's hierarchy of evidence
doesn't include it. The reason is structural, not a caveat: every record in
here comes from an agent Touchstone Assay itself controls, running a fixed
canned task against a small, hand-picked set of models. That makes it genuinely
useful for understanding workflow behaviour — retry rates, latency, routing
decisions on real infrastructure — and equally genuinely useless as evidence
about the market, since it says nothing about what independent buyers and
sellers actually do. Mistaking testbed telemetry here for measurement would be
exactly the kind of error the evidence hierarchy exists to rule out.

See `docs/positioning.md` §3 for why workflow-level measurement is a distinct
product from the published index in the first place.
