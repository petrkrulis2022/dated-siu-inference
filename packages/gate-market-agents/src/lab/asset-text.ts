/**
 * The asset paragraph a lab trader reads: the canonical text (`skills/asset-description.ts`) with exactly the sentences that
 * stopped being true of the lab replaced, and nothing else changed.
 *
 * The canonical text says of USDC: "Paid against a quote, it is held in escrow until the seller settles. A seller may settle
 * for less than it quoted, and whatever it does not claim returns to you." That is true of the gate configuration and was true
 * of the lab through instrument v3. From v4 every lab payment is a direct transfer (D30): nothing is held, there is nothing to
 * settle, and nothing returns. A paragraph that says otherwise, in the brief a trader weighs its assets by, is the defect the
 * validity rule exists to prevent — a sentence false of the run — so the lab states what is so.
 *
 * Derived from the canonical constant by one replacement that must match, so a change to the canonical text cannot silently
 * leave the lab with a stale copy: it throws when this module is loaded. The gate configuration keeps the canonical text.
 */
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";

/** The two sentences, as the canonical text has them, that the lab's settlement makes false. */
export const ESCROW_SENTENCES = `Paid against a quote, it is held in escrow
until the seller settles. A seller may settle for less than it quoted, and
whatever it does not claim returns to you. Its dollar value never moves.`;

/** What is so of the lab instead. */
export const DIRECT_SENTENCE = `Paid against a quote, it reaches the seller
at once. Its dollar value never moves.`;

function labAssetDescription(): string {
  if (!CANONICAL_ASSET_DESCRIPTION.includes(ESCROW_SENTENCES)) {
    throw new Error("lab asset text: the canonical asset description no longer contains the escrow sentences this replaces");
  }
  return CANONICAL_ASSET_DESCRIPTION.replace(ESCROW_SENTENCES, DIRECT_SENTENCE);
}

export const LAB_ASSET_DESCRIPTION: string = labAssetDescription();
