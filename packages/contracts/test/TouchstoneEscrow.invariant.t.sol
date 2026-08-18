// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowHandler} from "./handlers/EscrowHandler.sol";

/**
 * Conservation of funds across arbitrary sequences of operations — build1-spec.md §10's required
 * fuzz test.
 *
 * The strongest of these is `invariant_noTokensEscapeTheKnownActorSet`. The token is minted only
 * to the three buyers, and the complete set of addresses that could legitimately ever hold it is
 * known: those buyers, the two sellers, the treasury, and the escrow itself. Summing their
 * balances and asserting it equals the total minted means **any** token reaching **any** other
 * address — a settler, an unauthorised caller, an attacker, the handler, address(0) — breaks the
 * sum. That is the literal on-chain statement of "funds can reach only the seller, the buyer, or
 * the fee treasury", checked rather than asserted in a comment.
 */
contract TouchstoneEscrowInvariantTest is Test {
    TouchstoneEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    address internal treasury = makeAddr("treasury");
    address[3] internal buyers;
    address[2] internal sellers;

    uint256 internal constant MINT_PER_BUYER = 50_000_000; // 50 USDC at 6dp
    uint256 internal totalMinted;

    function setUp() public {
        buyers = [makeAddr("buyer1"), makeAddr("buyer2"), makeAddr("buyer3")];
        sellers = [makeAddr("seller1"), makeAddr("seller2")];

        usdc = new MockUSDC();
        escrow = new TouchstoneEscrow(IERC20(address(usdc)), treasury, 50); // 0.5%
        handler = new EscrowHandler(escrow, usdc, buyers, sellers);

        for (uint256 i = 0; i < buyers.length; i++) {
            usdc.mint(buyers[i], MINT_PER_BUYER);
            totalMinted += MINT_PER_BUYER;
            vm.prank(buyers[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }

        targetContract(address(handler));
    }

    /// No token may reach any address outside {buyers, sellers, treasury, escrow}.
    function invariant_noTokensEscapeTheKnownActorSet() public view {
        uint256 total = usdc.balanceOf(address(escrow)) + usdc.balanceOf(treasury);
        for (uint256 i = 0; i < buyers.length; i++) {
            total += usdc.balanceOf(buyers[i]);
        }
        for (uint256 i = 0; i < sellers.length; i++) {
            total += usdc.balanceOf(sellers[i]);
        }
        assertEq(total, totalMinted, "tokens escaped the seller/buyer/treasury set");
    }

    /// The contract holds exactly the funds of its open escrows — never over-funded (which would
    /// mean someone's refund was withheld), never under-funded (which would mean one escrow's
    /// payout came out of another's principal).
    function invariant_escrowBalanceEqualsSumOfOpenEscrows() public view {
        assertEq(
            usdc.balanceOf(address(escrow)),
            handler.sumOpenEscrows(),
            "escrow balance diverged from the sum of its open escrows"
        );
    }

    /// Nothing is created: the contract can never hold more than has ever been deposited into it.
    function invariant_escrowNeverHoldsMoreThanDeposited() public view {
        assertLe(usdc.balanceOf(address(escrow)), handler.ghostTotalDeposited());
    }

    /// The escrow never holds ETH, since it has neither receive nor fallback.
    function invariant_escrowHoldsNoEther() public view {
        assertEq(address(escrow).balance, 0);
    }

    /**
     * Guards against the invariants passing vacuously. Invariants that hold because the fuzzer
     * never managed to open an escrow would be worthless, and would look identical in the output
     * to invariants that hold because the contract is correct — an earlier revision of this file
     * was in exactly that state and looked green.
     *
     * This has to be `afterInvariant` rather than an `invariant_` function: Foundry evaluates
     * invariants once immediately after `setUp`, before any handler call has run, where every
     * ghost counter is legitimately still zero.
     *
     * Only `ghostOpened` is asserted here. `afterInvariant` observes the final run's state, and
     * state is reverted between runs, so whether that particular run happened to settle or expire
     * anything is genuinely random — asserting on it would be flaky. That the settle and expire
     * paths are reachable *through this same handler* is instead proven deterministically by
     * `EscrowHandlerCoverageTest` below.
     */
    function afterInvariant() public view {
        assertGt(handler.ghostOpened(), 0, "fuzzer never opened an escrow");
    }
}

/**
 * Deterministic proof that every operation the fuzzer relies on is actually reachable through
 * the handler. Without this, a handler bug that silently swallowed every `settle` would leave
 * the invariant suite passing over an empty search space.
 */
contract EscrowHandlerCoverageTest is Test {
    function test_handlerReachesOpenSettleAndExpire() public {
        address[3] memory buyers = [makeAddr("b1"), makeAddr("b2"), makeAddr("b3")];
        address[2] memory sellers = [makeAddr("s1"), makeAddr("s2")];

        MockUSDC usdc = new MockUSDC();
        TouchstoneEscrow escrow = new TouchstoneEscrow(IERC20(address(usdc)), makeAddr("treasury"), 50);
        EscrowHandler handler = new EscrowHandler(escrow, usdc, buyers, sellers);

        for (uint256 i = 0; i < buyers.length; i++) {
            usdc.mint(buyers[i], 50_000_000);
            vm.prank(buyers[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }

        handler.openAndFund(0, 0, 1000, 100, 1);
        assertEq(handler.ghostOpened(), 1, "handler can open");

        handler.settle(0, 500, 1);
        assertEq(handler.ghostSettled(), 1, "handler can settle");

        handler.openAndFund(1, 1, 2000, 200, 1);
        handler.warp(type(uint256).max);
        handler.expire(1);
        assertEq(handler.ghostExpired(), 1, "handler can expire");

        // And the unauthorised path is genuinely refused rather than silently counted.
        handler.openAndFund(2, 0, 3000, 300, 1);
        uint256 settledBefore = handler.ghostSettled();
        handler.settleUnauthorised(2, 1, makeAddr("intruder"));
        assertEq(handler.ghostSettled(), settledBefore, "unauthorised settle must not succeed");
    }
}
