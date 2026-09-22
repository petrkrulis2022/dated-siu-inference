// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CapacityBond} from "./CapacityBond.sol";

/**
 * @title ClaimRouter
 * @notice Picks an issuer with headroom for a mint — the buyer never chooses. Gate Market testbed
 *         WP-2 (docs/gate-market-spec.md §5.3: "Given a class and quantity, selects an issuer
 *         with headroom. Holder never picks.").
 *
 * ## Scoping decision, stated plainly
 *
 * The spec's own §6.1 describes claims as fungible *across issuers* within one (class, window) —
 * one ERC-1155 token id shared by every issuer backing it — with routing happening at
 * *redemption* time instead: a holder presents a claim and whichever issuer currently has
 * headroom serves it.
 *
 * That requires the contract to attribute a shared pool's outstanding supply back to individual
 * issuers proportionally when the pool only partially defaults — genuinely unresolved even in the
 * spec (§7.4 flags default correlation as an open question; nothing states how a shared pool's
 * liability splits when it doesn't uniformly default). Solving that correctly needs real design
 * work, not an improvised proportional-attribution rule written directly into a contract holding
 * bonded USDC.
 *
 * This build routes at **mint** time instead: each WorkClaim token id is scoped to a single
 * issuer (`keccak256(issuer, classId, windowFrom, windowTo)`), so "the holder never picks" is
 * satisfied here — the buyer specifies class, quantity and window; this contract picks which
 * issuer's lot the mint draws from — and every claim's default/expire liability is
 * unambiguously one issuer's alone. The cost: claims from different issuers for the same
 * (class, window) are not the same fungible token id. Worth reopening once the proportional-
 * attribution question above has a real answer, not before.
 */
contract ClaimRouter {
    CapacityBond public immutable bond;

    error BondZero();
    error NoIssuerWithHeadroom(bytes32 classId, uint256 amount);

    constructor(CapacityBond bond_) {
        if (address(bond_) == address(0)) revert BondZero();
        bond = bond_;
    }

    /**
     * @notice Returns an issuer with at least `amount` headroom in `classId`.
     * @dev Deterministic given on-chain state: first issuer (by registration order —
     *      `CapacityBond.issuersForClass`) with sufficient headroom. Not "best price" or
     *      "most headroom" — a simple, auditable rule is preferable to an optimisation the buyer
     *      has no way to independently verify anyway, and the property this exists to guarantee
     *      is "the buyer didn't choose", not "the buyer got the optimal issuer".
     */
    function route(bytes32 classId, uint256 amount) external view returns (address issuer) {
        address[] memory candidates = bond.issuersForClass(classId);
        for (uint256 i = 0; i < candidates.length; i++) {
            if (bond.headroom(candidates[i], classId) >= amount) {
                return candidates[i];
            }
        }
        revert NoIssuerWithHeadroom(classId, amount);
    }
}
