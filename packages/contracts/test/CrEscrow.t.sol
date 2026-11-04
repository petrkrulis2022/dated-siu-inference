// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {AguLabFixture} from "./fixtures/AguLabFixture.sol";

/**
 * The second TouchstoneEscrow, over AGU-lab, unchanged (docs/part5-build-plan.md §5, "CrEscrow").
 * Agents pay each other in AGU-lab through it; the gate-runner is the settler the buyer names,
 * settling in full on a pass and at 0 (a full refund) on a fail (D82).
 *
 * What these tests pin down is that AGU-lab is a token this escrow accepts as it is: plain ERC-20
 * balances, so the escrow's balance-change check passes, and the escrow's own rules (fee on the
 * settled amount, MIN_SETTLEMENT, settler fixed at funding) hold over it with no change to the
 * escrow. The settlement wrapper that exposes `escrowSettle` to the gate-runner role only is
 * engine code, tested in TypeScript; here the contract's own surface is recorded, including the
 * known fact that the seller may settle too (the protection is operational: agents never hold
 * keys, the same trust model as D82).
 */
contract CrEscrowTest is AguLabFixture {
    TouchstoneEscrow internal aguEscrow;

    address internal gateRunner = makeAddr("gateRunner");
    address internal researchAgent = makeAddr("researchAgent"); // the buyer of a brief
    address internal dataAgent = makeAddr("dataAgent"); // the seller of a brief

    bytes32 internal constant QUOTE = keccak256("illustrative-brief-quote");
    bytes32 internal constant RECEIPT = keccak256("illustrative-receipt");
    uint256 internal constant PRICE = 25_000; // AGU-lab base units, illustrative

    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        aguEscrow = new TouchstoneEscrow(IERC20(address(lab)), escrowTreasury, 0);
        _createFresh(CLASS_SM, 1000, 1);
        _giveUnits(researchAgent, 200_000);
        vm.prank(researchAgent);
        lab.approve(address(aguEscrow), type(uint256).max);
        expiry = uint64(block.timestamp + 1 days);
    }

    function _open() internal {
        vm.prank(researchAgent);
        aguEscrow.openAndFund(QUOTE, dataAgent, gateRunner, PRICE, expiry);
    }

    function test_constructsOverAguLabWithZeroFee() public view {
        assertEq(address(aguEscrow.token()), address(lab));
        assertEq(aguEscrow.feeBps(), 0);
        assertEq(aguEscrow.treasury(), escrowTreasury);
    }

    /// The escrow rejects any token whose balances move by anything but the amount sent; AGU-lab
    /// passes, which is why it has no fee, rebase or hook (R1).
    function test_open_passesTheBalanceChangeCheck() public {
        uint256 before = lab.balanceOf(researchAgent);
        _open();
        assertEq(lab.balanceOf(address(aguEscrow)), PRICE);
        assertEq(before - lab.balanceOf(researchAgent), PRICE);
        assertEq(aguEscrow.settlerOf(QUOTE), gateRunner, "the gate-runner is the recorded settler");
    }

    function test_settle_inFullOnAPass() public {
        _open();
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, PRICE, RECEIPT);
        assertEq(lab.balanceOf(dataAgent), PRICE, "the seller is paid in full");
        assertEq(lab.balanceOf(escrowTreasury), 0, "zero fee: the treasury receives nothing");
        assertEq(lab.balanceOf(address(aguEscrow)), 0);
    }

    function test_settle_atZeroIsAFullRefundOnAFail() public {
        uint256 before = lab.balanceOf(researchAgent);
        _open();
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, 0, RECEIPT);
        assertEq(lab.balanceOf(researchAgent), before, "a failed brief pays nothing");
        assertEq(lab.balanceOf(dataAgent), 0);
        assertEq(lab.balanceOf(escrowTreasury), 0);
    }

    function test_settle_partialPaysExactlyTheAmountAndRefundsTheRest() public {
        uint256 before = lab.balanceOf(researchAgent);
        _open();
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, 10_000, RECEIPT);
        assertEq(lab.balanceOf(dataAgent), 10_000);
        assertEq(lab.balanceOf(researchAgent), before - 10_000);
        assertEq(lab.balanceOf(escrowTreasury), 0, "zero fee on a partial settlement too");
    }

    function test_expire_returnsEverythingToTheBuyer() public {
        uint256 before = lab.balanceOf(researchAgent);
        _open();
        vm.warp(expiry + 1);
        vm.prank(stranger);
        aguEscrow.expire(QUOTE);
        assertEq(lab.balanceOf(researchAgent), before);
        assertEq(lab.balanceOf(address(aguEscrow)), 0);
    }

    /// Documented, not hidden: a non-zero settlement under MIN_SETTLEMENT (100 base units of
    /// AGU-lab, 0.0001 AGU-lab) reverts, even at zero fee.
    function test_settle_belowMinSettlementReverts() public {
        _open();
        vm.expectRevert(
            abi.encodeWithSelector(TouchstoneEscrow.SettlementTooSmall.selector, 99, 100)
        );
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, 99, RECEIPT);
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, 100, RECEIPT);
        assertEq(lab.balanceOf(dataAgent), 100, "exactly MIN_SETTLEMENT settles");
    }

    /// The contract's own surface: the recorded settler and the seller can settle; nobody else.
    /// The engine's wrapper narrows this to the gate-runner role.
    function test_settle_isOpenToTheSettlerAndTheSellerOnly() public {
        _open();
        assertTrue(aguEscrow.canSettle(QUOTE, gateRunner));
        assertTrue(aguEscrow.canSettle(QUOTE, dataAgent), "known: the seller may settle too");
        assertFalse(aguEscrow.canSettle(QUOTE, researchAgent));
        assertFalse(aguEscrow.canSettle(QUOTE, aguIssuer));
        vm.expectRevert(TouchstoneEscrow.NotAuthorisedToSettle.selector);
        vm.prank(researchAgent);
        aguEscrow.settle(QUOTE, PRICE, RECEIPT);
    }

    /// Paying through the escrow moves units between holders and never touches the reserve:
    /// supply, live face and NAV are unchanged.
    function test_escrowPaymentsNeverTouchTheReserve() public {
        uint256 supply = lab.totalSupply();
        uint256 face = lab.liveFaceMilli();
        _open();
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, PRICE, RECEIPT);
        assertEq(lab.totalSupply(), supply);
        assertEq(lab.liveFaceMilli(), face);
        assertEq(lab.navWad(), 1e18);
    }

    /// A seller paid in AGU-lab can redeem it in kind like any holder.
    function test_aSellerPaidInAguLabCanRedeemInKind() public {
        _open();
        vm.prank(gateRunner);
        aguEscrow.settle(QUOTE, PRICE, RECEIPT);
        vm.prank(dataAgent);
        (uint256[] memory ids, uint256[] memory amounts) = lab.redeem(PRICE);
        assertEq(ids.length, 1);
        assertEq(amounts[0], 25, "25,000 units of 1,000,000 against 1,000 mSIU");
        assertEq(workClaim.balanceOf(dataAgent, ids[0]), 25);
    }
}
