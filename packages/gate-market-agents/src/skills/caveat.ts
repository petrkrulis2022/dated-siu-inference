/**
 * Spec §1.1, "The caveat that goes on every output" — verbatim, character-for-character (the
 * blockquote's own text, confirmed programmatically against `docs/gate-market-spec.md`, the
 * same discipline WP-6 used for §8.5's asset description — see this package's own test for the
 * byte-diff, not eyeballed). One deliberate normalization: the spec's own blockquote wraps
 * "absent by construction" in markdown bold (`**...**`); this constant carries the plain prose,
 * not the markdown syntax — this text is meant to be embedded in a receipt/log's plain string
 * field, where literal asterisks would read as a rendering artifact, not emphasis, to anything
 * that doesn't render markdown. Confirmed byte-identical to the spec after stripping that one
 * markdown marker, not otherwise reworded.
 *
 * Pre-WP-7 fix, 2026-09-23: a precondition, not a convenience — "a caveat bolted on afterwards
 * is a caveat that was missing when the numbers were first read." `receipt/emit.ts` attaches
 * `MECHANISM_CAVEAT` directly, not as a parameter, so no `GateMarketReceipt` can exist without
 * it; `friction/log.ts` writes both constants into every run directory it ever appends to.
 */
export const MECHANISM_CAVEAT =
  "Both issuers in this run are backed by Touchstone's own API accounts. Issuer credit risk — " +
  "the thing that makes a work claim an instrument rather than a gift card — is absent by " +
  "construction. This run proves mechanism, not demand, and no result from it is evidence that a " +
  "third-party issuer would behave the same way.";

/** The F2-specific addendum — always carried alongside `MECHANISM_CAVEAT`, never presented
 * alone, since a reader seeing only the general caveat could still misread an F2 result as
 * testing credit-risk transfer. */
export const F2_CAVEAT =
  "And on F2 specifically: because both issuers are Touchstone-backed, a forward issued here " +
  "cannot default. HEDGER therefore tests price-risk transfer only, not credit-risk transfer, " +
  'which is the easier half. "The forward worked" must never be read as "the forward survives ' +
  'an issuer failing."';
