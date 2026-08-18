// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TouchstoneEscrow} from "../../src/TouchstoneEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * Drives TouchstoneEscrow through arbitrary sequences of open / settle / expire / time-passage, from
 * a small fixed set of actors, so the invariants in TouchstoneEscrow.invariant.t.sol are checked
 * against real state rather than a scripted happy path.
 *
 * Inputs are bounded so a useful fraction of calls succeed — an unbounded fuzzer would spend
 * nearly every call bouncing off `EscrowNotOpen` and exercise almost nothing. Calls that still
 * fail (settling an expired escrow, expiring an open one) are legitimate parts of the search and
 * revert harmlessly, which is why the suite runs with `fail_on_revert = false`.
 */
contract EscrowHandler is CommonBase, StdUtils {
    TouchstoneEscrow public immutable escrow;
    MockUSDC public immutable usdc;

    address[3] public buyers;
    address[2] public sellers;

    bytes32[] public quoteHashes;
    mapping(bytes32 => bool) public known;

    // Ghost accounting, updated only on confirmed success.
    uint256 public ghostOpened;
    uint256 public ghostSettled;
    uint256 public ghostExpired;
    uint256 public ghostTotalDeposited;

    constructor(
        TouchstoneEscrow escrow_,
        MockUSDC usdc_,
        address[3] memory buyers_,
        address[2] memory sellers_
    ) {
        escrow = escrow_;
        usdc = usdc_;
        buyers = buyers_;
        sellers = sellers_;
    }

    function quoteHashCount() external view returns (uint256) {
        return quoteHashes.length;
    }

    function openAndFund(
        uint256 buyerSeed,
        uint256 sellerSeed,
        uint256 amountSeed,
        uint256 expirySeed,
        uint256 settlerSeed
    ) external {
        address buyer = buyers[bound(buyerSeed, 0, buyers.length - 1)];
        address seller = sellers[bound(sellerSeed, 0, sellers.length - 1)];
        uint256 amount = bound(amountSeed, 1, 5_000_000);
        uint64 expiry = uint64(bound(expirySeed, block.timestamp + 1, block.timestamp + 30 days));

        // Sometimes authorise a settler, sometimes leave it seller-only.
        address settler =
            settlerSeed % 3 == 0 ? sellers[bound(settlerSeed, 0, sellers.length - 1)] : address(0);

        bytes32 quoteHash =
            keccak256(abi.encode("q", quoteHashes.length, buyer, seller, amount, expiry));
        if (known[quoteHash]) return;
        if (usdc.balanceOf(buyer) < amount) return;

        vm.prank(buyer);
        try escrow.openAndFund(quoteHash, seller, settler, amount, expiry) {
            quoteHashes.push(quoteHash);
            known[quoteHash] = true;
            ghostOpened++;
            ghostTotalDeposited += amount;
        } catch {}
    }

    function settle(uint256 indexSeed, uint256 amountSeed, uint256 callerSeed) external {
        if (quoteHashes.length == 0) return;
        bytes32 quoteHash = quoteHashes[bound(indexSeed, 0, quoteHashes.length - 1)];

        (,, TouchstoneEscrow.Status status, address seller, address settler, uint256 maxAmount) =
            escrow.escrows(quoteHash);
        if (status != TouchstoneEscrow.Status.Open) return;

        uint256 actual = bound(amountSeed, 0, maxAmount);
        address caller = (settler != address(0) && callerSeed % 2 == 0) ? settler : seller;

        vm.prank(caller);
        try escrow.settle(quoteHash, actual, keccak256(abi.encode("r", quoteHash))) {
            ghostSettled++;
        } catch {}
    }

    /// Deliberately unauthorised: must always revert, and must never move a token.
    function settleUnauthorised(uint256 indexSeed, uint256 amountSeed, address caller) external {
        if (quoteHashes.length == 0) return;
        bytes32 quoteHash = quoteHashes[bound(indexSeed, 0, quoteHashes.length - 1)];
        (,,, address seller, address settler,) = escrow.escrows(quoteHash);
        if (caller == seller || caller == settler || caller == address(0)) return;

        vm.prank(caller);
        try escrow.settle(quoteHash, amountSeed, bytes32(0)) {
            // Reaching here would mean an unauthorised caller settled — the invariant checking
            // total supply across the known actor set will catch the consequence either way.
            ghostSettled++;
        } catch {}
    }

    function expire(uint256 indexSeed) external {
        if (quoteHashes.length == 0) return;
        bytes32 quoteHash = quoteHashes[bound(indexSeed, 0, quoteHashes.length - 1)];

        try escrow.expire(quoteHash) {
            ghostExpired++;
        } catch {}
    }

    function warp(uint256 deltaSeed) external {
        uint256 delta = bound(deltaSeed, 1 hours, 10 days);
        vm.warp(block.timestamp + delta);
    }

    /// Sum of maxAmount across every escrow still Open — what the contract must be holding.
    function sumOpenEscrows() external view returns (uint256 total) {
        for (uint256 i = 0; i < quoteHashes.length; i++) {
            (,, TouchstoneEscrow.Status status,,, uint256 maxAmount) = escrow.escrows(quoteHashes[i]);
            if (status == TouchstoneEscrow.Status.Open) total += maxAmount;
        }
    }
}
