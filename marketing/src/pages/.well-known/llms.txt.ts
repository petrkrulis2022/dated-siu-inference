// Mirrors /llms.txt at the well-known path some agents check by convention instead of (or as
// well as) the root path. Re-exports the same handler rather than duplicating it, so the two
// routes can never drift from each other the way this project's site/ (prints.touchstoneassay.com)
// and marketing/ (touchstoneassay.com) copies already had to caveat by hand.
export { GET, prerender } from "../llms.txt";
