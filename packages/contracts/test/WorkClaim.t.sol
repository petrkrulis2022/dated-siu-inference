// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {RateAttestationVerifier} from "../src/RateAttestationVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
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

    /// The real 2026-09-22 print's dated_siu ($0.0107/SIU), not a round illustrative number —
    /// deliberately, since this is exactly the precision test_mintPricingHoldsRealPrintRateExactly
    /// below needs. nanoUsdPerSiu = 0.0107 * 1e9 = 10_700_000 — RateAttestationVerifier's scale,
    /// not the old microUsdPerSiu one — see WorkClaim.sol's "Price precision" doc comment.
    uint256 internal constant PRICE_NANO_USD_PER_SIU = 10_700_000;

    /// The test-only key WorkClaim trusts as its rate-attestation publisher — a real secp256k1
    /// key/signature pair via vm.sign, not a stub, same discipline as every other real signature
    /// this repo tests (packages/print/src/sign/sign.test.ts).
    uint256 internal constant PUBLISHER_PK = 0xA11CE;
    address internal publisher = vm.addr(PUBLISHER_PK);

    string internal constant PRINT_ID = "2026-09-22";

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

        claim = new WorkClaim(IERC20(address(usdc)), bond, router, publisher);
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

    /// Signs a real RateAttestation with PUBLISHER_PK, against WorkClaim's own real domain
    /// separator (`claim.rateAttestationDomainSeparator()` — never recomputed by hand here, so
    /// this test can't silently drift from what the contract actually verifies).
    function _signRate(uint256 nanoUsdPerSiu, string memory printId, uint64 validUntil)
        internal
        view
        returns (RateAttestationVerifier.RateAttestation memory att, bytes memory signature)
    {
        return _signRateAs(PUBLISHER_PK, nanoUsdPerSiu, printId, validUntil);
    }

    function _signRateAs(uint256 signerPk, uint256 nanoUsdPerSiu, string memory printId, uint64 validUntil)
        internal
        view
        returns (RateAttestationVerifier.RateAttestation memory att, bytes memory signature)
    {
        att = RateAttestationVerifier.RateAttestation({
            printId: printId,
            nanoUsdPerSiu: nanoUsdPerSiu,
            validUntil: validUntil
        });
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("RateAttestation(string printId,uint256 nanoUsdPerSiu,uint64 validUntil)"),
                keccak256(bytes(att.printId)),
                att.nanoUsdPerSiu,
                att.validUntil
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", claim.rateAttestationDomainSeparator(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _realRate() internal view returns (RateAttestationVerifier.RateAttestation memory att, bytes memory signature) {
        return _signRate(PRICE_NANO_USD_PER_SIU, PRINT_ID, uint64(block.timestamp + 365 days));
    }

    function _mint(uint256 quantity) internal returns (uint256 tokenId) {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        vm.prank(buyer);
        tokenId = claim.mint(CLASS_CODE, quantity, windowFrom, windowTo, att, sig);
    }

    function _settle(uint256 tokenId, address holder) internal {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        claim.settleWindowClose(tokenId, holder, att, sig);
    }

    function test_mintConsumesHeadroomAndPaysIssuer() public {
        uint256 issuerBalBefore = usdc.balanceOf(issuer);
        uint256 tokenId = _mint(500);

        assertEq(claim.balanceOf(buyer, tokenId), 500);
        // issuanceLimit = 1000h * 120 mSIU/h * 0.5 = 60,000 mSIU — not the 60,000,000 bonded USDC
        // amount from setUp's createLot call, a real mistake this assertion originally made.
        assertEq(bond.headroom(issuer, CLASS_CODE), 60_000 - 500);
        // 500 mSIU * $0.0107/SIU = 0.5 SIU * $0.0107/SIU = $0.00535 = 5350 USDC minor units —
        // exact here since 500 is a multiple of the formula's /1000 divisor; the non-round-
        // quantity case (real truncation bound) is exercised by
        // test_mintPricingHoldsRealPrintRateExactly below.
        assertEq(
            usdc.balanceOf(issuer), issuerBalBefore + (500 * PRICE_NANO_USD_PER_SIU) / 1_000_000
        );
    }

    /// The regression test for the bug review flagged 2026-09-22: the prior parameter
    /// (usdPerMilliSiu, whole USDC-minor-units per mSIU) could only represent USD/SIU prices in
    /// $0.001 steps, one decimal digit too coarse for dated_siu's own published 4-decimal-place
    /// precision — silently truncating a real rate like $0.0107/SIU to $0.010 or $0.011/SIU, a
    /// multi-percent error on every real mint, invisible to the invariant suite because its
    /// fixtures use round test prices, not real print magnitudes. Proven here with a
    /// deliberately non-round quantity (333 mSIU) so the division doesn't cancel out by luck.
    function test_mintPricingHoldsRealPrintRateExactly() public {
        uint256 issuerBalBefore = usdc.balanceOf(issuer);
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        vm.prank(buyer);
        claim.mint(CLASS_CODE, 333, windowFrom, windowTo, att, sig);

        // Exact value: 0.333 SIU * $0.0107/SIU = $0.0035631 = 3563.1 USDC minor units. The
        // contract truncates the fractional minor unit (Solidity has no fractional minor units),
        // landing on 3563 — off by 0.1 minor unit (1e-7 USD), the bound WorkClaim.sol's own
        // "Price precision" doc comment states: under 1 minor unit *total*, not per mSIU.
        assertEq(
            usdc.balanceOf(issuer),
            issuerBalBefore + 3563,
            "real print rate must hold exactly, not round to the nearest $0.001/SIU step"
        );
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

        _settle(tokenId, buyer);

        assertEq(claim.balanceOf(buyer, tokenId), 0, "burned on default");
        assertEq(
            bond.headroom(issuer, CLASS_CODE), headroomBefore + 500, "headroom restored on default"
        );
        assertEq(
            usdc.balanceOf(buyer),
            buyerUsdcBefore + (500 * PRICE_NANO_USD_PER_SIU) / 1_000_000,
            "bond paid the holder"
        );
    }

    function test_settleWindowClose_expiresWithNoBondDrawWhenNeverPresented() public {
        uint256 tokenId = _mint(500);

        vm.warp(windowTo);
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        uint256 bondedBefore = _bondedAmount();

        _settle(tokenId, buyer);

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
        _settle(tokenId, buyer);

        // Signed before expectRevert, deliberately: vm.expectRevert treats the very next
        // external call as "the" call under test, and _realRate()'s own
        // rateAttestationDomainSeparator() staticcall would otherwise be mistaken for it,
        // consuming the expectation before settleWindowClose ever runs — found live writing
        // this test.
        (WorkClaim.RateAttestation memory att, bytes memory sig) = _realRate();
        // AlreadySettled, not NothingToSettle: the contract checks the settled latch before the
        // balance, correctly, since it's the more precise reason — this assertion originally
        // expected the wrong one.
        vm.expectRevert(WorkClaim.AlreadySettled.selector);
        claim.settleWindowClose(tokenId, buyer, att, sig);
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

        _settle(tokenId, buyer);
        _settle(tokenId, holder2);

        assertGt(usdc.balanceOf(buyer), buyerUsdcBefore, "buyer defaulted and was paid");
        assertEq(usdc.balanceOf(holder2), holder2UsdcBefore, "holder2 expired, no payout");
    }

    // ------------------------------------------------------------------ rate-attestation binding
    // The real fix (WorkClaim.sol's own "Settlement-rate binding" doc comment): mint and default
    // settlement used to take the rate as a bare, unverified uint256. These four cases are the
    // ones review asked to be shown fuzzed/negative-tested explicitly, plus the expiry guard the
    // mechanism itself depends on.

    /// A genuine publisher signature over one rate does not authorise a *different* rate — the
    /// signature is over the whole struct, not just the printId, so tampering with
    /// nanoUsdPerSiu after signing must invalidate it.
    function test_mint_revertsOnTamperedRate() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        att.nanoUsdPerSiu = att.nanoUsdPerSiu + 1; // tampered after signing, signature unchanged

        vm.prank(buyer);
        vm.expectRevert(); // InvalidRateAttestation(recovered, publisher) — recovered != publisher
        claim.mint(CLASS_CODE, 500, windowFrom, windowTo, att, sig);
    }

    /// A well-formed attestation signed by any key other than the registered publisher must be
    /// rejected — the entire point of the fix. `attackerPk` signs a structurally identical
    /// message; only the signer differs.
    function test_settleWindowClose_revertsOnAttestationFromWrongSigner() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));
        vm.warp(windowTo);

        uint256 attackerPk = 0xBAD;
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRateAs(attackerPk, PRICE_NANO_USD_PER_SIU, PRINT_ID, uint64(block.timestamp + 1 days));

        vm.expectRevert(); // InvalidRateAttestation(recovered, publisher) — recovered == vm.addr(attackerPk)
        claim.settleWindowClose(tokenId, buyer, att, sig);
    }

    /// An expired attestation — genuinely signed by the real publisher, for the real rate — must
    /// still be rejected once `validUntil` has passed. The standard EIP-712 replay guard; without
    /// it a single real attestation would stay usable forever.
    function test_mint_revertsOnExpiredAttestation() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(PRICE_NANO_USD_PER_SIU, PRINT_ID, uint64(block.timestamp));
        vm.warp(block.timestamp + 1);

        vm.prank(buyer);
        vm.expectRevert(); // RateAttestationExpired(validUntil, currentTimestamp)
        claim.mint(CLASS_CODE, 500, windowFrom, windowTo, att, sig);
    }

    /// `printId` is accepted opaquely — RateAttestationVerifier.sol's own doc comment states
    /// plainly that this contract does not check it against the claim's own window, and that
    /// staying honest about that (rather than a false sense of enforcement) is deliberate.
    /// Confirmed here for real, not just asserted in prose: a genuine attestation for a printId
    /// that obviously doesn't match this claim's own class/window still succeeds.
    function test_mint_acceptsGenuineAttestationForAnyPrintId_printIdIsNotEnforcedOnChain() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(PRICE_NANO_USD_PER_SIU, "2099-01-01-not-the-real-print", uint64(block.timestamp + 1 days));

        vm.prank(buyer);
        uint256 tokenId = claim.mint(CLASS_CODE, 500, windowFrom, windowTo, att, sig);
        assertEq(claim.balanceOf(buyer, tokenId), 500);
    }

    /// `RateAttestationVerifier._verifyRateAttestation` calls `ECDSA.recoverCalldata`, not raw
    /// `ecrecover` — this confirms, explicitly, rather than leaving it to incidental coverage,
    /// that a real high-s (malleable) signature is rejected. Built from a genuine signature by
    /// flipping to its mathematically valid malleable counterpart (same signer, same hash) —
    /// exactly the transformation OZ's own ECDSA.sol doc comment describes — not a fabricated s.
    function test_mint_revertsOnHighSMalleableSignature() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        require(sig.length == 65, "sanity: expected a 65-byte r||s||v signature");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        bytes32 highS = bytes32(SECP256K1_ORDER - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory malleableSig = abi.encodePacked(r, highS, flippedV);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        claim.mint(CLASS_CODE, 500, windowFrom, windowTo, att, malleableSig);
    }

    /// Confirms, explicitly, that `ecrecover` returning `address(0)` (a malformed-but-65-byte
    /// signature — r=0 is not a valid curve point x-coordinate) is rejected rather than silently
    /// treated as "recovered to the zero address, which happens not to equal publisher anyway".
    /// `ECDSA.recoverCalldata` reverts with `ECDSAInvalidSignature` before this contract's own
    /// `recovered != publisher` check is ever reached.
    function test_mint_revertsOnZeroAddressRecovery() public {
        (RateAttestationVerifier.RateAttestation memory att,) = _realRate();
        bytes memory degenerateSig = abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27));

        vm.prank(buyer);
        vm.expectRevert(ECDSA.ECDSAInvalidSignature.selector);
        claim.mint(CLASS_CODE, 500, windowFrom, windowTo, att, degenerateSig);
    }
}
