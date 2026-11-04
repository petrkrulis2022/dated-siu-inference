// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CapacityBond} from "./CapacityBond.sol";

/**
 * @title EligibleClaimRouter
 * @notice First-fit routing that skips issuers below the delivery floor, with a way back. The CR
 *         economy's rule R11 (docs/part5-build-plan.md §4.3), a new contract beside ClaimRouter,
 *         which is not changed.
 *
 * ## Why it exists
 *
 * ClaimRouter is first-fit over registration order, and CapacityBond can never remove an issuer,
 * so every mint goes to the earliest-registered issuer with headroom whether or not it delivers
 * (the append-only routing finding, docs/fsiu-design.md §5.3c). In the CR economy one issuer
 * fails a published share of its work on purpose, so first-fit would keep sending the reserve's
 * roll purchases to an issuer the economy already knows does not deliver. R11 follows the
 * owner's C5: skip any issuer whose delivery ratio is below 0.8.
 *
 * ## What is on-chain and what is not
 *
 * The delivery ratio, its trailing run of windows and the 0.8 floor (exactly 0.8 is eligible) are
 * a published rule over the gate-runner's executed outcomes, computed off-chain in exact decimals
 * so anyone can recompute it. On-chain there is only its result: a `skipped` flag per issuer that
 * one immutable address, `publisher` (the CR lab key), sets and clears by that rule. The router
 * holds no funds, has no owner, and the publisher can do exactly two things: set or clear an
 * issuer's `skipped` flag, and open or close its probe. Neither moves money, and neither can send
 * a mint to an issuer that lacks the headroom for it.
 *
 * ## The way back: the probe
 *
 * A skipped issuer receives no new claims, so it would never have a new ratio to improve. While a
 * probe is open for a skipped issuer, `route` returns that issuer (if it has the headroom),
 * ahead of the eligible ones, so the harness can mint its one probe lot. The publisher then
 * closes the probe. The closing is a separate call because `route` is a view: WorkClaim calls it
 * through ClaimRouter's `view` signature (a STATICCALL), so it cannot latch "the probe lot has
 * been minted" itself. "One probe lot per skipped issuer" is therefore the harness's discipline
 * (open, mint, close, with no other mint in between), stated here rather than implied.
 * Any change to an issuer's `skipped` flag also closes its probe, so a probe left open in one
 * spell of skipping can never reopen silently in the next.
 *
 * ## It routes by class, never by grade
 *
 * Like ClaimRouter, it sees only `classId` and the issuers CapacityBond lists for it. A claim's
 * series (Commodity or Frontier) is chosen by whoever calls `WorkClaim.mint`, so this router
 * cannot keep a Commodity claim off a Frontier issuer; the CR deployment does that by giving the
 * Frontier issuer lots in CR-VS only (see AguLab.sol's note on grade labels).
 *
 * ## One router for every mint (a deviation from the plan, recorded)
 *
 * The plan's risk 4 kept agent purchases on the unchanged ClaimRouter and used this router for
 * the roll only. But a WorkClaim has exactly one immutable router for every mint, so the CR
 * WorkClaim is built with this one and every mint goes through it. With no flag set it behaves
 * exactly like ClaimRouter: the same candidates, the same order, the same headroom test, the same
 * refusal (EligibleClaimRouter.t.sol fuzzes that equivalence). Among eligible issuers it is still
 * first-fit, so purchases still concentrate in registration order (the plan's risk 4 says so).
 */
contract EligibleClaimRouter {
    CapacityBond public immutable bond;

    /// @notice The CR lab key: the only address that may set or clear a flag. Immutable, so the
    ///         rule's author cannot be changed after deployment (rotation means a new router,
    ///         and a new WorkClaim to use it).
    address public immutable publisher;

    /// @notice True while an issuer's delivery ratio is below the floor by the published rule.
    mapping(address issuer => bool) public skipped;

    /// @notice True while a skipped issuer may receive its probe lot.
    mapping(address issuer => bool) public probeOpen;

    event SkippedSet(address indexed issuer, bool skipped);
    event ProbeSet(address indexed issuer, bool open);

    error BondZero();
    error PublisherZero();
    error IssuerZero();
    error OnlyPublisher(address caller);
    /// @notice A probe is the way back for a skipped issuer; for anyone else it means nothing.
    error NotSkipped(address issuer);
    /// @dev Same name and arguments as ClaimRouter's, so off-chain decoders read both alike.
    error NoIssuerWithHeadroom(bytes32 classId, uint256 amount);

    constructor(CapacityBond bond_, address publisher_) {
        if (address(bond_) == address(0)) revert BondZero();
        if (publisher_ == address(0)) revert PublisherZero();
        bond = bond_;
        publisher = publisher_;
    }

    modifier onlyPublisher() {
        _checkPublisher();
        _;
    }

    function _checkPublisher() internal view {
        if (msg.sender != publisher) revert OnlyPublisher(msg.sender);
    }

    /// @notice Sets or clears `issuer`'s skipped flag, by the published delivery rule. Closes any
    ///         open probe for it either way.
    function setSkipped(address issuer, bool skipped_) external onlyPublisher {
        if (issuer == address(0)) revert IssuerZero();
        skipped[issuer] = skipped_;
        emit SkippedSet(issuer, skipped_);
        if (probeOpen[issuer]) {
            probeOpen[issuer] = false;
            emit ProbeSet(issuer, false);
        }
    }

    /// @notice Opens (only for a skipped issuer) or closes `issuer`'s probe.
    function setProbe(address issuer, bool open) external onlyPublisher {
        if (open && !skipped[issuer]) revert NotSkipped(issuer);
        probeOpen[issuer] = open;
        emit ProbeSet(issuer, open);
    }

    /**
     * @notice Returns an issuer with at least `amount` headroom in `classId`: a skipped issuer
     *         with an open probe first, otherwise the first eligible issuer by registration order.
     * @dev The same signature as ClaimRouter.route, so a WorkClaim can be built with this router
     *      in ClaimRouter's place. The probe pass comes first because otherwise the probe lot
     *      would go to the first eligible issuer like any other mint, and the way back would never
     *      open.
     */
    function route(bytes32 classId, uint256 amount) external view returns (address) {
        address[] memory candidates = bond.issuersForClass(classId);
        for (uint256 i = 0; i < candidates.length; i++) {
            address c = candidates[i];
            if (skipped[c] && probeOpen[c] && bond.headroom(c, classId) >= amount) return c;
        }
        for (uint256 i = 0; i < candidates.length; i++) {
            address c = candidates[i];
            if (!skipped[c] && bond.headroom(c, classId) >= amount) return c;
        }
        revert NoIssuerWithHeadroom(classId, amount);
    }
}
