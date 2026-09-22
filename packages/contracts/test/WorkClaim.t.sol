// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Functional coverage of the real lifecycle — mint, present, serve (pass and fail), default,
/// expire — before the invariant suite fuzzes arbitrary sequences of the same operations.
contract WorkClaimTest is Test {
    MockUSDC internal usdc;
    CapacityBond internal bond;
    ClaimRouter internal router;
    WorkClaim internal claim;

    address internal issuer = makeAddr("issuer");
    address internal buyer = makeAddr("buyer");
    address internal holder2 = makeAddr("holder2");

    bytes32 internal constant CLASS_CODE = keccak256("code");
    uint64 internal windowFrom;
    uint64 internal windowTo;

    function setUp() public {
        usdc = new MockUSDC();

        // Precompute WorkClaim's future address (deployer's next-but-one nonce) so CapacityBond
        // can take it as an immutable constructor parameter — see WorkClaim's own deployment
        // note. This test contract is the deployer for all three.
        uint64 nonce = vm.getNonce(address(this));
        address predictedBondAddr = vm.computeCreateAddress(address(this), nonce);
        address predictedRouterAddr = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedClaimAddr = vm.computeCreateAddress(address(this), nonce + 2);

        bond = new CapacityBond(IERC20(address(usdc)), predictedClaimAddr);
        assertEq(address(bond), predictedBondAddr, "sanity: CapacityBond address prediction");

        router = new ClaimRouter(bond);
        assertEq(address(router), predictedRouterAddr, "sanity: ClaimRouter address prediction");

        claim = new WorkClaim(IERC20(address(usdc)), bond, router);
        assertEq(address(claim), predictedClaimAddr, "sanity: WorkClaim address prediction");

        usdc.mint(issuer, 1_000_000_000);
        vm.prank(issuer);
        usdc.approve(address(bond), type(uint256).max);
        vm.prank(issuer);
        bond.createLot(CLASS_CODE, 1000, 120, 60_000_000); // 1000h * 120 mSIU/h * 0.5 = 60,000 mSIU limit

        usdc.mint(buyer, 1_000_000_000);
        vm.prank(buyer);
        usdc.approve(address(claim), type(uint256).max);

        windowFrom = uint64(block.timestamp + 1 days);
        windowTo = uint64(block.timestamp + 8 days);
    }

    function _mint(uint256 quantity) internal returns (uint256 tokenId) {
        vm.prank(buyer);
        tokenId = claim.mint(CLASS_CODE, quantity, windowFrom, windowTo, 1000); // 1000 = $0.001/mSIU
    }

    function test_mintConsumesHeadroomAndPaysIssuer() public {
        uint256 issuerBalBefore = usdc.balanceOf(issuer);
        uint256 tokenId = _mint(500);

        assertEq(claim.balanceOf(buyer, tokenId), 500);
        // issuanceLimit = 1000h * 120 mSIU/h * 0.5 = 60,000 mSIU — not the 60,000,000 bonded USDC
        // amount from setUp's createLot call, a real mistake this assertion originally made.
        assertEq(bond.headroom(issuer, CLASS_CODE), 60_000 - 500);
        assertEq(usdc.balanceOf(issuer), issuerBalBefore + 500 * 1000);
    }

    function test_presentThenServePass_burnsAndRestoresHeadroom() public {
        uint256 tokenId = _mint(500);

        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));
        assertTrue(claim.everPresented(tokenId, buyer));

        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        vm.prank(issuer);
        claim.serveRedemption(tokenId, buyer, 500, true, keccak256("receipt-1"));

        assertEq(claim.balanceOf(buyer, tokenId), 0, "claim burned on pass");
        assertEq(
            bond.headroom(issuer, CLASS_CODE), headroomBefore + 500, "headroom restored on pass"
        );
    }

    /// Invariant 3, functionally: a failed serve must retire nothing at all.
    function test_serveFail_retiresNothing() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));

        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        vm.prank(issuer);
        claim.serveRedemption(tokenId, buyer, 500, false, keccak256("receipt-1"));

        assertEq(claim.balanceOf(buyer, tokenId), 500, "balance unchanged on fail");
        assertEq(bond.headroom(issuer, CLASS_CODE), headroomBefore, "headroom unchanged on fail");

        // And the holder may re-present and eventually pass within the same window.
        vm.prank(issuer);
        claim.serveRedemption(tokenId, buyer, 500, true, keccak256("receipt-2"));
        assertEq(claim.balanceOf(buyer, tokenId), 0);
    }

    function test_settleWindowClose_defaultsWhenPresentedButNeverServedSuccessfully() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));
        vm.prank(issuer);
        claim.serveRedemption(tokenId, buyer, 500, false, keccak256("receipt-1"));

        vm.warp(windowTo);
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);

        claim.settleWindowClose(tokenId, buyer, 1000);

        assertEq(claim.balanceOf(buyer, tokenId), 0, "burned on default");
        assertEq(
            bond.headroom(issuer, CLASS_CODE), headroomBefore + 500, "headroom restored on default"
        );
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore + 500 * 1000, "bond paid the holder");
    }

    function test_settleWindowClose_expiresWithNoBondDrawWhenNeverPresented() public {
        uint256 tokenId = _mint(500);

        vm.warp(windowTo);
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 bondedBefore = _bondedAmount();

        claim.settleWindowClose(tokenId, buyer, 1000);

        assertEq(claim.balanceOf(buyer, tokenId), 0, "burned on expire");
        assertEq(
            bond.headroom(issuer, CLASS_CODE), headroomBefore + 500, "headroom restored on expire"
        );
        assertEq(usdc.balanceOf(buyer), buyerUsdcBefore, "no bond payout on expire");
        assertEq(_bondedAmount(), bondedBefore, "bond principal untouched on expire");
    }

    /// (committedCapacityHours, measuredRateMilliSiuPerHour, bondedUsdc, outstanding, exists) —
    /// the public mapping getter's tuple order matches CapacityBond.Lot's field declaration order.
    function _bondedAmount() internal view returns (uint256 bondedUsdc) {
        (,, bondedUsdc,,) = bond.lots(issuer, CLASS_CODE);
    }

    function test_settleWindowClose_revertsASecondTime() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowTo);
        claim.settleWindowClose(tokenId, buyer, 1000);

        // AlreadySettled, not NothingToSettle: the contract checks the settled latch before the
        // balance, correctly, since it's the more precise reason — this assertion originally
        // expected the wrong one.
        vm.expectRevert(WorkClaim.AlreadySettled.selector);
        claim.settleWindowClose(tokenId, buyer, 1000);
    }

    function test_serveRedemption_revertsForNonRoutedIssuer() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(WorkClaim.NotTheRoutedIssuer.selector);
        claim.serveRedemption(tokenId, buyer, 500, true, keccak256("r"));
    }

    function test_presentForRedemption_isIdempotent() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.startPrank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));
        claim.presentForRedemption(tokenId, keccak256("task-1-retry"));
        vm.stopPrank();
        assertTrue(claim.everPresented(tokenId, buyer));
    }

    function test_freeTransferSplitsDefaultLiabilityByHolder() public {
        uint256 tokenId = _mint(1000);
        vm.prank(buyer);
        claim.safeTransferFrom(buyer, holder2, tokenId, 400, "");

        // Only the original buyer presents; holder2 never does.
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));

        vm.warp(windowTo);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 holder2UsdcBefore = usdc.balanceOf(holder2);

        claim.settleWindowClose(tokenId, buyer, 1000);
        claim.settleWindowClose(tokenId, holder2, 1000);

        assertGt(usdc.balanceOf(buyer), buyerUsdcBefore, "buyer defaulted and was paid");
        assertEq(usdc.balanceOf(holder2), holder2UsdcBefore, "holder2 expired, no payout");
    }
}
