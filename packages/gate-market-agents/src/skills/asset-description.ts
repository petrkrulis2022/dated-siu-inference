/**
 * Spec §8.5's own words: "This paragraph is the most load-bearing text in the run. It appears
 * identically in every pack... Do not let this drift during implementation — it is the entire
 * validity of F1." Copied character-for-character from `docs/gate-market-spec.md` §8.5 — the
 * ONE place this text exists in this package. `pack/build.ts` embeds this constant verbatim,
 * never a retyped copy; `pack/validate.ts`'s drift check does a byte-for-byte substring match
 * against this same constant. Two call sites reading one constant is what makes drift
 * structurally impossible rather than merely discouraged.
 */
export const CANONICAL_ASSET_DESCRIPTION = `You hold two assets.

USDC is a dollar. 1 USDC = $1. It is accepted by every counterparty.

fSIU is a claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C, deliverable
during window W. It is accepted by counterparties that list it. It cannot
be redeemed before its window opens. Its dollar value moves with the
published price of work.

You may pay in either. Sellers state which they accept in their quotes.`;
