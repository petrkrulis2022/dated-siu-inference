/**
 * Spec §8.5's own words: "This paragraph is the most load-bearing text in the run. It appears
 * identically in every pack... Do not let this drift during implementation — it is the entire
 * validity of F1." Copied character-for-character from `docs/gate-market-spec.md` §8.5 — the
 * ONE place this text exists in this package. `pack/build.ts` embeds this constant verbatim,
 * never a retyped copy; `pack/validate.ts`'s drift check does a byte-for-byte substring match
 * against this same constant. Two call sites reading one constant is what makes drift
 * structurally impossible rather than merely discouraged.
 */
/**
 * REWRITTEN 2026-10-04 (single-issuer instrument, W1c), by decision of the operator, and the old
 * text is kept in `docs/gate-market-spec.md` §8.5's change note rather than here.
 *
 * Two sentences of the original were false of the run, which is the defect the rewrite exists to
 * remove (§4.6-RULE):
 *   - "Sellers state which they accept in their quotes." The quote format permits exactly one
 *     settlement entry and it must be USDC (build 1), so a quote states nothing about fSIU.
 *     Every quote can in fact be settled in either asset, or partly in each, since 2026-10-04.
 *   - "It is accepted by counterparties that list it." Nothing is listed; acceptance is not a
 *     seller's choice.
 * It also now says the three mechanics that are true in EVERY window and that a holder decides
 * on: redeemable from the issuer NAMED ON THE CLAIM, recoverable from that issuer's bond if a
 * presented claim is not delivered, and expiry when the window closes. It deliberately does not
 * say WHICH issuer will serve or fail — that is the very thing this instrument varies.
 *
 * Symmetry: the two paragraphs mirror each other sentence for sentence (what it is, who accepts
 * it, how it settles, when it ends, whether its dollar value moves) and USDC and fSIU appear the
 * same number of times. Length is 294 vs 424 characters, 1.44x, against about 5x before; the gap
 * is genuine mechanics fSIU has and USDC lacks, and closing it would mean dropping a true fact or
 * padding USDC with filler. The test bounds it so it cannot drift back.
 */
export const CANONICAL_ASSET_DESCRIPTION = `You hold two assets.

USDC is a dollar. 1 USDC = $1. Every counterparty accepts it, and it has
no window and does not expire. Paid against a quote, it is held in escrow
until the seller settles. A seller may settle for less than it quoted, and
whatever it does not claim returns to you. Its dollar value never moves.

fSIU is a dated claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C from the
issuer named on the claim, during window W. A presented claim that the
issuer does not deliver can be settled against its bond once the window
closes. It cannot be redeemed before the window opens, and expires when it
closes. Its dollar value moves with the published price of work.

Any quote can be settled in either, or partly in each.`;
