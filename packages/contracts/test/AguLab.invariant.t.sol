// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AguLabFixture} from "./fixtures/AguLabFixture.sol";
import {AguLabHandler} from "./handlers/AguLabHandler.sol";

/**
 * AGU-lab's seven invariants (docs/part5-build-plan.md §5, "AguLab.invariant.t.sol"), fuzzed
 * across arbitrary interleavings of creation, transfers, redemption, rolls (full face and
 * NAV-falling), stray USDC, buffer seeds, time passing and expiry settlement, with an outsider
 * attempting every privileged path. See AguLabHandler.sol for why per-call checks are counters.
 *
 *  1. Per-unit reserve value changes through create and redeem only by dust in holders' favour.
 *  2. The reserve's USDC is zero at every call boundary (stray donations aside, which sit
 *     untouched until the next roll spends them).
 *  3. The buffer's USDC changes only by the seed and carry (in) and roll cover (out).
 *  4. The income ledger only ever receives.
 *  5. Supply changes only through create (up) and redeem (down).
 *  6. For every lot, the claims the contract holds equal its recorded reserve balance.
 *  7. No holder's balance changes except by their own action or as the recipient of a create.
 *
 * Runs with fail-on-revert on, unlike the repository default: the handler is written never to
 * revert (a refused AguLab call is caught and counted), so any handler revert is a bug in the
 * handler that would otherwise silently discard the call, and with it the call's checks. That is
 * how an overflow in the handler's own agent selection was found while this suite was written.
 */
/// forge-config: default.invariant.fail_on_revert = true
contract AguLabInvariantTest is AguLabFixture {
    AguLabHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AguLabHandler(
            usdc,
            bond,
            workClaim,
            buffer,
            lab,
            [holder, agent2, stranger],
            [agent1, makeAddr("agent3")],
            [CLASS_SM, CLASS_PL],
            PUBLISHER_PK,
            RATE,
            BASE
        );
        targetContract(address(handler));
    }

    /// Invariant 1.
    function invariant_1_perUnitValueNeverFallsThroughCreateOrRedeem() public view {
        assertEq(handler.ghostDilutions(), 0, "R3/R4: a create or redeem lowered value per unit");
    }

    /// Invariant 2.
    function invariant_2_reserveHoldsNoUsdcOutsideTheRoll() public view {
        assertEq(
            usdc.balanceOf(address(lab)),
            handler.ghostStray(),
            "Q11: the reserve holds USDC other than unswept stray transfers"
        );
        assertEq(handler.ghostRollEndedHoldingUsdc(), 0, "R5: a roll ended holding USDC");
        assertEq(handler.ghostRedeemMovedUsdc(), 0, "R4: a create or redeem moved USDC");
    }

    /// Invariant 3.
    function invariant_3_bufferMovesOnlyBySeedCarryAndCover() public view {
        assertEq(
            usdc.balanceOf(address(buffer)),
            handler.ghostSeeds() + handler.ghostToBuffer() - handler.ghostCover(),
            "the buffer moved other than by seed, carry and cover"
        );
        assertEq(handler.ghostBufferMovedOutsideRoll(), 0, "the buffer moved outside a roll");
        assertEq(handler.ghostBufferRollMismatch(), 0, "a roll moved the buffer off its figures");
    }

    /// Invariant 4.
    function invariant_4_incomeLedgerOnlyReceives() public view {
        assertEq(handler.ghostIncomeDecreased(), 0, "R7: the income ledger paid something out");
        assertEq(
            usdc.balanceOf(incomeLedger),
            handler.ghostToIncome(),
            "R7: the income ledger received other than carry above target"
        );
    }

    /// Invariant 5.
    function invariant_5_supplyMovesOnlyByCreateAndRedeem() public view {
        assertEq(
            lab.totalSupply(),
            handler.ghostCreated() - handler.ghostRedeemed(),
            "R9: supply moved other than by create and redeem"
        );
        assertEq(handler.ghostSupplyMovedByRoll(), 0, "R9: a roll moved supply");
    }

    /// Invariant 6, plus live face recomputed independently from the ghost record.
    function invariant_6_claimsHeldEqualTheRecordedReserve() public view {
        uint256 live;
        uint256 n = handler.knownLotCount();
        for (uint256 i = 0; i < n; i++) {
            uint256 lot = handler.knownLots(i);
            uint256 held = workClaim.balanceOf(address(lab), lot);
            assertEq(held, handler.ghostLotBalance(lot), "claims held differ from the record");
            assertEq(lab.reserveBalance(lot), held, "reserveBalance differs from claims held");
            if (!handler.ghostRetired(lot) && handler.ghostLotWindowTo(lot) > block.timestamp) {
                live += held;
            }
        }
        assertEq(lab.liveFaceMilli(), live, "live face differs from the live lots' balances");
        assertEq(handler.ghostDeliveryMismatch(), 0, "a redemption delivered off its own figures");
    }

    /// Invariant 7.
    function invariant_7_holdersMoveOnlyByTheirOwnAction() public view {
        address[4] memory who = handler.unitHolders();
        for (uint256 i = 0; i < who.length; i++) {
            assertEq(lab.balanceOf(who[i]), handler.ghostUnits(who[i]), "a holder's units moved");
        }
        address[2] memory agents = handler.agentList();
        for (uint256 i = 0; i < agents.length; i++) {
            assertEq(lab.balanceOf(agents[i]), 0, "an agent received units without acting");
        }
        assertEq(handler.ghostHolderMovedByRoll(), 0, "a roll moved a holder's units");
        assertEq(handler.ghostOutsiderUsdcMovedByRoll(), 0, "R6: a roll took an outsider's USDC");
        assertEq(handler.ghostBuyerPaidOffPrice(), 0, "R5: a sale buyer paid other than the price");
    }

    /// The rest of what the handler watches: outsiders never get through, a correctly built
    /// roll never reverts, and the reserve never presents or draws a bond on expiry.
    function invariant_outsidersAndExpiries() public view {
        assertEq(handler.ghostUnauthorisedSucceeded(), 0, "R2: an outsider used a privileged path");
        assertEq(handler.ghostUnexpectedRollReverts(), 0, "a correctly built roll reverted");
        assertEq(handler.ghostReservePresented(), 0, "the reserve presented a claim");
        assertEq(handler.ghostBondDrawnOnExpiry(), 0, "an expiry drew an issuer's bond");
    }
}

/**
 * Deterministic proof that every path the invariants rely on is reachable (same purpose as
 * WorkClaimHandlerCoverageTest): a full-face roll with cover, a roll with carry, a roll where
 * NAV falls, a redemption, an expiry, and an outsider refused on each privileged path.
 */
contract AguLabHandlerCoverageTest is AguLabFixture {
    function test_handlerReachesEveryPath() public {
        AguLabHandler h = new AguLabHandler(
            usdc,
            bond,
            workClaim,
            buffer,
            lab,
            [holder, agent2, stranger],
            [agent1, makeAddr("agent3")],
            [CLASS_SM, CLASS_PL],
            PUBLISHER_PK,
            RATE,
            BASE
        );

        h.create(0, 1_000, 0); // window 1
        h.create(1, 4_000, 1); // window 2
        assertEq(h.ghostCreates(), 2, "create");
        h.transferUnits(0, 1, 500_000);
        h.redeem(1, 250_000);
        assertEq(h.ghostRedeems(), 1, "redeem");

        vm.warp(BASE + 1 days + 1 hours); // window 1 is the front
        h.roll(5_000, 0, 0);
        assertEq(h.ghostRolls(), 1, "roll");
        assertEq(h.ghostRollsWithCover(), 1, "a roll with cover");

        vm.warp(BASE + 2 days + 1 hours); // window 2 is the front; the buffer cannot pay it all
        h.roll(0, 1, 1);
        assertEq(h.ghostRollsNavFell(), 1, "a roll where NAV falls");

        h.donate(50_000);
        h.roll(0, 0, 0); // nothing left at the front: the stray is all carry
        assertEq(h.ghostRollsWithCarry(), 1, "a roll with carry");

        vm.warp(BASE + 3 days);
        for (uint256 i = 0; i < h.knownLotCount(); i++) {
            h.settleExpired(i);
        }
        assertGt(h.ghostExpiries(), 0, "an expiry");

        h.attackerCover(1);
        h.attackerCreate(10);
        h.attackerRoll();
        assertEq(h.ghostRejectedOutsiders(), 4, "every outsider path refused");
        assertEq(h.ghostUnauthorisedSucceeded(), 0);
        assertEq(h.ghostUnexpectedRollReverts(), 0);
        h.seedBuffer(1);
        h.warp(0);
    }
}
