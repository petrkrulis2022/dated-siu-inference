/**
 * Which lab a run was made in. A change to what the lab IS — a rule an agent meets, a figure it is shown, a thing
 * the harness now refuses — makes a run before it a different instrument from a run after it, and the two are
 * never pooled (the gate configuration's reports carry the same kind of stamp). Bump the version and add a dated
 * line whenever such a change lands; `labDisqualification` excludes any run whose version is not this one.
 *
 * A change to how a run is MEASURED, or to the operator's side (the sweep, the report), is not one: it does not
 * alter what a trader meets.
 */
export const LAB_INSTRUMENT_VERSION = 2;

export const LAB_INSTRUMENT_CHANGES: readonly string[] = [
  "v1 2026-10-06: phase 1 as first built — T1 jobs, four traders, raw work from ISSUER-B, opening 2,000 mSIU and equal USDC, price parity with the dollar-route fee rebated.",
  "v2 2026-10-06: a quote may be paid only by the trader who asked for it, and once (lab/guards.ts). Before it a seller could pay its own quote by minting a claim for itself, and a quote could be paid twice by claim; found by the first model run, which therefore predates this and is not pooled.",
];
