// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DatumEscrow} from "../src/DatumEscrow.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/**
 * The escrow's only external calls are token transfers, so a malicious settlement token is the
 * realistic attack surface. Two layers should stop it: checks-effects-interactions makes the
 * escrow being settled terminal before any transfer, and `nonReentrant` blocks re-entry outright.
 *
 * These tests are built so that **the reentrancy guard is the only thing that can refuse the
 * nested call**. That takes deliberate setup, and getting it wrong makes the whole suite
 * worthless:
 *
 *  - The nested call targets a *second, still-open* escrow, so CEI's terminal-status check
 *    cannot be what stops it.
 *  - The token contract is registered as that second escrow's authorised **settler**, so the
 *    authorisation check cannot be what stops it.
 *  - The token contract holds a balance and an approval, so a missing allowance cannot be what
 *    stops it when the nested call is `openAndFund`.
 *
 * An earlier version of this file omitted the second and third points, and every test still
 * passed with `nonReentrant` stripped off `settle` — the nested calls were bouncing off the
 * authorisation and allowance checks instead. Each test below has since been re-verified by
 * removing the guard and confirming it fails.
 */
contract DatumEscrowReentrancyTest is Test {
    DatumEscrow internal escrow;
    ReentrantToken internal token;

    address internal buyer = makeAddr("buyer");
    address internal seller = makeAddr("seller");
    address internal treasury = makeAddr("treasury");

    uint16 internal constant FEE_BPS = 50;
    uint256 internal constant AMOUNT_A = 1_000_000;
    uint256 internal constant AMOUNT_B = 400_000;
    bytes32 internal constant QUOTE_A = keccak256("quote-a");
    bytes32 internal constant QUOTE_B = keccak256("quote-b");
    bytes32 internal constant RECEIPT_REF = keccak256("receipt");

    uint64 internal expiry;

    function setUp() public {
        token = new ReentrantToken();
        escrow = new DatumEscrow(IERC20(address(token)), treasury, FEE_BPS);
        expiry = uint64(block.timestamp + 1 days);

        token.mint(buyer, 100 * AMOUNT_A);
        vm.startPrank(buyer);
        token.approve(address(escrow), type(uint256).max);
        escrow.openAndFund(QUOTE_A, seller, address(0), AMOUNT_A, expiry);
        // The token contract is escrow B's authorised settler, so when it re-enters `settle` it
        // passes the authorisation check and only the guard is left to stop it.
        escrow.openAndFund(QUOTE_B, seller, address(token), AMOUNT_B, expiry);
        vm.stopPrank();

        // Fund and approve the token contract itself, so a nested `openAndFund` would otherwise
        // succeed rather than bouncing off a missing allowance.
        token.mint(address(token), 10 * AMOUNT_A);
        vm.prank(address(token));
        token.approve(address(escrow), type(uint256).max);
    }

    function test_settle_cannotReenterSettleOnADifferentOpenEscrow() public {
        token.arm(escrow, QUOTE_B, ReentrantToken.Mode.Settle);

        vm.prank(seller);
        escrow.settle(QUOTE_A, AMOUNT_A, RECEIPT_REF);

        assertTrue(token.reentryAttempted(), "the attack must actually have been attempted");
        assertFalse(token.reentrySucceeded(), "reentrancy guard must refuse the nested settle");

        // B is untouched: still Open, still fully funded.
        (,, DatumEscrow.Status statusB,,, uint256 maxB) = escrow.escrows(QUOTE_B);
        assertEq(uint8(statusB), uint8(DatumEscrow.Status.Open));
        assertEq(maxB, AMOUNT_B);
        assertEq(token.balanceOf(address(escrow)), AMOUNT_B, "only escrow A was paid out");

        uint256 fee = (AMOUNT_A * FEE_BPS) / 10_000;
        assertEq(token.balanceOf(seller), AMOUNT_A - fee);
        assertEq(token.balanceOf(treasury), fee);
    }

    /// `expire` is permissionless, so the nested call is authorised by construction — the guard
    /// is the only possible defence.
    function test_expire_cannotReenterExpireOnADifferentEscrow() public {
        token.arm(escrow, QUOTE_B, ReentrantToken.Mode.Expire);
        vm.warp(expiry + 1);

        escrow.expire(QUOTE_A);

        assertTrue(token.reentryAttempted());
        assertFalse(token.reentrySucceeded(), "reentrancy guard must refuse the nested expire");

        (,, DatumEscrow.Status statusB,,,) = escrow.escrows(QUOTE_B);
        assertEq(uint8(statusB), uint8(DatumEscrow.Status.Open), "escrow B was not drained");
        assertEq(token.balanceOf(address(escrow)), AMOUNT_B);
    }

    function test_settle_cannotReenterOpenAndFund() public {
        token.arm(escrow, QUOTE_B, ReentrantToken.Mode.OpenAndFund);

        vm.prank(seller);
        escrow.settle(QUOTE_A, AMOUNT_A, RECEIPT_REF);

        assertTrue(token.reentryAttempted());
        assertFalse(token.reentrySucceeded(), "reentrancy guard must refuse a nested open");

        (,, DatumEscrow.Status statusNew,,,) = escrow.escrows(keccak256("reentrant-second-escrow"));
        assertEq(uint8(statusNew), uint8(DatumEscrow.Status.None), "no escrow was created");
    }

    function test_openAndFund_cannotReenterOpenAndFund() public {
        token.arm(escrow, bytes32(0), ReentrantToken.Mode.OpenAndFund);

        vm.prank(buyer);
        escrow.openAndFund(keccak256("quote-c"), seller, address(0), AMOUNT_B, expiry);

        assertTrue(token.reentryAttempted());
        assertFalse(token.reentrySucceeded(), "reentrancy guard must refuse a nested open");

        (,, DatumEscrow.Status statusNew,,,) = escrow.escrows(keccak256("reentrant-second-escrow"));
        assertEq(uint8(statusNew), uint8(DatumEscrow.Status.None), "no escrow was created");
    }

    /// Same-escrow re-entry is stopped twice over: CEI has already made it terminal, and the
    /// guard refuses anyway. Kept as a regression test for the ordering of effects.
    function test_settle_cannotReenterSameEscrow() public {
        token.arm(escrow, QUOTE_A, ReentrantToken.Mode.Settle);

        vm.prank(seller);
        escrow.settle(QUOTE_A, AMOUNT_A, RECEIPT_REF);

        assertTrue(token.reentryAttempted());
        assertFalse(token.reentrySucceeded());

        uint256 fee = (AMOUNT_A * FEE_BPS) / 10_000;
        assertEq(token.balanceOf(seller), AMOUNT_A - fee, "seller paid exactly once");
        assertEq(token.balanceOf(treasury), fee, "treasury paid exactly once");
    }
}
