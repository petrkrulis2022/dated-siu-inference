import { setRevertRetryPolicy } from "./src/chain/write.js";

// Tests run against a local chain with one node and no lag, so a revert on simulation is the call's
// own and is wanted at once: the lag-tolerant retry in `writeAndConfirm` (eight tries, a second
// apart, for a load-balanced public node) would only add up to eight seconds to every test that
// asserts a revert. `chain/write.test.ts` sets its own policy and tests the retry itself.
setRevertRetryPolicy({ attempts: 0 });
