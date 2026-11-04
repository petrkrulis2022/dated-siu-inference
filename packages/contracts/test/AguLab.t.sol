// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AguLab} from "../src/AguLab.sol";
import {AguBuffer} from "../src/AguBuffer.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {RateAttestationVerifier} from "../src/RateAttestationVerifier.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrantClaimReceiver} from "./mocks/ReentrantClaimReceiver.sol";
import {AguLabFixture} from "./fixtures/AguLabFixture.sol";

/**
 * AGU-lab's unit tests (docs/part5-build-plan.md §5, "AguLab.t.sol, unit tests"), rule by rule:
 * construction, the single grade (R3), creation at NAV (R3), redemption in kind (R4), the roll
 * (R5), the shortfall and carry waterfalls (R6, R7), the buffer, the ERC-20 surface (R1) and
 * reentrancy. The owner's must-fail tests are in AguLab.mustFail.t.sol; the no-admin-path checks
 * (R2) in NoAdminPathAguLab.t.sol.
 */
contract AguLabTest is AguLabFixture {
    // ================================================================== construction

    function test_constructor_setsImmutables() public view {
        assertEq(address(lab.workClaim()), address(workClaim));
        assertEq(address(lab.usdc()), address(usdc));
        assertEq(address(lab.buffer()), address(buffer));
        assertEq(lab.aguIssuer(), aguIssuer);
        assertEq(lab.participant(), participant);
        assertEq(lab.incomeLedger(), incomeLedger);
        assertEq(lab.reserveSeries(), SERIES_COMMODITY);
        assertEq(lab.minTenor(), MIN_TENOR);
        assertEq(lab.discountBps(), DISCOUNT_BPS);
        assertEq(lab.publisher(), workClaim.publisher(), "the same lab key as WorkClaim");
        assertEq(buffer.aguLab(), address(lab));
        assertEq(buffer.target(), BUFFER_TARGET);
    }

    /// Deploys a buffer bound to the next address, then AguLab with `args`; returns nothing,
    /// because each caller expects a revert.
    struct Args {
        address workClaim;
        address issuerRole;
        address participantRole;
        address income;
        bytes32 series;
        uint64 tenor;
        uint16 discount;
    }

    function _defaults() internal view returns (Args memory a) {
        a = Args(
            address(workClaim),
            aguIssuer,
            participant,
            incomeLedger,
            SERIES_COMMODITY,
            MIN_TENOR,
            DISCOUNT_BPS
        );
    }

    function _deployLab(Args memory a, bytes memory err) internal {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AguBuffer b = new AguBuffer(IERC20(address(usdc)), next, BUFFER_TARGET);
        vm.expectRevert(err);
        new AguLab(
            WorkClaim(a.workClaim),
            b,
            a.issuerRole,
            a.participantRole,
            a.income,
            a.series,
            a.tenor,
            a.discount
        );
    }

    function test_constructor_revertsOnZeroAddresses() public {
        Args memory a = _defaults();
        a.workClaim = address(0);
        _deployLab(a, abi.encodeWithSelector(AguLab.WorkClaimZero.selector));
        a = _defaults();
        a.issuerRole = address(0);
        _deployLab(a, abi.encodeWithSelector(AguLab.AguIssuerZero.selector));
        a = _defaults();
        a.participantRole = address(0);
        _deployLab(a, abi.encodeWithSelector(AguLab.ParticipantZero.selector));
        a = _defaults();
        a.income = address(0);
        _deployLab(a, abi.encodeWithSelector(AguLab.IncomeLedgerZero.selector));
    }

    function test_constructor_revertsOnZeroBuffer() public {
        vm.expectRevert(AguLab.BufferZero.selector);
        new AguLab(
            workClaim,
            AguBuffer(address(0)),
            aguIssuer,
            participant,
            incomeLedger,
            SERIES_COMMODITY,
            MIN_TENOR,
            DISCOUNT_BPS
        );
    }

    function test_constructor_revertsOnZeroSeriesOrTenor() public {
        Args memory a = _defaults();
        a.series = bytes32(0);
        _deployLab(a, abi.encodeWithSelector(AguLab.SeriesZero.selector));
        a = _defaults();
        a.tenor = 0;
        _deployLab(a, abi.encodeWithSelector(AguLab.MinTenorZero.selector));
    }

    /// A discount of the whole price would hand the front claims away for nothing.
    function test_constructor_revertsOnDiscountOfTheWholePrice() public {
        Args memory a = _defaults();
        a.discount = 10_000;
        _deployLab(a, abi.encodeWithSelector(AguLab.DiscountTooHigh.selector, uint16(10_000)));
    }

    /// R10: the issuer role, the participant, the income ledger and the buffer are four wallets.
    function test_constructor_revertsWhenRolesShareAWallet() public {
        Args memory a = _defaults();
        a.participantRole = aguIssuer;
        _deployLab(a, abi.encodeWithSelector(AguLab.RolesNotSeparate.selector));
        a = _defaults();
        a.income = participant;
        _deployLab(a, abi.encodeWithSelector(AguLab.RolesNotSeparate.selector));
        a = _defaults();
        a.income = aguIssuer;
        _deployLab(a, abi.encodeWithSelector(AguLab.RolesNotSeparate.selector));
    }

    function test_constructor_revertsWhenTheBufferNamesAnotherLab() public {
        AguBuffer other = new AguBuffer(IERC20(address(usdc)), makeAddr("otherLab"), 1);
        vm.expectRevert(
            abi.encodeWithSelector(AguLab.BufferNotBoundToThisLab.selector, makeAddr("otherLab"))
        );
        new AguLab(
            workClaim,
            other,
            aguIssuer,
            participant,
            incomeLedger,
            SERIES_COMMODITY,
            MIN_TENOR,
            DISCOUNT_BPS
        );
    }

    function test_constructor_revertsWhenTheBufferHoldsAnotherDollar() public {
        MockUSDC otherDollar = new MockUSDC();
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        AguBuffer other = new AguBuffer(IERC20(address(otherDollar)), next, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                AguLab.BufferDollarMismatch.selector, address(otherDollar), address(usdc)
            )
        );
        new AguLab(
            workClaim,
            other,
            aguIssuer,
            participant,
            incomeLedger,
            SERIES_COMMODITY,
            MIN_TENOR,
            DISCOUNT_BPS
        );
    }

    // ================================================================== R1: the ERC-20

    function test_erc20_isPlainWithSixDecimals() public {
        assertEq(lab.decimals(), 6);
        assertEq(lab.totalSupply(), 0);
        (, uint256 units) = _createFresh(CLASS_SM, 1000, 1);

        vm.prank(participant);
        assertTrue(lab.transfer(holder, 123_456));
        assertEq(lab.balanceOf(holder), 123_456, "exact-amount transfer");
        assertEq(lab.balanceOf(participant), units - 123_456);

        vm.prank(holder);
        lab.approve(agent1, 100_000);
        vm.prank(agent1);
        assertTrue(lab.transferFrom(holder, agent2, 100_000));
        assertEq(lab.balanceOf(agent2), 100_000);
        assertEq(lab.allowance(holder, agent1), 0);
        assertEq(lab.totalSupply(), units, "no fee, no rebase: transfers never change supply");
    }

    // ================================================================== R3: single grade

    function test_create_refusesAFrontierLot() public {
        uint256 frontier = _buyClaimsOfSeries(participant, CLASS_SM, SERIES_FRONTIER, 1000, 1);
        vm.expectRevert(
            abi.encodeWithSelector(AguLab.WrongSeries.selector, SERIES_FRONTIER, SERIES_COMMODITY)
        );
        vm.prank(participant);
        lab.create(frontier, 1000);
    }

    function test_roll_refusesAFrontierAttestation() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_FRONTIER);
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        AguLab.RollOrder memory order = _order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2);
        vm.expectRevert(
            abi.encodeWithSelector(AguLab.WrongSeries.selector, SERIES_FRONTIER, SERIES_COMMODITY)
        );
        vm.prank(aguIssuer);
        lab.roll(order, att, labSig, claimSig);
    }

    function test_roll_buysOnlyTheReserveSeries() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(front), _noSales(), _buy(CLASS_PL, 1000), 2));
        uint256 bought =
            workClaim.tokenIdFor(issuerA, CLASS_PL, SERIES_COMMODITY, _windowFrom(2), _windowTo(2));
        (,, bytes32 series,,,,) = workClaim.claimTypes(bought);
        assertEq(series, SERIES_COMMODITY, "R3: the roll must buy the reserve's grade only");
        assertEq(lab.reserveBalance(bought), 1000, "any task class is allowed");
    }

    // ================================================================== R3: creation at NAV

    function test_create_firstCreationMintsOneAguPerSiu() public {
        (, uint256 units) = _createFresh(CLASS_SM, 1234, 1);
        assertEq(units, 1_234_000, "R1: 1 mSIU of face is 1,000 base units at the first creation");
        assertEq(lab.balanceOf(participant), units);
        assertEq(lab.liveFaceMilli(), 1234);
        assertEq(lab.navWad(), 1e18, "NAV is 1 SIU per AGU-lab at the first creation");
    }

    function test_create_anyTaskClass() public {
        _createFresh(CLASS_SM, 100, 1);
        _createFresh(CLASS_PL, 100, 1);
        assertEq(lab.liveFaceMilli(), 200);
    }

    /// NAV below 1: a lot's window closes with nobody rolling it, so its face leaves the reserve.
    function test_create_atNavBelowOneMintsMoreUnitsPerSiu() public {
        _createFresh(CLASS_SM, 1000, 1);
        _createFresh(CLASS_PL, 1000, 2);
        vm.warp(_windowTo(1));
        assertEq(lab.liveFaceMilli(), 1000, "window 1 closed");
        assertEq(lab.navWad(), 5e17, "NAV is 0.5");

        uint256 face0 = lab.liveFaceMilli();
        uint256 supply0 = lab.totalSupply();
        (, uint256 units) = _createFresh(CLASS_PL, 500, 3);
        assertEq(units, (500 * supply0) / face0, "R3: units = face x supply / live face");
        assertEq(units, 1_000_000);
        assertTrue(
            _perUnitNotBelow(lab.liveFaceMilli(), lab.totalSupply(), face0, supply0),
            "R3: a creation at NAV below 1 diluted holders"
        );
        assertEq(lab.navWad(), 5e17, "R3: NAV unchanged by a creation at NAV");
    }

    /// NAV above 1: redemptions round down in the reserve's favour, so dust accumulates.
    function test_create_atNavAboveOneMintsFewerUnitsPerSiu() public {
        _createFresh(CLASS_SM, 3, 1);
        vm.prank(participant);
        lab.redeem(1500); // floor(1500 x 3 / 3000) = 1 mSIU delivered
        assertEq(lab.liveFaceMilli(), 2);
        assertEq(lab.totalSupply(), 1500);
        assertGt(lab.navWad(), 1e18, "NAV is above 1");

        uint256 face0 = lab.liveFaceMilli();
        uint256 supply0 = lab.totalSupply();
        uint256 lot = _buyClaims(participant, CLASS_SM, 7, 1);
        uint256 units = _create(lot, 7);
        assertEq(units, (7 * supply0) / face0, "R3: units = face x supply / live face");
        assertTrue(
            _perUnitNotBelow(lab.liveFaceMilli(), lab.totalSupply(), face0, supply0),
            "R3: a creation at NAV above 1 overpaid the creator"
        );
    }

    function testFuzz_create_neverDilutesHolders(uint256 face0, uint256 face1, uint256 redeemed)
        public
    {
        face0 = bound(face0, 1, 1_000_000);
        face1 = bound(face1, 1, 1_000_000);
        (, uint256 units) = _createFresh(CLASS_SM, face0, 1);
        redeemed = bound(redeemed, 0, units - 1);
        if (redeemed > 0) {
            (, uint256[] memory amounts,) = lab.previewRedeem(redeemed);
            if (amounts.length > 0) {
                vm.prank(participant);
                lab.redeem(redeemed);
            }
        }
        uint256 f0 = lab.liveFaceMilli();
        uint256 s0 = lab.totalSupply();
        uint256 lot = _buyClaims(participant, CLASS_PL, face1, 2);
        if ((face1 * s0) / f0 == 0) {
            vm.expectRevert(AguLab.ZeroUnits.selector);
            vm.prank(participant);
            lab.create(lot, face1);
            return;
        }
        _create(lot, face1);
        assertTrue(
            _perUnitNotBelow(lab.liveFaceMilli(), lab.totalSupply(), f0, s0),
            "R3: per-unit reserve value fell through a creation"
        );
    }

    function test_create_refusesTooShortATenor() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 1000, 0); // window 0: [BASE, BASE + 1 day)
        vm.warp(_windowTo(0) - MIN_TENOR + 1);
        vm.expectRevert(
            abi.encodeWithSelector(AguLab.TenorTooShort.selector, _windowTo(0), MIN_TENOR)
        );
        vm.prank(participant);
        lab.create(lot, 1000);
    }

    function test_create_acceptsExactlyTheMinimumTenor() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 1000, 0);
        vm.warp(_windowTo(0) - MIN_TENOR);
        assertEq(_create(lot, 1000), 1_000_000);
    }

    function test_create_refusesAnyoneButTheParticipant() public {
        uint256 lot = _buyClaims(agent1, CLASS_SM, 1000, 1);
        vm.prank(agent1);
        workClaim.setApprovalForAll(address(lab), true);
        address[3] memory others = [agent1, aguIssuer, publisher];
        for (uint256 i = 0; i < others.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(AguLab.NotParticipant.selector, others[i]));
            vm.prank(others[i]);
            lab.create(lot, 1000);
        }
    }

    function test_create_refusesAnUnknownClaim() public {
        vm.expectRevert(abi.encodeWithSelector(AguLab.UnknownClaim.selector, uint256(42)));
        vm.prank(participant);
        lab.create(42, 1);
    }

    function test_create_refusesZeroFace() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 1000, 1);
        vm.expectRevert(AguLab.ZeroAmount.selector);
        vm.prank(participant);
        lab.create(lot, 0);
    }

    /// A retired front lot is out of live face; adding claims to it would mint units against
    /// face that counts for nothing.
    function test_create_refusesARetiredLot() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 2000, 1);
        _create(lot, 1000);
        vm.warp(_windowFrom(1));
        _roll(_order(_ids(lot), _noSales(), _buy(CLASS_SM, 1000), 2));
        vm.expectRevert(abi.encodeWithSelector(AguLab.LotRetired.selector, lot));
        vm.prank(participant);
        lab.create(lot, 1000);
    }

    /// With units outstanding and no live face (NAV zero), "face x supply / live face" is
    /// undefined; minting at 1:1 instead would hand the creator's face to the old holders.
    function test_create_refusesWhenNoLiveFaceRemains() public {
        _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowTo(1));
        uint256 lot = _buyClaims(participant, CLASS_PL, 1000, 3);
        vm.expectRevert(AguLab.NoLiveFace.selector);
        vm.prank(participant);
        lab.create(lot, 1000);
    }

    function test_create_doesNotTouchAnyDollar() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 1000, 1);
        uint256 participantUsdc = usdc.balanceOf(participant);
        uint256 bufferUsdc = usdc.balanceOf(address(buffer));
        _create(lot, 1000);
        assertEq(usdc.balanceOf(participant), participantUsdc);
        assertEq(usdc.balanceOf(address(buffer)), bufferUsdc);
        assertEq(usdc.balanceOf(address(lab)), 0);
    }

    // ================================================================== R4: redemption

    function test_redeem_oneLotExactlyProRata() public {
        (uint256 lot, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        _giveUnits(holder, units / 4);
        vm.prank(holder);
        (uint256[] memory ids, uint256[] memory amounts) = lab.redeem(units / 4);
        assertEq(ids.length, 1);
        assertEq(ids[0], lot);
        assertEq(amounts[0], 250);
        assertEq(workClaim.balanceOf(holder, lot), 250);
        assertEq(lab.reserveBalance(lot), 750);
        assertEq(lab.totalSupply(), units - units / 4);
    }

    function test_redeem_severalLotsProRata() public {
        (uint256 sm,) = _createFresh(CLASS_SM, 1000, 1);
        (uint256 pl,) = _createFresh(CLASS_PL, 333, 2);
        uint256 supply = lab.totalSupply();
        uint256 units = supply / 3;
        _giveUnits(holder, units);
        vm.prank(holder);
        lab.redeem(units);
        assertEq(workClaim.balanceOf(holder, sm), (units * 1000) / supply);
        assertEq(workClaim.balanceOf(holder, pl), (units * 333) / supply);
    }

    function testFuzz_redeem_roundsDownAndNeverOverpays(uint256 f1, uint256 f2, uint256 units)
        public
    {
        f1 = bound(f1, 1, 1_000_000);
        f2 = bound(f2, 1, 1_000_000);
        (uint256 sm,) = _createFresh(CLASS_SM, f1, 1);
        (uint256 pl,) = _createFresh(CLASS_PL, f2, 2);
        uint256 supply = lab.totalSupply();
        units = bound(units, 1, supply);
        (, uint256[] memory amounts,) = lab.previewRedeem(units);
        vm.assume(amounts.length > 0);

        uint256 sm0 = lab.reserveBalance(sm);
        uint256 pl0 = lab.reserveBalance(pl);
        vm.prank(participant);
        lab.redeem(units);
        uint256 gotSm = workClaim.balanceOf(participant, sm);
        uint256 gotPl = workClaim.balanceOf(participant, pl);
        assertLe(gotSm * supply, units * sm0, "R4: overpaid a lot");
        assertLe(gotPl * supply, units * pl0, "R4: overpaid a lot");
        assertEq(gotSm, (units * sm0) / supply, "R4: not pro rata");
        assertEq(gotPl, (units * pl0) / supply, "R4: not pro rata");
        // Per-unit value of what remains never falls.
        if (lab.totalSupply() > 0) {
            assertTrue(
                _perUnitNotBelow(lab.reserveBalance(sm), lab.totalSupply(), sm0, supply),
                "R4: a redemption lowered the remaining holders' share of a lot"
            );
            assertTrue(
                _perUnitNotBelow(lab.reserveBalance(pl), lab.totalSupply(), pl0, supply),
                "R4: a redemption lowered the remaining holders' share of a lot"
            );
        }
    }

    function test_redeem_twoHoldersInTurnGetTheSameValuePerUnit() public {
        (uint256 lot, uint256 units) = _createFresh(CLASS_SM, 1001, 1);
        _giveUnits(holder, units / 3);
        _giveUnits(agent2, units / 3);
        vm.prank(holder);
        lab.redeem(units / 3);
        vm.prank(agent2);
        lab.redeem(units / 3);
        uint256 a = workClaim.balanceOf(holder, lot);
        uint256 b = workClaim.balanceOf(agent2, lot);
        assertTrue(b >= a && b - a <= 1, "R4: equal units must redeem equal value, up to dust");
    }

    function test_redeem_wholeSupplyReturnsEveryLiveLot() public {
        (uint256 sm,) = _createFresh(CLASS_SM, 1000, 1);
        (uint256 pl,) = _createFresh(CLASS_PL, 777, 2);
        vm.startPrank(participant);
        lab.redeem(lab.balanceOf(participant));
        vm.stopPrank();
        assertEq(lab.totalSupply(), 0);
        assertEq(workClaim.balanceOf(participant, sm), 1000);
        assertEq(workClaim.balanceOf(participant, pl), 777);
        assertEq(lab.liveFaceMilli(), 0);
    }

    function test_redeem_zeroUnitsReverts() public {
        _createFresh(CLASS_SM, 1000, 1);
        vm.expectRevert(AguLab.ZeroAmount.selector);
        vm.prank(participant);
        lab.redeem(0);
    }

    function test_redeem_moreThanYourBalanceReverts() public {
        (, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        _giveUnits(holder, 10_000);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, holder, 10_000, 10_001
            )
        );
        vm.prank(holder);
        lab.redeem(10_001);
        units;
    }

    /// Units too few to round to a single mSIU of any lot would be burned for nothing; the
    /// redemption is refused instead, so a holder can never lose units to rounding.
    function test_redeem_unitsThatDeliverNothingAreRefused() public {
        _createFresh(CLASS_SM, 1000, 1);
        vm.expectRevert(abi.encodeWithSelector(AguLab.NothingToRedeem.selector, uint256(999)));
        vm.prank(participant);
        lab.redeem(999);
    }

    function test_redeem_skipsRetiredAndClosedLots() public {
        (uint256 sm1,) = _createFresh(CLASS_SM, 1000, 1);
        (uint256 pl2,) = _createFresh(CLASS_PL, 1000, 2);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(sm1), _noSales(), _buy(CLASS_SM, 1000), 2));
        vm.prank(participant);
        (uint256[] memory ids,) = lab.redeem(10_000);
        assertEq(ids.length, 2, "the retired front lot is not delivered");
        assertEq(workClaim.balanceOf(participant, sm1), 0);
        assertGt(workClaim.balanceOf(participant, pl2), 0);
    }

    // ================================================================== R5: the roll step

    function test_roll_sellsBuysAndEndsAtZero() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        uint256 agentUsdc = usdc.balanceOf(agent1);
        uint256 issuerUsdc = usdc.balanceOf(issuerA);

        RollSummary memory s =
            _roll(_order(_ids(front), _sale(agent1, front, 700), _buy(CLASS_SM, 1000), 2));

        assertEq(s.rate, RATE);
        assertEq(s.faceSold, 700);
        assertEq(s.faceUnsold, 300);
        assertEq(s.faceBought, 1000);
        assertEq(s.proceeds, _salePrice(700));
        assertEq(s.cost, _cost(1000));
        assertEq(s.cover, _cost(1000) - _salePrice(700));
        assertEq(s.toBuffer + s.toIncome, 0, "no carry: proceeds were below cost");
        assertEq(workClaim.balanceOf(agent1, front), 700, "the buyer received the claims sold");
        assertEq(agentUsdc - usdc.balanceOf(agent1), _salePrice(700));
        assertEq(usdc.balanceOf(issuerA) - issuerUsdc, _cost(1000), "the routed issuer was paid");
        assertEq(usdc.balanceOf(address(lab)), 0, "R5: the roll ends at zero USDC");
        assertEq(lab.liveFaceMilli(), 1000, "face restored");
        assertEq(lab.reserveBalance(front), 300, "unsold claims stay held until they expire");
        assertFalse(lab.isLive(front), "a retired lot is out of live face at once");
    }

    /// Retired lots leave live face at once, so NAV never counts a front lot and its replacement.
    function test_roll_retiredLotsLeaveLiveFaceAtOnce() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        assertEq(lab.liveFaceMilli(), 1000);
        _roll(_order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2));
        assertEq(lab.liveFaceMilli(), 1000, "front + replacement must not double-count");
        assertEq(lab.navWad(), 1e18);
    }

    /// An unsold front lot is never presented, so at its window's close it expires: burned, no
    /// bond draw, and anyone can trigger it with an empty attestation.
    function test_roll_unsoldFrontLotsExpireWithoutABondDraw() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(front), _sale(agent1, front, 400), _buy(CLASS_SM, 1000), 2));
        assertFalse(workClaim.everPresented(front, address(lab)), "AguLab never presents");

        vm.warp(_windowTo(1));
        (,, uint256 bonded,,) = bond.lots(issuerA, CLASS_SM);
        RateAttestationVerifier.RateAttestation memory empty;
        vm.expectEmit(true, true, false, true, address(workClaim));
        emit WorkClaim.Expired(front, address(lab), 600);
        vm.prank(stranger);
        workClaim.settleWindowClose(front, address(lab), empty, "");
        (,, uint256 bondedAfter,,) = bond.lots(issuerA, CLASS_SM);
        assertEq(bondedAfter, bonded, "an expiry must never draw the bond");
        assertEq(lab.reserveBalance(front), 0);
    }

    function test_roll_theRouterPicksTheIssuer() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.prank(publisher);
        router.setSkipped(issuerA, true);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2));
        uint256 fromB =
            workClaim.tokenIdFor(issuerB, CLASS_SM, SERIES_COMMODITY, _windowFrom(2), _windowTo(2));
        assertEq(lab.reserveBalance(fromB), 1000);
    }

    function test_roll_onlyTheAguIssuer() public {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        AguLab.RollOrder memory order = _order(_noIds(), _noSales(), _noBuys(), 2);
        address[3] memory others = [participant, publisher, agent1];
        for (uint256 i = 0; i < others.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(AguLab.NotAguIssuer.selector, others[i]));
            vm.prank(others[i]);
            lab.roll(order, att, labSig, claimSig);
        }
    }

    function test_roll_refusesALotWhoseWindowHasNotOpened() public {
        (uint256 lot,) = _createFresh(CLASS_SM, 1000, 1);
        _rollExpectRevert(
            _order(_ids(lot), _noSales(), _buy(CLASS_SM, 1000), 2),
            abi.encodeWithSelector(AguLab.NotAFrontLot.selector, lot, _windowFrom(1), _windowTo(1))
        );
    }

    function test_roll_refusesALotTwiceOrUnknown() public {
        (uint256 lot,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(lot, lot), _noSales(), _buy(CLASS_SM, 1000), 2),
            abi.encodeWithSelector(AguLab.NotLiveLot.selector, lot)
        );
        _rollExpectRevert(
            _order(_ids(7), _noSales(), _noBuys(), 2),
            abi.encodeWithSelector(AguLab.NotLiveLot.selector, uint256(7))
        );
    }

    function test_roll_refusesSellingALotItDidNotRetire() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        (uint256 later,) = _createFresh(CLASS_PL, 1000, 2);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(front), _sale(agent1, later, 10), _buy(CLASS_SM, 1000), 2),
            abi.encodeWithSelector(AguLab.NotRetiredThisRoll.selector, later)
        );
    }

    function test_roll_refusesABuyWindowThatOverlapsTheFront() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        AguLab.RollOrder memory order = _order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2);
        order.buyFrom = _windowTo(1) - 1;
        _rollExpectRevert(
            order,
            abi.encodeWithSelector(
                AguLab.BuyWindowOverlapsFront.selector, _windowTo(1) - 1, _windowTo(1)
            )
        );
    }

    function test_roll_refusesABuyWithTooShortATenor() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        AguLab.RollOrder memory order = _order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2);
        order.buyTo = uint64(block.timestamp) + MIN_TENOR - 1;
        order.buyFrom = _windowTo(1);
        _rollExpectRevert(
            order, abi.encodeWithSelector(AguLab.TenorTooShort.selector, order.buyTo, MIN_TENOR)
        );
    }

    /// R7: carry never buys claims beyond the face retired; it goes to the buffer or income.
    function test_roll_refusesBuyingMoreFaceThanItRetired() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(front), _noSales(), _buy(CLASS_SM, 1001), 2),
            abi.encodeWithSelector(AguLab.RollOverbuys.selector, uint256(1001), uint256(1000))
        );
    }

    function test_roll_refusesFullFaceTheBufferCannotPayFor() public {
        (uint256 front,) = _createFresh(CLASS_SM, 10_000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(front), _noSales(), _buy(CLASS_SM, 10_000), 2),
            abi.encodeWithSelector(
                AguLab.RollShortfallExceedsBuffer.selector, _cost(10_000), BUFFER_SEED
            )
        );
    }

    function test_roll_refusesAnUnderbuyItCannotPayFor() public {
        (uint256 front,) = _createFresh(CLASS_SM, 10_000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(front), _noSales(), _buy(CLASS_SM, 5_000), 2),
            abi.encodeWithSelector(AguLab.RollUnaffordable.selector, _cost(5_000), BUFFER_SEED)
        );
    }

    function test_roll_refusesAnUnderbuyThatLeavesOneMoreMilliAffordable() public {
        (uint256 front,) = _createFresh(CLASS_SM, 10_000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        uint256 affordable = ((BUFFER_SEED + 1) * 1_000_000 - 1) / RATE;
        uint256 q = affordable - 1;
        _rollExpectRevert(
            _order(_ids(front), _noSales(), _buy(CLASS_SM, q), 2),
            abi.encodeWithSelector(
                AguLab.RollUnderbuys.selector,
                q,
                uint256(10_000),
                BUFFER_SEED - _cost(q),
                _cost(q + 1) - _cost(q)
            )
        );
        // The most it can afford is accepted, and NAV falls.
        RollSummary memory s = _roll(_order(_ids(front), _noSales(), _buy(CLASS_SM, affordable), 2));
        assertEq(s.faceBought, affordable);
        assertLt(lab.navWad(), 1e18);
    }

    function test_roll_refusesAnAttestationFromAnotherKey() public {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory forged = _signAs(0xBAD, address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        AguLab.RollOrder memory order = _order(_noIds(), _noSales(), _noBuys(), 2);
        vm.expectPartialRevert(RateAttestationVerifier.InvalidRateAttestation.selector);
        vm.prank(aguIssuer);
        lab.roll(order, att, forged, claimSig);
    }

    /// The two signatures are not interchangeable: each verifier binds its own address into the
    /// EIP-712 domain, so a WorkClaim-domain signature cannot stand in for AguLab's.
    function test_roll_refusesWorkClaimsSignatureInPlaceOfItsOwn() public {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory claimSig = _sign(address(workClaim), att);
        AguLab.RollOrder memory order = _order(_noIds(), _noSales(), _noBuys(), 2);
        vm.expectPartialRevert(RateAttestationVerifier.InvalidRateAttestation.selector);
        vm.prank(aguIssuer);
        lab.roll(order, att, claimSig, claimSig);
    }

    function test_roll_refusesZeroQuantities() public {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _rollExpectRevert(
            _order(_ids(front), _sale(agent1, front, 0), _buy(CLASS_SM, 1000), 2),
            abi.encodeWithSelector(AguLab.ZeroAmount.selector)
        );
        _rollExpectRevert(
            _order(_ids(front), _noSales(), _buy(CLASS_SM, 0), 2),
            abi.encodeWithSelector(AguLab.ZeroAmount.selector)
        );
    }

    function test_roll_dropsClosedLotsFromTheLotList() public {
        (uint256 sm1,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);
        _roll(_order(_ids(sm1), _noSales(), _buy(CLASS_SM, 1000), 2));
        assertEq(lab.lotIds().length, 2, "the retired lot stays listed while its window is open");
        vm.warp(_windowFrom(2) + 1 hours);
        _roll(_planRoll(agent1, 0, CLASS_SM, 3));
        uint256[] memory ids = lab.lotIds();
        for (uint256 i = 0; i < ids.length; i++) {
            assertTrue(ids[i] != sm1, "a lot whose window closed must leave the list");
        }
    }

    // ================================================================== R7: carry

    function _rollWithStray(uint256 stray) internal returns (RollSummary memory s) {
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        usdc.mint(stranger, stray);
        vm.prank(stranger);
        usdc.transfer(address(lab), stray);
        vm.warp(_windowFrom(1) + 1 hours);
        s = _roll(_order(_ids(front), _noSales(), _buy(CLASS_SM, 1000), 2));
    }

    function test_carry_topsTheBufferUpToItsTarget() public {
        uint256 stray = _cost(1000) + 10_000;
        RollSummary memory s = _rollWithStray(stray);
        assertEq(s.toBuffer, 10_000, "R7: carry below the target all goes to the buffer");
        assertEq(s.toIncome, 0);
        assertEq(usdc.balanceOf(address(buffer)), BUFFER_SEED + 10_000);
    }

    function test_carry_aboveTheTargetGoesToTheIncomeLedger() public {
        uint256 stray = _cost(1000) + 45_000;
        uint256 incomeBefore = usdc.balanceOf(incomeLedger);
        RollSummary memory s = _rollWithStray(stray);
        assertEq(s.toBuffer, BUFFER_TARGET - BUFFER_SEED, "R7: the buffer fills to its target");
        assertEq(s.toIncome, 45_000 - (BUFFER_TARGET - BUFFER_SEED), "R7: the rest is income");
        assertEq(usdc.balanceOf(address(buffer)), BUFFER_TARGET);
        assertEq(usdc.balanceOf(incomeLedger) - incomeBefore, s.toIncome);
    }

    function test_carry_neverChangesReserveFaceOrNav() public {
        RollSummary memory s = _rollWithStray(_cost(1000) + 100_000);
        assertGt(s.toIncome, 0, "sanity: there was carry above target");
        assertEq(s.faceBought, 1000, "R7: carry bought no extra claims");
        assertEq(lab.liveFaceMilli(), 1000);
        assertEq(lab.navWad(), 1e18, "R7: carry never lifts NAV above what the claims hold");
    }

    function test_carry_aFullBufferSendsEverythingToIncome() public {
        _seedBuffer(BUFFER_TARGET); // now above target
        RollSummary memory s = _rollWithStray(_cost(1000) + 5_000);
        assertEq(s.toBuffer, 0);
        assertEq(s.toIncome, 5_000);
    }

    // ================================================================== the buffer

    function test_buffer_constructorRefusesZeroes() public {
        vm.expectRevert(AguBuffer.UsdcZero.selector);
        new AguBuffer(IERC20(address(0)), address(lab), 1);
        vm.expectRevert(AguBuffer.AguLabZero.selector);
        new AguBuffer(IERC20(address(usdc)), address(0), 1);
    }

    function test_buffer_seedPullsFromAnyone() public {
        usdc.mint(stranger, 777);
        vm.startPrank(stranger);
        usdc.approve(address(buffer), 777);
        vm.expectEmit(true, false, false, true, address(buffer));
        emit AguBuffer.Seeded(stranger, 777);
        buffer.seed(777);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(buffer)), BUFFER_SEED + 777);
    }

    function test_buffer_seedOfZeroReverts() public {
        vm.expectRevert(AguBuffer.ZeroAmount.selector);
        buffer.seed(0);
    }

    /// The buffer is its own wallet: creation, redemption and a carry-free roll never route
    /// money through it, and it is never negative (ERC-20 balances cannot be).
    function test_buffer_isSeparateFromTheReserve() public {
        assertTrue(address(buffer) != address(lab));
        (, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        vm.prank(participant);
        lab.redeem(units / 2);
        assertEq(usdc.balanceOf(address(buffer)), BUFFER_SEED);
        assertEq(usdc.balanceOf(address(lab)), 0);
    }

    // ================================================================== ERC-1155 receipt

    function test_unsolicitedClaimsAreRefused() public {
        uint256 lot = _buyClaims(participant, CLASS_SM, 1000, 1);
        vm.expectRevert(abi.encodeWithSelector(AguLab.UnsolicitedClaims.selector, participant));
        vm.prank(participant);
        workClaim.safeTransferFrom(participant, address(lab), lot, 10, "");

        uint256[] memory ids = _ids(lot);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10;
        vm.expectRevert(abi.encodeWithSelector(AguLab.UnsolicitedClaims.selector, participant));
        vm.prank(participant);
        workClaim.safeBatchTransferFrom(participant, address(lab), ids, amounts, "");
    }

    // ================================================================== reentrancy

    function test_reentrancy_aSaleBuyerCannotReenter() public {
        _seedBuffer(1e9); // three rolls' worth of cover
        ReentrantClaimReceiver evil = new ReentrantClaimReceiver(lab);
        usdc.mint(address(evil), 1e9);
        evil.approve(IERC20(address(usdc)), address(lab));
        (uint256 front,) = _createFresh(CLASS_SM, 1000, 1);
        vm.warp(_windowFrom(1) + 1 hours);

        ReentrantClaimReceiver.Mode[3] memory modes = [
            ReentrantClaimReceiver.Mode.Redeem,
            ReentrantClaimReceiver.Mode.Create,
            ReentrantClaimReceiver.Mode.Roll
        ];
        evil.arm(modes[0]);
        _roll(_order(_ids(front), _sale(address(evil), front, 100), _buy(CLASS_SM, 1000), 2));
        _assertRefused(evil);

        for (uint256 i = 1; i < modes.length; i++) {
            ReentrantClaimReceiver again = new ReentrantClaimReceiver(lab);
            usdc.mint(address(again), 1e9);
            again.approve(IERC20(address(usdc)), address(lab));
            again.arm(modes[i]);
            uint256 lot = _onlyLiveLot();
            vm.warp(_windowFrom(2 + i - 1) + 1 hours);
            _roll(_order(_ids(lot), _sale(address(again), lot, 100), _buy(CLASS_SM, 1000), 2 + i));
            _assertRefused(again);
        }
    }

    function test_reentrancy_aRedeemerCannotReenter() public {
        ReentrantClaimReceiver evil = new ReentrantClaimReceiver(lab);
        (, uint256 units) = _createFresh(CLASS_SM, 1000, 1);
        _giveUnits(address(evil), units / 2);
        evil.arm(ReentrantClaimReceiver.Mode.Redeem);
        evil.redeem(units / 4);
        _assertRefused(evil);
        assertEq(lab.balanceOf(address(evil)), units / 2 - units / 4, "exactly one redemption");
    }

    function _assertRefused(ReentrantClaimReceiver r) internal view {
        assertTrue(r.attempted(), "sanity: the hook tried to re-enter");
        assertFalse(r.succeeded(), "a re-entrant call into AguLab succeeded");
        assertEq(
            bytes4(r.lastError()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "refused by the reentrancy guard"
        );
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

    // ================================================================== views

    function test_views_navWithNoSupplyIsTheFirstCreationRate() public view {
        assertEq(lab.navWad(), 1e18);
        assertEq(lab.previewCreate(5), 5000);
    }

    function test_views_previewsMatchTheCalls() public {
        _createFresh(CLASS_SM, 1000, 1);
        _createFresh(CLASS_PL, 300, 2);
        uint256 lot = _buyClaims(participant, CLASS_PL, 77, 2);
        uint256 preview = lab.previewCreate(77);
        assertEq(_create(lot, 77), preview);

        (uint256[] memory pIds, uint256[] memory pAmounts, uint64[] memory pTos) =
            lab.previewRedeem(123_456);
        vm.prank(participant);
        (uint256[] memory ids, uint256[] memory amounts) = lab.redeem(123_456);
        assertEq(pIds.length, ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(pIds[i], ids[i]);
            assertEq(pAmounts[i], amounts[i]);
            (,,,, uint64 windowTo,,) = workClaim.claimTypes(ids[i]);
            assertEq(pTos[i], windowTo);
        }
    }

    function test_views_lotsRecordTheirWindows() public {
        (uint256 lot,) = _createFresh(CLASS_SM, 1000, 1);
        (bool known, bool retired, uint64 wFrom, uint64 wTo, uint64 retiredAt) = lab.lots(lot);
        assertTrue(known);
        assertFalse(retired);
        assertEq(wFrom, _windowFrom(1));
        assertEq(wTo, _windowTo(1));
        assertEq(retiredAt, 0);
        assertTrue(lab.isLive(lot));
    }
}
