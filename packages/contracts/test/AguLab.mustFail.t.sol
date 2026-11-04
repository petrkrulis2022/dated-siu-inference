// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Vm} from "forge-std/Test.sol";
import {AguLab} from "../src/AguLab.sol";
import {AguBuffer} from "../src/AguBuffer.sol";
import {RateAttestationVerifier} from "../src/RateAttestationVerifier.sol";
import {StickyUSDC} from "./mocks/StickyUSDC.sol";
import {AguLabFixture} from "./fixtures/AguLabFixture.sol";

/**
 * The owner's must-fail-loudly tests for AGU-lab (docs/part5-build-plan.md §5, tests 1, 2, 4, 5
 * and the contract half of 7; test 6 is in EligibleClaimRouter.t.sol, and test 3, the
 * participant's cap and its own USDC, is engine-level). Each is named for what must never happen,
 * and each assertion message names the rule it guards, so a failure reads as the broken rule.
 *
 * Written before AguLab.sol, as the specification it had to meet.
 */
contract AguLabMustFailTest is AguLabFixture {
    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    // ------------------------------------------------------------------ helpers

    /// Redeems `units` as `who` and fails loudly if any dollar moved: no USDC Transfer event of
    /// any kind during the call, and the reserve's, the redeemer's and the buffer's USDC exactly
    /// where they were. Balance checks alone would miss a transfer out and back; the log scan
    /// would not.
    function _redeemChecked(address who, uint256 units)
        internal
        returns (uint256[] memory ids, uint256[] memory amounts)
    {
        uint256 labUsdc = usdc.balanceOf(address(lab));
        uint256 whoUsdc = usdc.balanceOf(who);
        uint256 bufferUsdc = usdc.balanceOf(address(buffer));

        vm.recordLogs();
        vm.prank(who);
        (ids, amounts) = lab.redeem(units);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].emitter != address(usdc),
                "R4: a redemption moved USDC. It pays claims in kind and never dollars"
            );
        }
        assertEq(
            usdc.balanceOf(address(lab)), labUsdc, "R4: a redemption changed the reserve's USDC"
        );
        assertEq(usdc.balanceOf(who), whoUsdc, "R4: a redemption paid the redeemer USDC");
        assertEq(
            usdc.balanceOf(address(buffer)),
            bufferUsdc,
            "R4/test 4: a redemption touched the buffer"
        );
    }

    /// Redeems `bps` of `who`'s units when that delivers at least one claim; dust that would
    /// deliver nothing is refused by the contract and skipped here.
    function _redeemSome(address who, uint256 bps) internal {
        uint256 units = (lab.balanceOf(who) * bps) / 10_000;
        if (units == 0) return;
        (, uint256[] memory amounts,) = lab.previewRedeem(units);
        if (amounts.length == 0) return;
        _redeemChecked(who, units);
    }

    function _donate(uint256 amount) internal {
        usdc.mint(stranger, amount);
        vm.prank(stranger);
        usdc.transfer(address(lab), amount);
    }

    // ================================================================== test 1

    /// R4: a redemption pays claims only. Across creations, a roll, a default elsewhere in the
    /// claims market and unsolicited USDC sitting in the reserve, no redemption moves a dollar.
    function test_redemptionNeverPaysReserveUsdc(
        uint256 face,
        uint256 donation,
        uint256 redeemBps,
        bool doRoll,
        bool doDefault
    ) public {
        face = bound(face, 10, 200_000);
        donation = bound(donation, 0, 1e9);
        redeemBps = bound(redeemBps, 1, 10_000);
        // Generous, so the roll can restore the full face whatever `face` is.
        _seedBuffer(1e10);

        _createFresh(CLASS_SM, face, 1);
        _createFresh(CLASS_PL, face / 2 + 1, 2);
        _giveUnits(holder, lab.balanceOf(participant) / 2);

        if (donation > 0) _donate(donation);
        _redeemSome(holder, redeemBps);

        uint256 defaultedClaim;
        if (doDefault) {
            // A claim of agent2's, presented and never served: it defaults at window close and
            // the issuer's bond pays agent2. It is not the reserve's, and must not reach it.
            defaultedClaim = _buyClaims(agent2, CLASS_SM, 500, 1);
            vm.warp(_windowFrom(1) + 1 hours);
            vm.prank(agent2);
            workClaim.presentForRedemption(defaultedClaim, keccak256("task"));
        }

        if (doRoll) {
            vm.warp(_windowFrom(1) + 2 hours);
            _roll(_planRoll(agent1, 5_000, CLASS_SM, 2));
            assertEq(usdc.balanceOf(address(lab)), 0, "R5: the roll ended holding USDC");
            _redeemSome(holder, redeemBps);
        }

        vm.warp(_windowTo(1) + 1);
        if (doDefault) {
            RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
            bytes memory sig = _sign(address(workClaim), att);
            workClaim.settleWindowClose(defaultedClaim, agent2, att, sig);
        }
        _redeemSome(participant, 10_000);
        _redeemSome(holder, 10_000);
    }

    // ================================================================== test 2

    /// R5/Q11: the reserve holds no USDC outside the roll step. Creation and redemption never
    /// leave any; an unsolicited transfer sits untouched through a redemption (never paid out)
    /// and the next roll spends it on claims before the buffer pays anything.
    function test_reserveHoldsNoUsdcOutsideTheRollStep() public {
        (uint256 front, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        assertEq(usdc.balanceOf(address(lab)), 0, "Q11: the reserve held USDC after a creation");

        _giveUnits(holder, units / 4);
        _redeemChecked(holder, units / 4);
        assertEq(usdc.balanceOf(address(lab)), 0, "Q11: the reserve held USDC after a redemption");

        _donate(1_000);
        _redeemChecked(participant, units / 4);
        assertEq(
            usdc.balanceOf(address(lab)),
            1_000,
            "R4: a redemption paid out unsolicited USDC sitting in the reserve"
        );

        vm.warp(_windowFrom(1) + 1 hours);
        uint256 bufferBefore = usdc.balanceOf(address(buffer));
        uint256 face = lab.reserveBalance(front);
        RollSummary memory s =
            _roll(_order(_ids(front), _sale(agent1, front, face / 2), _buy(CLASS_SM, face), 2));

        assertEq(usdc.balanceOf(address(lab)), 0, "R5: the roll must end at exactly zero USDC");
        assertEq(s.stray, 1_000, "R5: the roll did not count the stray USDC as roll funds");
        assertEq(
            s.cover,
            s.cost - s.proceeds - 1_000,
            "R5: stray USDC must go into claims before the buffer pays any cover"
        );
        assertEq(
            bufferBefore - usdc.balanceOf(address(buffer)),
            s.cover,
            "R6: the buffer paid other than the cover"
        );
        assertEq(s.faceBought, face, "R5: the roll did not restore the face it retired");
    }

    /// R5/Q11, the last line: a roll that would end holding USDC reverts. With a well-behaved
    /// dollar no input reaches this (the roll computes every outflow), so a dollar whose transfer
    /// to the income ledger silently moves nothing stands in for the bug the check exists for.
    function test_reserveHoldsNoUsdcOutsideTheRollStep_rollEndingWithUsdcReverts() public {
        StickyUSDC sticky = new StickyUSDC();
        _deploy(sticky, DISCOUNT_BPS, BUFFER_TARGET);
        _fund();
        sticky.setSticky(incomeLedger);

        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        _donate(100_000);
        vm.warp(_windowFrom(1) + 1 hours);

        // Funds 100,000 + proceeds; the cost of 1,000 mSIU; the buffer takes 30,000 to reach its
        // target and the rest is carry for the income ledger, which the sticky dollar keeps.
        uint256 proceeds = _salePrice(500);
        uint256 carry = 100_000 + proceeds - _cost(1000);
        uint256 toIncome = carry - (BUFFER_TARGET - BUFFER_SEED);
        _rollExpectRevert(
            _order(_ids(front), _sale(agent1, front, 500), _buy(CLASS_SM, 1000), 2),
            abi.encodeWithSelector(AguLab.ReserveUsdcNotZero.selector, toIncome)
        );
    }

    // ================================================================== test 4

    /// The buffer is never paid out on a redemption; its only outflow is a roll's shortfall
    /// cover, and only AguLab, only inside a roll, can draw it.
    function test_bufferNeverPaidOnRedemption() public {
        (, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        _createFresh(CLASS_PL, 700, 2);
        uint256 all = lab.balanceOf(participant);
        _giveUnits(holder, all / 3);
        _giveUnits(agent2, all / 3);

        uint256 bufferBefore = usdc.balanceOf(address(buffer));
        _redeemChecked(holder, lab.balanceOf(holder) / 2);
        _redeemChecked(agent2, lab.balanceOf(agent2));
        _redeemChecked(holder, lab.balanceOf(holder));
        _redeemChecked(participant, lab.balanceOf(participant));
        assertEq(lab.totalSupply(), 0, "sanity: the whole supply was redeemed");
        assertEq(
            usdc.balanceOf(address(buffer)),
            bufferBefore,
            "test 4: the buffer moved while the whole supply was redeemed"
        );

        // Its one outflow: a roll's shortfall cover, to the reserve, of exactly the cover amount.
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        RollSummary memory s =
            _roll(_order(_ids(front), _sale(agent1, front, 400), _buy(CLASS_SM, 1000), 2));
        assertGt(s.cover, 0, "sanity: this roll had a shortfall");
        assertEq(
            bufferBefore - usdc.balanceOf(address(buffer)),
            s.cover,
            "test 4: the buffer's only outflow must be the roll's cover"
        );

        // Nobody else can draw it, and AguLab itself cannot outside a roll.
        address[5] memory callers = [holder, participant, aguIssuer, publisher, address(lab)];
        for (uint256 i = 0; i < callers.length; i++) {
            if (callers[i] == address(lab)) {
                vm.expectRevert(AguBuffer.NotInsideRoll.selector);
            } else {
                vm.expectRevert(abi.encodeWithSelector(AguBuffer.OnlyAguLab.selector, callers[i]));
            }
            vm.prank(callers[i]);
            buffer.cover(1);
        }
        units;
    }

    // ================================================================== test 5

    /// R6: a roll shortfall is paid by the buffer first; when the buffer cannot pay, the reserve
    /// buys less and NAV falls. The participant, the agents who are not buying and the income
    /// ledger never pay into it, and no redemption waits on it.
    function test_rollShortfallOnlyFromBufferThenNav() public {
        (uint256 lot1, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        _giveUnits(holder, units / 2);

        uint256 participantUsdc = usdc.balanceOf(participant);
        uint256 incomeUsdc = usdc.balanceOf(incomeLedger);
        uint256 agent2Usdc = usdc.balanceOf(agent2);
        uint256 holderUsdc = usdc.balanceOf(holder);

        // Roll 1, in window 1: 600 of 1,000 sold, so the buffer pays the rest of the replacement.
        vm.warp(_windowFrom(1) + 1 hours);
        uint256 agent1Usdc = usdc.balanceOf(agent1);
        RollSummary memory s =
            _roll(_order(_ids(lot1), _sale(agent1, lot1, 600), _buy(CLASS_SM, 1000), 2));
        assertEq(s.proceeds, _salePrice(600), "sanity: proceeds at the posted price");
        assertEq(s.cover, _cost(1000) - _salePrice(600), "R6: the buffer must pay the shortfall");
        assertEq(lab.liveFaceMilli(), 1000, "R6: with the buffer able to pay, face is restored");
        assertEq(
            agent1Usdc - usdc.balanceOf(agent1),
            s.proceeds,
            "R5: the sale buyer pays the posted price and nothing else"
        );

        // The participant, the income ledger and an idle agent can never be made to pay.
        uint256 lot2 = _onlyLiveLot();
        vm.warp(_windowFrom(2) + 1 hours);
        address[4] memory barred = [participant, incomeLedger, address(buffer), aguIssuer];
        for (uint256 i = 0; i < barred.length; i++) {
            _rollExpectRevert(
                _order(_ids(lot2), _sale(barred[i], lot2, 100), _buy(CLASS_SM, 1000), 3),
                abi.encodeWithSelector(AguLab.IneligibleBuyer.selector, barred[i])
            );
        }
        // Nor may the reserve buy less than it retired while the buffer could still pay.
        _rollExpectPartialRevert(
            _order(_ids(lot2), _noSales(), _buy(CLASS_SM, 999), 3), AguLab.RollUnderbuys.selector
        );

        // Roll 2, in window 2: nothing sells; the buffer still covers the whole replacement.
        s = _roll(_order(_ids(lot2), _noSales(), _buy(CLASS_SM, 1000), 3));
        assertEq(s.cover, _cost(1000), "R6: the buffer must pay before NAV falls");
        assertEq(lab.liveFaceMilli(), 1000, "R6: NAV must not fall while the buffer can pay");

        // Roll 3, in window 3: the buffer cannot pay for it all, so the reserve buys the most
        // face the buffer can pay for and NAV falls.
        uint256 lot3 = _onlyLiveLot();
        vm.warp(_windowFrom(3) + 1 hours);
        uint256 bufferLeft = usdc.balanceOf(address(buffer));
        assertLt(bufferLeft, _cost(1000), "sanity: the buffer can no longer pay in full");
        uint256 affordable = ((bufferLeft + 1) * 1_000_000 - 1) / RATE;

        _redeemSameBlock(holder, units / 8);
        s = _roll(_order(_ids(lot3), _noSales(), _buy(CLASS_SM, affordable), 4));
        _redeemSameBlock(holder, units / 8);

        assertEq(s.faceBought, affordable, "R6: the reserve must buy the most face it can");
        assertLt(s.faceBought, s.faceUnsold, "sanity: face fell short");
        assertEq(s.cover, _cost(affordable), "R6: every dollar of cover came from the buffer");
        assertLt(
            usdc.balanceOf(address(buffer)),
            _cost(affordable + 1) - _cost(affordable),
            "R6: the buffer was left able to pay for one more mSIU"
        );
        assertLt(lab.navWad(), 1e18, "R6: when the buffer is empty, NAV falls");

        assertEq(
            usdc.balanceOf(participant), participantUsdc, "R6: participant USDC filled a roll gap"
        );
        assertEq(usdc.balanceOf(incomeLedger), incomeUsdc, "R6: the income ledger paid cover");
        assertEq(usdc.balanceOf(agent2), agent2Usdc, "R6: an agent who bought nothing paid cover");
        assertEq(usdc.balanceOf(holder), holderUsdc, "R6: a holder paid cover");
    }

    function _onlyLiveLot() internal view returns (uint256 id) {
        uint256[] memory ids = lab.lotIds();
        uint256 n;
        for (uint256 i = 0; i < ids.length; i++) {
            if (lab.isLive(ids[i])) {
                id = ids[i];
                n++;
            }
        }
        require(n == 1, "expected exactly one live lot");
    }

    /// R4: never paused or delayed, including around a roll. Same block as the roll, before and
    /// after it, a redemption goes through.
    function _redeemSameBlock(address who, uint256 units) internal {
        vm.prank(who);
        lab.redeem(units);
    }

    function _rollExpectPartialRevert(AguLab.RollOrder memory order, bytes4 selector) internal {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        vm.expectPartialRevert(selector);
        vm.prank(aguIssuer);
        lab.roll(order, att, labSig, claimSig);
    }

    // ================================================================== test 7 (contract half)

    /// R12: a redemption's `Redeemed` event names every lot the holder receives, with its amount
    /// and its window end, so the engine can put each deadline on the holder's board (the
    /// engine half of test 7 is in the TypeScript economy tests). A lot the holder does not
    /// receive, such as a front lot the roll has retired, is not named.
    function test_inKindRedemptionRaisesTheDeadlineWarning() public {
        (uint256 retired, uint256[3] memory live, uint256 redeemUnits) = _threeLiveLotsAndARetired();
        uint256 supply = lab.totalSupply();
        uint256[3] memory expected;
        for (uint256 i = 0; i < 3; i++) {
            expected[i] = (redeemUnits * lab.reserveBalance(live[i])) / supply;
        }

        vm.recordLogs();
        vm.prank(holder);
        lab.redeem(redeemUnits);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256[] memory ids, uint256[] memory amounts, uint64[] memory windowTos) =
            _redeemedFrom(logs, holder, redeemUnits);
        assertEq(ids.length, 3, "R12: Redeemed must name every lot delivered, and only those");
        for (uint256 i = 0; i < 3; i++) {
            _assertNamed(ids, amounts, windowTos, live[i], expected[i]);
        }
        assertEq(workClaim.balanceOf(holder, retired), 0, "R4: a retired front lot was delivered");
    }

    /// Three live lots in two task classes and three windows, one of them bought by a roll, plus
    /// the front lot that roll retired; the holder is given a third of the first creation's units.
    function _threeLiveLotsAndARetired()
        internal
        returns (uint256 retired, uint256[3] memory live, uint256 redeemUnits)
    {
        uint256 units;
        (retired, units) = _createFresh(CLASS_SM, 1000, 1);
        (live[0],) = _createFresh(CLASS_PL, 500, 2);
        (live[1],) = _createFresh(CLASS_SM, 300, 3);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(retired), _noSales(), _buy(CLASS_SM, 1000), 2));
        live[2] =
            workClaim.tokenIdFor(issuerA, CLASS_SM, SERIES_COMMODITY, _windowFrom(2), _windowTo(2));
        assertEq(lab.reserveBalance(live[2]), 1000, "sanity: the roll bought window 2");
        redeemUnits = units / 3;
        _giveUnits(holder, redeemUnits);
    }

    function _assertNamed(
        uint256[] memory ids,
        uint256[] memory amounts,
        uint64[] memory windowTos,
        uint256 lot,
        uint256 expected
    ) internal view {
        uint256 j = _indexOf(ids, lot);
        assertEq(amounts[j], expected, "R12: Redeemed must carry each lot's amount");
        assertEq(
            amounts[j],
            workClaim.balanceOf(holder, lot),
            "R12: Redeemed's amount must equal what the holder received"
        );
        (,,,, uint64 windowTo,,) = workClaim.claimTypes(lot);
        assertEq(windowTos[j], windowTo, "R12: Redeemed must carry each lot's deadline");
    }

    function _redeemedFrom(Vm.Log[] memory logs, address who, uint256 units)
        internal
        view
        returns (uint256[] memory ids, uint256[] memory amounts, uint64[] memory windowTos)
    {
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(lab) || logs[i].topics[0] != AguLab.Redeemed.selector) {
                continue;
            }
            assertEq(address(uint160(uint256(logs[i].topics[1]))), who, "R12: wrong holder");
            uint256 loggedUnits;
            (loggedUnits, ids, amounts, windowTos) =
                abi.decode(logs[i].data, (uint256, uint256[], uint256[], uint64[]));
            assertEq(loggedUnits, units, "R12: wrong units");
            found = true;
        }
        assertTrue(found, "R12: a redemption must emit Redeemed");
    }

    function _indexOf(uint256[] memory ids, uint256 id) internal pure returns (uint256) {
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == id) return i;
        }
        revert("R12: a delivered lot is missing from Redeemed");
    }
}
