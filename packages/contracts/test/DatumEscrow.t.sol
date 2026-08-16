// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DatumEscrow} from "../src/DatumEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

contract DatumEscrowTest is Test {
    DatumEscrow internal escrow;
    MockUSDC internal usdc;

    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    address internal settler = makeAddr("settler");
    address internal stranger = makeAddr("stranger");
    address internal treasury = makeAddr("treasury");

    uint16 internal constant FEE_BPS = 50; // 0.5%
    uint256 internal constant MAX_AMOUNT = 1_000_000; // 1 USDC at 6dp
    bytes32 internal constant QUOTE_HASH = keccak256("quote-1");
    bytes32 internal constant RECEIPT_REF = keccak256("receipt-1");

    uint64 internal expiry;

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new DatumEscrow(IERC20(address(usdc)), treasury, FEE_BPS);
        expiry = uint64(block.timestamp + 1 days);

        usdc.mint(buyer, 100 * MAX_AMOUNT);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _open(address settler_) internal {
        vm.prank(buyer);
        escrow.openAndFund(QUOTE_HASH, seller, settler_, MAX_AMOUNT, expiry);
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_setsImmutables() public view {
        assertEq(address(escrow.token()), address(usdc));
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.feeBps(), FEE_BPS);
        assertEq(escrow.MAX_FEE_BPS(), 100);
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(DatumEscrow.TokenZero.selector);
        new DatumEscrow(IERC20(address(0)), treasury, FEE_BPS);
    }

    function test_constructor_revertsOnZeroTreasury() public {
        vm.expectRevert(DatumEscrow.TreasuryZero.selector);
        new DatumEscrow(IERC20(address(usdc)), address(0), FEE_BPS);
    }

    function test_constructor_revertsWhenFeeExceedsMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(DatumEscrow.FeeTooHigh.selector, uint16(101), uint16(100))
        );
        new DatumEscrow(IERC20(address(usdc)), treasury, 101);
    }

    function test_constructor_acceptsFeeAtExactlyMax() public {
        DatumEscrow atMax = new DatumEscrow(IERC20(address(usdc)), treasury, 100);
        assertEq(atMax.feeBps(), 100);
    }

    function testFuzz_constructor_revertsForAnyFeeAboveMax(uint16 feeBps_) public {
        feeBps_ = uint16(bound(feeBps_, 101, type(uint16).max));
        vm.expectRevert(
            abi.encodeWithSelector(DatumEscrow.FeeTooHigh.selector, feeBps_, uint16(100))
        );
        new DatumEscrow(IERC20(address(usdc)), treasury, feeBps_);
    }

    // ---------------------------------------------------------------- openAndFund

    function test_openAndFund_recordsEscrowAndPullsFunds() public {
        uint256 buyerBefore = usdc.balanceOf(buyer);
        _open(settler);

        (address b, uint64 e, DatumEscrow.Status s, address sl, address st, uint256 m) =
            escrow.escrows(QUOTE_HASH);
        assertEq(b, buyer);
        assertEq(e, expiry);
        assertEq(uint8(s), uint8(DatumEscrow.Status.Open));
        assertEq(sl, seller);
        assertEq(st, settler);
        assertEq(m, MAX_AMOUNT);

        assertEq(usdc.balanceOf(address(escrow)), MAX_AMOUNT);
        assertEq(usdc.balanceOf(buyer), buyerBefore - MAX_AMOUNT);
    }

    function test_openAndFund_emitsOpened() public {
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DatumEscrow.Opened(QUOTE_HASH, buyer, seller, settler, MAX_AMOUNT, expiry);
        _open(settler);
    }

    function test_openAndFund_revertsOnZeroQuoteHash() public {
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.QuoteHashZero.selector);
        escrow.openAndFund(bytes32(0), seller, settler, MAX_AMOUNT, expiry);
    }

    function test_openAndFund_revertsOnDuplicateWhileOpen() public {
        _open(address(0));
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.EscrowExists.selector);
        escrow.openAndFund(QUOTE_HASH, seller, address(0), MAX_AMOUNT, expiry);
    }

    /// A settled quote must never be re-fundable — that would be replay of a spent quote.
    function test_openAndFund_revertsOnReuseAfterSettlement() public {
        _open(address(0));
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);

        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.EscrowExists.selector);
        escrow.openAndFund(QUOTE_HASH, seller, address(0), MAX_AMOUNT, expiry);
    }

    function test_openAndFund_revertsOnReuseAfterExpiry() public {
        _open(address(0));
        vm.warp(expiry + 1);
        escrow.expire(QUOTE_HASH);

        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.EscrowExists.selector);
        escrow.openAndFund(
            QUOTE_HASH, seller, address(0), MAX_AMOUNT, uint64(block.timestamp + 1 days)
        );
    }

    function test_openAndFund_revertsOnZeroSeller() public {
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.SellerZero.selector);
        escrow.openAndFund(QUOTE_HASH, address(0), settler, MAX_AMOUNT, expiry);
    }

    function test_openAndFund_revertsOnZeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.AmountZero.selector);
        escrow.openAndFund(QUOTE_HASH, seller, settler, 0, expiry);
    }

    function test_openAndFund_revertsOnPastExpiry() public {
        vm.warp(1000);
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.ExpiryNotInFuture.selector);
        escrow.openAndFund(QUOTE_HASH, seller, settler, MAX_AMOUNT, uint64(999));
    }

    function test_openAndFund_revertsWhenExpiryEqualsNow() public {
        vm.warp(1000);
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.ExpiryNotInFuture.selector);
        escrow.openAndFund(QUOTE_HASH, seller, settler, MAX_AMOUNT, uint64(1000));
    }

    /// A token that delivers less than it was sent would leave the contract under-funded
    /// relative to the escrow it recorded, silently draining other buyers at settlement.
    function test_openAndFund_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        DatumEscrow fotEscrow = new DatumEscrow(IERC20(address(fot)), treasury, FEE_BPS);
        fot.mint(buyer, MAX_AMOUNT);

        vm.startPrank(buyer);
        fot.approve(address(fotEscrow), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(
                DatumEscrow.UnexpectedAmountReceived.selector,
                MAX_AMOUNT,
                MAX_AMOUNT - MAX_AMOUNT / 100
            )
        );
        fotEscrow.openAndFund(QUOTE_HASH, seller, address(0), MAX_AMOUNT, expiry);
        vm.stopPrank();
    }

    function test_openAndFund_pullsFromCallerOnly() public {
        // A third party with no allowance cannot open an escrow that spends the buyer's funds.
        vm.prank(stranger);
        vm.expectRevert();
        escrow.openAndFund(QUOTE_HASH, seller, address(0), MAX_AMOUNT, expiry);
    }

    // ---------------------------------------------------------------- settle

    function test_settle_atMax_paysSellerNetOfFeeAndTreasuryFee() public {
        _open(address(0));

        uint256 expectedFee = (MAX_AMOUNT * FEE_BPS) / 10_000;
        uint256 expectedSeller = MAX_AMOUNT - expectedFee;
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);

        assertEq(usdc.balanceOf(seller), expectedSeller, "seller receives actualAmount - fee");
        assertEq(usdc.balanceOf(treasury), expectedFee, "treasury receives the fee");
        assertEq(usdc.balanceOf(buyer), buyerBefore, "nothing refunded when settled at max");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow retains nothing");
    }

    function test_settle_belowMax_refundsBuyerAndChargesFeeOnActualOnly() public {
        _open(address(0));

        uint256 actual = MAX_AMOUNT / 4;
        uint256 expectedFee = (actual * FEE_BPS) / 10_000;
        uint256 expectedSeller = actual - expectedFee;
        uint256 expectedRefund = MAX_AMOUNT - actual;
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(seller);
        escrow.settle(QUOTE_HASH, actual, RECEIPT_REF);

        assertEq(usdc.balanceOf(seller), expectedSeller);
        assertEq(usdc.balanceOf(treasury), expectedFee);
        assertEq(usdc.balanceOf(buyer) - buyerBefore, expectedRefund);
        assertEq(usdc.balanceOf(address(escrow)), 0);

        // The fee is charged on actualAmount, never on maxAmount: the buyer's refund is the
        // untouched remainder, with no fee taken out of the portion being returned to them.
        assertEq(expectedRefund, MAX_AMOUNT - actual, "refund excludes any fee");
        uint256 feeOnMax = (MAX_AMOUNT * FEE_BPS) / 10_000;
        assertLt(expectedFee, feeOnMax, "fee is computed on actual, not on max");
    }

    function test_settle_atZero_refundsEverythingToBuyer() public {
        _open(address(0));
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(seller);
        escrow.settle(QUOTE_HASH, 0, RECEIPT_REF);

        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(buyer) - buyerBefore, MAX_AMOUNT);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_settle_emitsSettled() public {
        _open(address(0));
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DatumEscrow.Settled(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settle_revertsWhenAmountExceedsMax() public {
        _open(address(0));
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                DatumEscrow.AmountExceedsMax.selector, MAX_AMOUNT + 1, MAX_AMOUNT
            )
        );
        escrow.settle(QUOTE_HASH, MAX_AMOUNT + 1, RECEIPT_REF);
    }

    function testFuzz_settle_neverPaysOutMoreThanEscrowed(uint256 actual) public {
        _open(address(0));
        actual = bound(actual, 0, MAX_AMOUNT);

        vm.prank(seller);
        escrow.settle(QUOTE_HASH, actual, RECEIPT_REF);

        uint256 fee = (actual * FEE_BPS) / 10_000;
        assertEq(
            usdc.balanceOf(seller) + usdc.balanceOf(treasury), actual, "seller + fee == actual"
        );
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained, never over-drained");
    }

    function test_settle_revertsOnUnknownQuote() public {
        vm.prank(seller);
        vm.expectRevert(DatumEscrow.EscrowNotOpen.selector);
        escrow.settle(keccak256("never-opened"), 1, RECEIPT_REF);
    }

    function test_settle_doubleSettleReverts() public {
        _open(address(0));
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT / 2, RECEIPT_REF);

        vm.prank(seller);
        vm.expectRevert(DatumEscrow.EscrowNotOpen.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT / 2, RECEIPT_REF);
    }

    function test_settle_revertsAfterExpiry() public {
        _open(address(0));
        vm.warp(expiry + 1);
        vm.prank(seller);
        vm.expectRevert(DatumEscrow.PastExpiry.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    /// Boundary: settle is allowed up to and including the expiry timestamp, and expire is only
    /// allowed strictly after it — so exactly one path is live at any instant.
    function test_settle_succeedsAtExactlyExpiry() public {
        _open(address(0));
        vm.warp(expiry);
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_settle_revertsAfterExpireWasCalled() public {
        _open(address(0));
        vm.warp(expiry + 1);
        escrow.expire(QUOTE_HASH);

        vm.warp(expiry); // even if time were rolled back, the escrow is terminal
        vm.prank(seller);
        vm.expectRevert(DatumEscrow.EscrowNotOpen.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settle_zeroFeeContractPaysSellerInFull() public {
        DatumEscrow noFee = new DatumEscrow(IERC20(address(usdc)), treasury, 0);
        vm.startPrank(buyer);
        usdc.approve(address(noFee), type(uint256).max);
        noFee.openAndFund(QUOTE_HASH, seller, address(0), MAX_AMOUNT, expiry);
        vm.stopPrank();

        vm.prank(seller);
        noFee.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);

        assertEq(usdc.balanceOf(seller), MAX_AMOUNT);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ------------------------------------------------- settle authorisation (settler)

    function test_settle_sellerCanSettleWhenNoSettlerAuthorised() public {
        _open(address(0));
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// With settler unset, the address that *would* have been the settler has no authority.
    function test_settle_settlerCannotSettleWhenNotAuthorised() public {
        _open(address(0));
        vm.prank(settler);
        vm.expectRevert(DatumEscrow.NotAuthorisedToSettle.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settle_authorisedSettlerCanSettle() public {
        _open(settler);
        vm.prank(settler);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);

        uint256 fee = (MAX_AMOUNT * FEE_BPS) / 10_000;
        assertEq(usdc.balanceOf(seller), MAX_AMOUNT - fee, "proceeds still go to the seller");
        assertEq(usdc.balanceOf(settler), 0, "the settler is never a payment destination");
    }

    function test_settle_sellerStillSettlesWhenSettlerAuthorised() public {
        _open(settler);
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_settle_thirdPartyCannotSettleWhenSettlerAuthorised() public {
        _open(settler);
        vm.prank(stranger);
        vm.expectRevert(DatumEscrow.NotAuthorisedToSettle.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settle_thirdPartyCannotSettleWhenNoSettlerAuthorised() public {
        _open(address(0));
        vm.prank(stranger);
        vm.expectRevert(DatumEscrow.NotAuthorisedToSettle.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settle_buyerCannotSettleUnlessAuthorisedAsSettler() public {
        _open(address(0));
        vm.prank(buyer);
        vm.expectRevert(DatumEscrow.NotAuthorisedToSettle.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function testFuzz_settle_onlySellerOrSettlerAreAuthorised(address caller) public {
        vm.assume(caller != seller && caller != settler && caller != address(0));
        _open(settler);
        vm.prank(caller);
        vm.expectRevert(DatumEscrow.NotAuthorisedToSettle.selector);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);
    }

    function test_settlerOf_reportsTheAuthorisedSettler() public {
        _open(settler);
        assertEq(escrow.settlerOf(QUOTE_HASH), settler);
    }

    function test_settlerOf_isZeroWhenSellerOnly() public {
        _open(address(0));
        assertEq(escrow.settlerOf(QUOTE_HASH), address(0));
    }

    function test_canSettle_reflectsAuthorityAndLifecycle() public {
        _open(settler);
        assertTrue(escrow.canSettle(QUOTE_HASH, seller));
        assertTrue(escrow.canSettle(QUOTE_HASH, settler));
        assertFalse(escrow.canSettle(QUOTE_HASH, stranger));
        assertFalse(escrow.canSettle(QUOTE_HASH, address(0)));

        vm.warp(expiry + 1);
        assertFalse(escrow.canSettle(QUOTE_HASH, seller), "past expiry nobody can settle");
    }

    // ---------------------------------------------------------------- expire

    function test_expire_returnsEverythingToBuyer() public {
        _open(settler);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.warp(expiry + 1);
        escrow.expire(QUOTE_HASH);

        assertEq(usdc.balanceOf(buyer) - buyerBefore, MAX_AMOUNT);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(treasury), 0, "no fee is taken on an expiry refund");
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_expire_emitsExpired() public {
        _open(address(0));
        vm.warp(expiry + 1);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit DatumEscrow.Expired(QUOTE_HASH, buyer, MAX_AMOUNT);
        escrow.expire(QUOTE_HASH);
    }

    function test_expire_revertsBeforeExpiry() public {
        _open(address(0));
        vm.expectRevert(DatumEscrow.NotYetExpired.selector);
        escrow.expire(QUOTE_HASH);
    }

    function test_expire_revertsAtExactlyExpiry() public {
        _open(address(0));
        vm.warp(expiry);
        vm.expectRevert(DatumEscrow.NotYetExpired.selector);
        escrow.expire(QUOTE_HASH);
    }

    function test_expire_succeedsOneSecondAfterExpiry() public {
        _open(address(0));
        vm.warp(expiry + 1);
        escrow.expire(QUOTE_HASH);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_expire_revertsAfterSettlement() public {
        _open(address(0));
        vm.prank(seller);
        escrow.settle(QUOTE_HASH, MAX_AMOUNT, RECEIPT_REF);

        vm.warp(expiry + 1);
        vm.expectRevert(DatumEscrow.EscrowNotOpen.selector);
        escrow.expire(QUOTE_HASH);
    }

    function test_expire_doubleExpireReverts() public {
        _open(address(0));
        vm.warp(expiry + 1);
        escrow.expire(QUOTE_HASH);

        vm.expectRevert(DatumEscrow.EscrowNotOpen.selector);
        escrow.expire(QUOTE_HASH);
    }

    /// Permissionless by design — but the destination is fixed, so a stranger calling it can
    /// only ever move the money to the buyer who funded it.
    function testFuzz_expire_anyCallerRefundsOnlyTheBuyer(address caller) public {
        vm.assume(caller != address(0) && caller != buyer && caller != address(escrow));
        vm.assume(usdc.balanceOf(caller) == 0);

        _open(address(0));
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.warp(expiry + 1);
        vm.prank(caller);
        escrow.expire(QUOTE_HASH);

        assertEq(usdc.balanceOf(buyer) - buyerBefore, MAX_AMOUNT);
        assertEq(usdc.balanceOf(caller), 0, "the caller gains nothing by triggering expiry");
    }

    // ---------------------------------------------------------------- no ETH custody

    function test_contractRejectsEther() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(escrow).call{value: 1 ether}("");
        assertFalse(ok, "no receive/fallback, so ETH can never become stranded here");
        assertEq(address(escrow).balance, 0);
    }
}
