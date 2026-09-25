// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {WorkClaimHandler} from "./handlers/WorkClaimHandler.sol";

/**
 * The four ways value can leak from this system, per review 2026-09-22, each fuzzed across
 * arbitrary interleavings of mint / present / serve (pass and fail) / transfer / window-close,
 * from multiple issuers and multiple holders:
 *
 *  1. Minting free work — access control. `invariant_noUnauthorisedServeEverSucceeded`.
 *  2. Inflating headroom — serve idempotency + invariant 3 itself.
 *     `invariant_outstandingEqualsSumOfLiveClaims` (aggregate) and WorkClaimHandler.serveFail's
 *     own inline assertion (per-call, the property review asked to fuzz hardest).
 *  3. Draining the bond — default idempotency. `invariant_noDoubleSettlementEverSucceeded`.
 *  4. USDC escaping the known actor set entirely — the same conservation check
 *     TouchstoneEscrow.invariant.t.sol already runs, adapted for issuers/bond/holders.
 *
 * @custom:forge-config default.invariant.runs = 10000
 */
contract WorkClaimInvariantTest is Test {
    MockUSDC internal usdc;
    CapacityBond internal bond;
    ClaimRouter internal router;
    WorkClaim internal claim;
    WorkClaimHandler internal handler;

    address[2] internal issuers;
    address[3] internal holders;
    address internal attacker;

    /// Same test-only publisher key/signature discipline as WorkClaim.t.sol — real secp256k1,
    /// not a stub. The handler holds the key itself (constructor below) since it's the one
    /// actually calling mint/settleWindowClose during fuzzing.
    uint256 internal constant PUBLISHER_PK = 0xA11CE;
    address internal publisher = vm.addr(PUBLISHER_PK);

    bytes32 internal constant CLASS_A = keccak256("classA");
    bytes32 internal constant CLASS_B = keccak256("classB");

    uint256 internal totalMinted;

    function setUp() public {
        issuers = [makeAddr("issuerA"), makeAddr("issuerB")];
        holders = [makeAddr("holder1"), makeAddr("holder2"), makeAddr("holder3")];
        attacker = makeAddr("attacker");

        usdc = new MockUSDC();

        uint64 nonce = vm.getNonce(address(this));
        address predictedClaimAddr = vm.computeCreateAddress(address(this), nonce + 2);
        bond = new CapacityBond(IERC20(address(usdc)), predictedClaimAddr);
        router = new ClaimRouter(bond);
        claim = new WorkClaim(IERC20(address(usdc)), bond, router, publisher);
        require(address(claim) == predictedClaimAddr, "sanity: address prediction");

        // Both issuers bond into both classes — real cross-issuer routing pressure, matching the
        // review's "multiple claims and issuers" fuzz target.
        for (uint256 i = 0; i < issuers.length; i++) {
            usdc.mint(issuers[i], 10_000_000_000);
            totalMinted += 10_000_000_000;
            vm.startPrank(issuers[i]);
            usdc.approve(address(bond), type(uint256).max);
            bond.createLot(CLASS_A, 1000, 500, 1_000_000_000);
            bond.createLot(CLASS_B, 1000, 500, 1_000_000_000);
            vm.stopPrank();
        }

        for (uint256 i = 0; i < holders.length; i++) {
            usdc.mint(holders[i], 5_000_000_000);
            totalMinted += 5_000_000_000;
            vm.prank(holders[i]);
            usdc.approve(address(claim), type(uint256).max);
        }

        handler =
            new WorkClaimHandler(usdc, bond, router, claim, issuers, holders, attacker, PUBLISHER_PK);
        // The handler itself mints more USDC to holders/issuers as needed mid-run — tracked via
        // the handler's own balance-based conservation check below rather than a fixed ghost
        // total, since MockUSDC.mint is permissionless and the handler uses it freely.
        targetContract(address(handler));
    }

    /// The strongest single check: outstanding headroom consumption for every (issuer, class)
    /// pair must equal the real, live sum of every known holder's ERC-1155 balance backed by
    /// that pair — computed from actual on-chain balances, not a ghost total. Breaks if any
    /// terminal path (redeem, default, expire) fails to restore headroom, or if headroom is ever
    /// restored without a real burn.
    function invariant_outstandingEqualsSumOfLiveClaims() public view {
        address[2] memory allIssuers = [issuers[0], issuers[1]];
        bytes32[2] memory allClasses = [CLASS_A, CLASS_B];
        for (uint256 i = 0; i < allIssuers.length; i++) {
            for (uint256 c = 0; c < allClasses.length; c++) {
                (,,, uint256 outstanding,) = bond.lots(allIssuers[i], allClasses[c]);
                assertEq(
                    outstanding,
                    handler.sumLiveClaims(allIssuers[i], allClasses[c]),
                    "outstanding diverged from the real sum of live claim balances"
                );
            }
        }
    }

    /// Headroom and outstanding must never together exceed the issuance limit — the algebraic
    /// identity headroom() is built on, checked directly against contract state as a guard
    /// against an underflow/overflow bug rather than trusted from the view function's own math.
    function invariant_headroomPlusOutstandingEqualsIssuanceLimit() public view {
        address[2] memory allIssuers = [issuers[0], issuers[1]];
        bytes32[2] memory allClasses = [CLASS_A, CLASS_B];
        for (uint256 i = 0; i < allIssuers.length; i++) {
            for (uint256 c = 0; c < allClasses.length; c++) {
                uint256 limit = bond.issuanceLimit(allIssuers[i], allClasses[c]);
                uint256 h = bond.headroom(allIssuers[i], allClasses[c]);
                (,,, uint256 outstanding,) = bond.lots(allIssuers[i], allClasses[c]);
                assertEq(
                    h + outstanding,
                    limit,
                    "headroom + outstanding diverged from the issuance limit"
                );
            }
        }
    }

    /// Property 1: minting free work. An unrouted party's forged "pass" must never succeed.
    function invariant_noUnauthorisedServeEverSucceeded() public view {
        assertEq(
            handler.ghostUnauthorisedServeSucceeded(), 0, "an unrouted party forged a passing serve"
        );
    }

    /// Property 3: draining the bond. A second settlement of an already-terminal claim must
    /// never succeed.
    function invariant_noDoubleSettlementEverSucceeded() public view {
        assertEq(
            handler.ghostDoubleServeOnRetiredSucceeded(),
            0,
            "a defaulted/expired claim was settled twice"
        );
    }

    /// Property 4: no USDC reaches any address outside the known actor set — same conservation
    /// shape as TouchstoneEscrow.invariant.t.sol, adapted for this system's actors (issuers and
    /// the bond hold funds too, not just a single escrow).
    function invariant_noUsdcEscapesTheKnownActorSet() public view {
        uint256 total = usdc.balanceOf(address(bond)) + usdc.balanceOf(address(claim));
        for (uint256 i = 0; i < issuers.length; i++) {
            total += usdc.balanceOf(issuers[i]);
        }
        for (uint256 i = 0; i < holders.length; i++) {
            total += usdc.balanceOf(holders[i]);
        }
        total += usdc.balanceOf(attacker);
        assertEq(total, usdc.totalSupply(), "USDC escaped the known actor set");
    }

    /// No afterInvariant coverage guard at all — deliberately, found live, 2026-09-22, in two
    /// steps. First cut: assert every rarer ghost counter (serveFail, unauthorised-serve,
    /// double-settlement) — exactly the TouchstoneEscrow.invariant.t.sol lesson about per-run
    /// flakiness, applied incompletely. Second cut, after this suite still failed intermittently
    /// even asserting *only* `ghostMints > 0`: at depth 80 spread across 9 handler functions, the
    /// probability any single function gets zero calls in one independent run is (8/9)^80 ≈
    /// 1-in-7,250 — negligible at TouchstoneEscrow's own 256 runs, but at the 10,000 runs review
    /// asked for specifically for invariant 3, the expected count of "some run never called mint"
    /// is ~1.4, which is exactly the intermittent failure observed, confirmed by rerunning at
    /// full scale: 800,000 real calls, zero reverts, every invariant_ function's own body held
    /// throughout — only this afterInvariant guard ever failed, and only because of which
    /// function distribution one particular run happened to draw. TouchstoneEscrow's afterInvariant
    /// is safe specifically because it runs at 256, not 10,000; this suite can't borrow that
    /// pattern at this scale. Reachability of every handler function is instead proven
    /// deterministically, unconditionally, by WorkClaimHandlerCoverageTest below.
}

/**
 * Deterministic proof every path the handler and the invariants above rely on is actually
 * reachable — same purpose as EscrowHandlerCoverageTest in TouchstoneEscrow.invariant.t.sol.
 */
contract WorkClaimHandlerCoverageTest is Test {
    /// Extracted from the test itself purely to keep function-local variable counts under the
    /// EVM's stack-depth limit ("stack too deep") — solc's own error naming this exact spot once
    /// the rate-attestation publisher key/address were added inline. Split into two helpers, not
    /// one, because even the single-helper version still tripped the same limit.
    struct DeployedContracts {
        MockUSDC usdc;
        CapacityBond bond;
        ClaimRouter router;
        WorkClaim claim;
    }

    function _deployContracts(address publisher) internal returns (DeployedContracts memory d) {
        d.usdc = new MockUSDC();
        uint64 nonce = vm.getNonce(address(this));
        address predictedClaimAddr = vm.computeCreateAddress(address(this), nonce + 2);
        d.bond = new CapacityBond(IERC20(address(d.usdc)), predictedClaimAddr);
        d.router = new ClaimRouter(d.bond);
        d.claim = new WorkClaim(IERC20(address(d.usdc)), d.bond, d.router, publisher);
        require(address(d.claim) == predictedClaimAddr);
    }

    function _fundAndDeployHandler(
        DeployedContracts memory d,
        address[2] memory issuers,
        address[3] memory holders,
        address attacker,
        bytes32 classA,
        uint256 publisherPk
    ) internal returns (WorkClaimHandler handler) {
        d.usdc.mint(issuers[0], 10_000_000_000);
        vm.startPrank(issuers[0]);
        d.usdc.approve(address(d.bond), type(uint256).max);
        d.bond.createLot(classA, 1000, 500, 1_000_000_000);
        vm.stopPrank();
        for (uint256 i = 0; i < holders.length; i++) {
            d.usdc.mint(holders[i], 5_000_000_000);
            vm.prank(holders[i]);
            d.usdc.approve(address(d.claim), type(uint256).max);
        }

        handler = new WorkClaimHandler(
            d.usdc, d.bond, d.router, d.claim, issuers, holders, attacker, publisherPk
        );
    }

    function _deployHandler(
        address[2] memory issuers,
        address[3] memory holders,
        address attacker,
        bytes32 classA,
        uint256 publisherPk
    ) internal returns (WorkClaim claim, WorkClaimHandler handler) {
        DeployedContracts memory d = _deployContracts(vm.addr(publisherPk));
        handler = _fundAndDeployHandler(d, issuers, holders, attacker, classA, publisherPk);
        claim = d.claim;
    }

    function test_handlerReachesEveryLifecyclePath() public {
        address[2] memory issuers = [makeAddr("i1"), makeAddr("i2")];
        address[3] memory holders = [makeAddr("h1"), makeAddr("h2"), makeAddr("h3")];
        address attacker = makeAddr("attacker");
        bytes32 classA = keccak256("classA");

        (WorkClaim claim, WorkClaimHandler handler) =
            _deployHandler(issuers, holders, attacker, classA, 0xA11CE);

        handler.mint(0, 0, 100, 1);
        assertEq(handler.ghostMints(), 1, "handler can mint");

        uint256 tokenId = handler.knownTokenIds(0);
        (,, uint64 windowFrom,,) = claim.claimTypes(tokenId);
        vm.warp(windowFrom); // exactly the real window this mint used, not a guessed offset
        handler.present(0, 0, 1);
        assertEq(handler.ghostPresents(), 1, "handler can present");

        handler.serveFail(0, 0, 10);
        assertEq(handler.ghostServeFails(), 1, "handler can serve-fail");

        handler.servePass(0, 0, 10);
        assertEq(handler.ghostServePasses(), 1, "handler can serve-pass");

        handler.transfer(0, 0, 1, 20);
        assertEq(handler.ghostTransfers(), 1, "handler can transfer");

        handler.attackerServeUnrouted(0, 1, 5);
        assertEq(handler.ghostRejectedUnauthorisedServes(), 1, "unauthorised serve is rejected");
        assertEq(
            handler.ghostUnauthorisedServeSucceeded(), 0, "unauthorised serve must never succeed"
        );

        handler.warp(type(uint32).max);
        handler.settleWindowClose(0, 0);
        uint256 defaultsOrExpires = handler.ghostDefaults() + handler.ghostExpires();
        assertGt(defaultsOrExpires, 0, "handler can settle a window close");

        handler.attackerDoubleSettle(0, 0);
        assertGt(handler.ghostRejectedDoubleServesOnRetired(), 0, "double settlement is rejected");
        assertEq(
            handler.ghostDoubleServeOnRetiredSucceeded(), 0, "double settlement must never succeed"
        );
    }
}
