// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ClaimRouter} from "../src/ClaimRouter.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {EligibleClaimRouter} from "../src/EligibleClaimRouter.sol";
import {AguLabFixture} from "./fixtures/AguLabFixture.sol";

/**
 * R11 (docs/part5-build-plan.md §4.3): roll purchases skip issuers below the delivery floor, with
 * a way back. Test 6 of the owner's must-fail list is first; the router's own unit tests follow.
 *
 * The 0.8 floor itself, the trailing run of windows and "exactly 0.8 is eligible" are the
 * engine's published rule, computed off-chain from the gate-runner's outcomes; on-chain there is
 * only the flag the publisher sets from that rule. So "an issuer exactly at 0.8 is not skipped"
 * is tested in the TypeScript economy tests, and here as its consequence: an issuer with no flag
 * is chosen.
 */
contract EligibleClaimRouterTest is AguLabFixture {
    // ================================================================== test 6

    function test_rollSkipsIssuersBelowDeliveryFloor() public {
        // A front lot for the reserve, bought while nobody is flagged: it comes from issuerA,
        // registered first.
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        (address frontIssuer,,,,,,) = workClaim.claimTypes(front);
        assertEq(frontIssuer, issuerA, "sanity: with no flags, the first-registered issuer");

        ClaimRouter firstFit = new ClaimRouter(bond);
        vm.prank(publisher);
        router.setSkipped(issuerA, true);

        // Must fail on first-fit: the unchanged ClaimRouter still routes to the skipped issuer,
        // which has more headroom than it needs. If R11 were removed this is what route would do.
        assertGt(bond.headroom(issuerA, CLASS_SM), 1_000_000, "sanity: issuerA has headroom");
        assertEq(
            firstFit.route(CLASS_SM, 1000),
            issuerA,
            "R11 must fail on first-fit: the unchanged ClaimRouter routes to the skipped issuer"
        );
        assertEq(
            router.route(CLASS_SM, 1000),
            issuerB,
            "R11: route must never choose an issuer flagged below the delivery floor"
        );

        // A roll buys through the same router: the replacement comes from issuerB.
        vm.warp(_windowFrom(1) + 1 hours);
        uint256 aOutstanding = _outstanding(issuerA);
        _roll(_order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2));
        uint256 bought =
            workClaim.tokenIdFor(issuerB, CLASS_SM, SERIES_COMMODITY, _windowFrom(2), _windowTo(2));
        assertEq(lab.reserveBalance(bought), 1000, "R11: the roll must buy from issuerB");
        assertEq(_outstanding(issuerA), aOutstanding, "R11: a roll bought from a skipped issuer");

        // The way back: an open probe routes the probe lot to the skipped issuer, and only while
        // it is open.
        vm.prank(publisher);
        router.setProbe(issuerA, true);
        assertEq(router.route(CLASS_SM, 50), issuerA, "R11: an open probe must reach issuerA");
        uint256 probeLot = _buyClaims(participant, CLASS_SM, 50, 3);
        (address probeIssuer,,,,,,) = workClaim.claimTypes(probeLot);
        assertEq(probeIssuer, issuerA, "R11: the probe lot must go to the skipped issuer");
        vm.prank(publisher);
        router.setProbe(issuerA, false);
        assertEq(
            router.route(CLASS_SM, 50), issuerB, "R11: after its probe lot, skipped means skipped"
        );

        // Cleared: chosen again in registration order among the eligible.
        vm.prank(publisher);
        router.setSkipped(issuerA, false);
        assertEq(router.route(CLASS_SM, 50), issuerA, "R11: a cleared issuer must come back first");

        // Only the publisher can set or clear either flag.
        address[4] memory others = [aguIssuer, participant, issuerA, agent1];
        for (uint256 i = 0; i < others.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(EligibleClaimRouter.OnlyPublisher.selector, others[i])
            );
            vm.prank(others[i]);
            router.setSkipped(issuerB, true);
            vm.expectRevert(
                abi.encodeWithSelector(EligibleClaimRouter.OnlyPublisher.selector, others[i])
            );
            vm.prank(others[i]);
            router.setProbe(issuerA, true);
        }
    }

    function _outstanding(address issuer) internal view returns (uint256 outstanding) {
        (,,, outstanding,) = bond.lots(issuer, CLASS_SM);
    }

    // ================================================================== construction

    function test_constructor_setsImmutables() public view {
        assertEq(address(router.bond()), address(bond));
        assertEq(router.publisher(), publisher);
    }

    function test_constructor_revertsOnZeroBond() public {
        vm.expectRevert(EligibleClaimRouter.BondZero.selector);
        new EligibleClaimRouter(CapacityBond(address(0)), publisher);
    }

    function test_constructor_revertsOnZeroPublisher() public {
        vm.expectRevert(EligibleClaimRouter.PublisherZero.selector);
        new EligibleClaimRouter(bond, address(0));
    }

    // ================================================================== route

    /// With no flag set it is ClaimRouter, exactly: the same issuer for every amount, and the
    /// same refusal when nobody has the headroom.
    function testFuzz_route_withNoFlagsMatchesClaimRouter(uint256 amount) public {
        ClaimRouter firstFit = new ClaimRouter(bond);
        amount = bound(amount, 1, 12_000_000);
        // Use some of issuerA's headroom so a large amount genuinely falls through to issuerB.
        _buyClaims(agent1, CLASS_SM, 3_000_000, 1);

        try firstFit.route(CLASS_SM, amount) returns (address expected) {
            assertEq(router.route(CLASS_SM, amount), expected, "must equal ClaimRouter");
        } catch {
            vm.expectRevert(
                abi.encodeWithSelector(
                    EligibleClaimRouter.NoIssuerWithHeadroom.selector, CLASS_SM, amount
                )
            );
            router.route(CLASS_SM, amount);
        }
    }

    function test_route_skipsAnEligibleIssuerWithoutHeadroom() public {
        _buyClaims(agent1, CLASS_SM, 4_999_990, 1); // issuerA keeps 10 mSIU of headroom
        assertEq(router.route(CLASS_SM, 11), issuerB);
        assertEq(router.route(CLASS_SM, 10), issuerA);
    }

    function test_route_revertsWhenEveryIssuerIsSkipped() public {
        vm.startPrank(publisher);
        router.setSkipped(issuerA, true);
        router.setSkipped(issuerB, true);
        vm.stopPrank();
        vm.expectRevert(
            abi.encodeWithSelector(EligibleClaimRouter.NoIssuerWithHeadroom.selector, CLASS_SM, 1)
        );
        router.route(CLASS_SM, 1);
    }

    function test_route_probeWithoutHeadroomFallsThroughToTheEligible() public {
        _buyClaims(agent1, CLASS_SM, 4_999_990, 1); // issuerA keeps 10 mSIU of headroom
        vm.startPrank(publisher);
        router.setSkipped(issuerA, true);
        router.setProbe(issuerA, true);
        vm.stopPrank();
        assertEq(router.route(CLASS_SM, 10), issuerA, "the probe fits");
        assertEq(router.route(CLASS_SM, 11), issuerB, "the probe does not fit: eligible first-fit");
    }

    function test_route_probeTakesPrecedenceOverEligible() public {
        // Without precedence the probe lot would go to issuerB like every other mint, and a
        // skipped issuer could never earn its way back (R11's way back).
        vm.startPrank(publisher);
        router.setSkipped(issuerA, true);
        router.setProbe(issuerA, true);
        vm.stopPrank();
        assertEq(router.route(CLASS_SM, 1), issuerA);
    }

    function test_route_isPerClass() public {
        vm.prank(publisher);
        router.setSkipped(issuerA, true);
        assertEq(router.route(CLASS_SM, 1), issuerB);
        assertEq(router.route(CLASS_PL, 1), issuerB, "the flag is per issuer, across classes");
    }

    // ================================================================== flags

    function test_setSkipped_emitsAndCanBeCleared() public {
        vm.expectEmit(true, false, false, true, address(router));
        emit EligibleClaimRouter.SkippedSet(issuerA, true);
        vm.prank(publisher);
        router.setSkipped(issuerA, true);
        assertTrue(router.skipped(issuerA));

        vm.prank(publisher);
        router.setSkipped(issuerA, false);
        assertFalse(router.skipped(issuerA));
    }

    function test_setSkipped_revertsOnZeroIssuer() public {
        vm.expectRevert(EligibleClaimRouter.IssuerZero.selector);
        vm.prank(publisher);
        router.setSkipped(address(0), true);
    }

    function test_setProbe_requiresASkippedIssuer() public {
        vm.expectRevert(abi.encodeWithSelector(EligibleClaimRouter.NotSkipped.selector, issuerA));
        vm.prank(publisher);
        router.setProbe(issuerA, true);
    }

    function test_setProbe_closingIsAlwaysAllowed() public {
        vm.prank(publisher);
        router.setProbe(issuerA, false);
        assertFalse(router.probeOpen(issuerA));
    }

    /// Any change to an issuer's skipped flag closes its probe, so a probe opened during one
    /// spell of skipping can never reopen silently in the next.
    function test_setSkipped_closesAnOpenProbe() public {
        vm.startPrank(publisher);
        router.setSkipped(issuerA, true);
        router.setProbe(issuerA, true);
        router.setSkipped(issuerA, false);
        assertFalse(router.probeOpen(issuerA), "clearing must close the probe");
        router.setSkipped(issuerA, true);
        vm.stopPrank();
        assertEq(router.route(CLASS_SM, 1), issuerB, "skipped again with no probe open");
    }
}
