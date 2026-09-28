// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {ITouchstoneEscrow} from "../src/WorkClaim.sol";
import {RateAttestationVerifier} from "../src/RateAttestationVerifier.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Functional coverage of the real lifecycle — mint, present, serve (pass and fail), default,
/// expire — before the invariant suite fuzzes arbitrary sequences of the same operations.
contract WorkClaimTest is Test {
    MockUSDC internal usdc;
    /// Real, not mocked: `WorkClaim.reserveForWork` reads this escrow's own state to decide
    /// whether a reservation may exist at all, so a stub would test nothing.
    TouchstoneEscrow internal escrowForClaims;
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

    /// Cached once in setUp(), never queried inline again — found live, 2026-09-27: calling
    /// `claim.SERIES_COMMODITY()` (an external staticcall) as an argument expression between
    /// `vm.prank(buyer)` and the pranked `claim.mint(...)` call consumes the prank itself (`vm.prank`
    /// arms only the very next external call frame, and Solidity evaluates call arguments, including
    /// this one, before making the outer call), so `mint`/`settleWindowClose` silently executed as
    /// the test contract instead of `buyer`. Caching the value as a plain state read removes the
    /// external call entirely, wherever `_series()` is used.
    bytes32 internal fixtureSeries;

    function setUp() public {
        usdc = new MockUSDC();

        // Precompute WorkClaim's future address (deployer's next-but-one nonce) so CapacityBond
        // can take it as an immutable constructor parameter — see WorkClaim's own deployment
        // note. This test contract is the deployer for all three.
        escrowForClaims = new TouchstoneEscrow(IERC20(address(usdc)), makeAddr("escrowTreasury"), 50);

        uint64 nonce = vm.getNonce(address(this));
        address predictedBondAddr = vm.computeCreateAddress(address(this), nonce);
        address predictedRouterAddr = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedClaimAddr = vm.computeCreateAddress(address(this), nonce + 2);

        bond = new CapacityBond(IERC20(address(usdc)), predictedClaimAddr);
        assertEq(address(bond), predictedBondAddr, "sanity: CapacityBond address prediction");

        router = new ClaimRouter(bond);
        assertEq(address(router), predictedRouterAddr, "sanity: ClaimRouter address prediction");

        claim = new WorkClaim(IERC20(address(usdc)), bond, router, publisher, ITouchstoneEscrow(address(escrowForClaims)));
        assertEq(address(claim), predictedClaimAddr, "sanity: WorkClaim address prediction");
        fixtureSeries = claim.SERIES_COMMODITY();

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

    /// Both real testbed issuers back commodity-class capacity — see the design review this
    /// contract's own SERIES_FRONTIER/SERIES_COMMODITY doc comment references. Returns the value
    /// cached from the deployed contract's own public constant in setUp() (see `fixtureSeries`'s
    /// own doc comment for why this must never itself make an external call).
    function _series() internal view returns (bytes32) {
        return fixtureSeries;
    }

    /// The calendar day a rate attestation must be dated for, to settle a claim whose window
    /// closes at `windowTo` — mirrors WorkClaim.sol's own private `_dayStart`, duplicated here
    /// (not exposed on the contract) rather than special-cased per test.
    function _dayStartOf(uint64 timestamp) internal pure returns (uint64) {
        return timestamp - (timestamp % 1 days);
    }

    /// Signs a real RateAttestation with PUBLISHER_PK, against WorkClaim's own real domain
    /// separator (`claim.rateAttestationDomainSeparator()` — never recomputed by hand here, so
    /// this test can't silently drift from what the contract actually verifies).
    function _signRate(
        uint256 nanoUsdPerSiu,
        string memory printId,
        bytes32 series,
        uint64 printDate,
        uint64 validUntil
    ) internal view returns (RateAttestationVerifier.RateAttestation memory att, bytes memory signature) {
        return _signRateAs(PUBLISHER_PK, nanoUsdPerSiu, printId, series, printDate, validUntil);
    }

    function _signRateAs(
        uint256 signerPk,
        uint256 nanoUsdPerSiu,
        string memory printId,
        bytes32 series,
        uint64 printDate,
        uint64 validUntil
    ) internal view returns (RateAttestationVerifier.RateAttestation memory att, bytes memory signature) {
        att = RateAttestationVerifier.RateAttestation({
            printId: printId,
            series: series,
            printDate: printDate,
            nanoUsdPerSiu: nanoUsdPerSiu,
            validUntil: validUntil
        });
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "RateAttestation(string printId,bytes32 series,uint64 printDate,uint256 nanoUsdPerSiu,uint64 validUntil)"
                ),
                keccak256(bytes(att.printId)),
                att.series,
                att.printDate,
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
        return _signRate(
            PRICE_NANO_USD_PER_SIU, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 365 days)
        );
    }

    function _mint(uint256 quantity) internal returns (uint256 tokenId) {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _realRate();
        vm.prank(buyer);
        tokenId = claim.mint(CLASS_CODE, _series(), quantity, windowFrom, windowTo, att, sig);
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
        claim.mint(CLASS_CODE, _series(), 333, windowFrom, windowTo, att, sig);

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

    /// Found live, 2026-09-26 (Gate Market testbed, real Base Sepolia run): serveRedemption had
    /// no window-closed check, so a routed issuer that never delivered in time could race
    /// settleWindowClose's own permissionless default with a late passed=true report the moment
    /// it saw the default coming, escaping a genuine default for work it never actually served in
    /// time. This is the regression: once the window has closed, serveRedemption must revert —
    /// disposition belongs to settleWindowClose alone from that point on.
    function test_serveRedemption_revertsAfterWindowClosed() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));

        vm.warp(windowTo);
        vm.prank(issuer);
        vm.expectRevert(WorkClaim.WindowClosed.selector);
        claim.serveRedemption(tokenId, buyer, 500, true, keccak256("receipt-1"));
    }

    /// The other half of the same regression: closing off the late-pass escape hatch must not
    /// break the real default path it was found racing against — settleWindowClose still resolves
    /// correctly (burns, restores headroom, pays the holder from the bond) once serveRedemption
    /// can no longer intervene after close.
    function test_settleWindowClose_stillDefaultsCorrectly_afterServeRedemptionWindowGuardAdded() public {
        uint256 tokenId = _mint(500);
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));

        vm.warp(windowTo);
        vm.prank(issuer);
        vm.expectRevert(WorkClaim.WindowClosed.selector);
        claim.serveRedemption(tokenId, buyer, 500, true, keccak256("receipt-1"));

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
        claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, sig);
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
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _signRateAs(
            attackerPk, PRICE_NANO_USD_PER_SIU, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days)
        );

        vm.expectRevert(); // InvalidRateAttestation(recovered, publisher) — recovered == vm.addr(attackerPk)
        claim.settleWindowClose(tokenId, buyer, att, sig);
    }

    /// An expired attestation — genuinely signed by the real publisher, for the real rate — must
    /// still be rejected once `validUntil` has passed. The standard EIP-712 replay guard; without
    /// it a single real attestation would stay usable forever.
    function test_mint_revertsOnExpiredAttestation() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(PRICE_NANO_USD_PER_SIU, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp));
        vm.warp(block.timestamp + 1);

        vm.prank(buyer);
        vm.expectRevert(); // RateAttestationExpired(validUntil, currentTimestamp)
        claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, sig);
    }

    /// `printId` is accepted opaquely — RateAttestationVerifier.sol's own doc comment states
    /// plainly that this contract does not check it against the claim's own window, and that
    /// staying honest about that (rather than a false sense of enforcement) is deliberate.
    /// Confirmed here for real, not just asserted in prose: a genuine attestation for a printId
    /// that obviously doesn't match this claim's own class/window still succeeds.
    function test_mint_acceptsGenuineAttestationForAnyPrintId_printIdIsNotEnforcedOnChain() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _signRate(
            PRICE_NANO_USD_PER_SIU, "2099-01-01-not-the-real-print", _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days)
        );

        vm.prank(buyer);
        uint256 tokenId = claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, sig);
        assertEq(claim.balanceOf(buyer, tokenId), 500);
    }

    // ------------------------------------------------------------------ grade (series)
    // Added 2026-09-27: a claim previously carried no grade at all, so nothing stopped a
    // frontier claim from default-settling against a blended or commodity rate (a real
    // underpayment risk, not a naming gap — see the design review this fix responds to).

    /// Unlike printId (accepted opaquely, see the test above this section), `series` IS enforced
    /// on-chain at mint: a genuine, unexpired, correctly-signed attestation for the wrong grade
    /// must still revert.
    function test_mint_revertsOnSeriesMismatch() public {
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _signRate(
            PRICE_NANO_USD_PER_SIU, PRINT_ID, claim.SERIES_FRONTIER(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days)
        );

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(WorkClaim.SeriesMismatch.selector, claim.SERIES_FRONTIER(), _series())
        );
        claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, sig);
    }

    /// The Defaulted branch only (Expired never checks the attestation at all, unchanged): a
    /// genuine, unexpired, correctly-signed, in-band attestation for the wrong grade must still
    /// revert rather than pay out at a different grade's rate.
    function test_settleWindowClose_revertsOnSeriesMismatch() public {
        uint256 tokenId = _mint(500);
        _presentAndCloseWindow(tokenId);

        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _signRate(
            PRICE_NANO_USD_PER_SIU, PRINT_ID, claim.SERIES_FRONTIER(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days)
        );

        vm.expectRevert(
            abi.encodeWithSelector(WorkClaim.SeriesMismatch.selector, claim.SERIES_FRONTIER(), _series())
        );
        claim.settleWindowClose(tokenId, buyer, att, sig);
    }

    /// The Defaulted branch only: a genuine, unexpired, correctly-signed, in-band, correct-grade
    /// attestation for a *different calendar day* than the one this claim's window actually
    /// closed on must still revert — closes a real gap where, within the ±50% settlement band, a
    /// caller could otherwise settle against a stale, more favourable print.
    function test_settleWindowClose_revertsOnStalePrintDate() public {
        uint256 tokenId = _mint(500);
        _presentAndCloseWindow(tokenId);

        uint64 wrongDay = _dayStartOf(windowTo) - 1 days;
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(PRICE_NANO_USD_PER_SIU, PRINT_ID, _series(), wrongDay, uint64(block.timestamp + 1 days));

        vm.expectRevert(
            abi.encodeWithSelector(WorkClaim.StalePrintDate.selector, wrongDay, _dayStartOf(windowTo))
        );
        claim.settleWindowClose(tokenId, buyer, att, sig);
    }

    /// Direct assertion, not just an implication of the hash change: two claims identical in
    /// every other dimension but grade must never collide onto the same token id — the whole
    /// point of adding `series` to `tokenIdFor`.
    function test_tokenIdFor_differsAcrossSeriesOnly() public view {
        uint256 commodityId =
            claim.tokenIdFor(issuer, CLASS_CODE, claim.SERIES_COMMODITY(), windowFrom, windowTo);
        uint256 frontierId =
            claim.tokenIdFor(issuer, CLASS_CODE, claim.SERIES_FRONTIER(), windowFrom, windowTo);
        assertTrue(commodityId != frontierId, "claims of different grades must never share a token id");
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
        claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, malleableSig);
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
        claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, att, degenerateSig);
    }

    // ------------------------------------------------------------------ settlement-rate band
    // Defense-in-depth added the same day as the rate-attestation fix itself: a genuine, unexpired,
    // correctly-signed attestation can still be rejected at settlement if its rate falls too far
    // from the rate genuinely attested at this tokenId's first mint. See WorkClaim.sol's
    // SETTLEMENT_RATE_BAND_BPS doc comment for why ±50%, grounded in real print history.

    function _presentAndCloseWindow(uint256 tokenId) internal {
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-1"));
        vm.warp(windowTo);
    }

    /// A genuine attestation for a *different* rate than the one recorded at mint still settles
    /// normally as long as it's within the band — the band bounds an outlier, it doesn't pin the
    /// rate to the mint-time value exactly.
    function test_settleWindowClose_acceptsRateWithinBand() public {
        uint256 tokenId = _mint(500);
        _presentAndCloseWindow(tokenId);

        uint256 withinBandRate = (PRICE_NANO_USD_PER_SIU * 149) / 100; // +49%, inside ±50%
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(withinBandRate, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days));

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        claim.settleWindowClose(tokenId, buyer, att, sig);
        assertGt(usdc.balanceOf(buyer), buyerUsdcBefore, "settled at the in-band rate");
    }

    /// A genuine attestation above the band settles at the upper band edge, not the raw attested
    /// rate — never reverting is the whole point: a defaulted claim that could never settle would
    /// trap the holder's funds permanently, worse than the attack this band defends against.
    function test_settleWindowClose_clampsRateAboveBandToUpperEdge() public {
        uint256 tokenId = _mint(500);
        _presentAndCloseWindow(tokenId);

        uint256 aboveBandRate = (PRICE_NANO_USD_PER_SIU * 151) / 100; // +51%, outside ±50%
        uint256 upperBound = (PRICE_NANO_USD_PER_SIU * 150) / 100; // the band's own +50% edge
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(aboveBandRate, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days));

        vm.expectEmit(true, false, false, true, address(claim));
        emit WorkClaim.SettlementRateClamped(tokenId, aboveBandRate, upperBound, PRICE_NANO_USD_PER_SIU);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        claim.settleWindowClose(tokenId, buyer, att, sig);
        assertEq(
            usdc.balanceOf(buyer) - buyerUsdcBefore,
            (500 * upperBound) / 1_000_000,
            "paid at the clamped upper-edge rate, not the raw attested (higher) one"
        );
    }

    /// Symmetric case: a genuine attestation below the band settles at the lower band edge —
    /// generous to the holder relative to the (lower) attested rate, never a revert.
    function test_settleWindowClose_clampsRateBelowBandToLowerEdge() public {
        uint256 tokenId = _mint(500);
        _presentAndCloseWindow(tokenId);

        uint256 belowBandRate = (PRICE_NANO_USD_PER_SIU * 49) / 100; // -51%, outside ±50%
        uint256 lowerBound = (PRICE_NANO_USD_PER_SIU * 50) / 100; // the band's own -50% edge
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(belowBandRate, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days));

        vm.expectEmit(true, false, false, true, address(claim));
        emit WorkClaim.SettlementRateClamped(tokenId, belowBandRate, lowerBound, PRICE_NANO_USD_PER_SIU);

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        claim.settleWindowClose(tokenId, buyer, att, sig);
        assertEq(
            usdc.balanceOf(buyer) - buyerUsdcBefore,
            (500 * lowerBound) / 1_000_000,
            "paid at the clamped lower-edge rate, not the raw attested (lower) one"
        );
    }

    /// Fuzzes both the mint-time reference rate and the settlement rate's offset from it. The
    /// oracle (`lowerBound`/`upperBound`) replicates WorkClaim's own `_clampToSettlementBand`
    /// arithmetic exactly, rather than an independent deltaBps threshold, so integer-division
    /// rounding can never disagree between test and contract at the boundary. Asserts the two
    /// properties the user explicitly asked for: settlement never reverts on a genuine
    /// out-of-band rate, and the actual payout never exceeds what the band edge itself allows.
    function testFuzz_settleWindowClose_rateBand(uint256 mintRate, int256 deltaBps) public {
        // Lower-bounded so `_usdcAmount(500, mintRate)` never truncates to zero (500 * mintRate
        // must clear 1_000_000) — otherwise even the band-accepting path hits CapacityBond's own,
        // unrelated ZeroAmount revert on a zero draw, not the property this test checks. Upper-
        // bounded well under the bond's real 60,000,000 balance even at the band's own +50%
        // ceiling and this test's fixed 500 mSIU quantity, so a clamped settlement is always a
        // real, InsufficientBond-free payout.
        mintRate = bound(mintRate, 10_000, 50_000_000);
        // Deliberately allowed to push settlementRate arbitrarily far outside the band in either
        // direction (not just to the ±9999bps edge of the old design) — this is exactly the case
        // that used to revert forever; a huge deltaBps is the realistic shape of "a real
        // methodology change could move the rate further than any band."
        deltaBps = bound(deltaBps, -9999, 100_000);

        (RateAttestationVerifier.RateAttestation memory mintAtt, bytes memory mintSig) =
            _signRate(mintRate, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days));
        vm.prank(buyer);
        uint256 tokenId = claim.mint(CLASS_CODE, _series(), 500, windowFrom, windowTo, mintAtt, mintSig);
        _presentAndCloseWindow(tokenId);

        uint256 settlementRate = deltaBps >= 0
            ? mintRate + (mintRate * uint256(deltaBps)) / 10_000
            : mintRate - (mintRate * uint256(-deltaBps)) / 10_000;
        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) =
            _signRate(settlementRate, PRINT_ID, _series(), _dayStartOf(windowTo), uint64(block.timestamp + 1 days));

        uint16 bandBps = claim.SETTLEMENT_RATE_BAND_BPS();
        uint256 lowerBound = (mintRate * (10_000 - bandBps)) / 10_000;
        uint256 upperBound = (mintRate * (10_000 + bandBps)) / 10_000;
        uint256 expectedClampedRate =
            settlementRate < lowerBound ? lowerBound : (settlementRate > upperBound ? upperBound : settlementRate);

        if (expectedClampedRate != settlementRate) {
            vm.expectEmit(true, false, false, true, address(claim));
            emit WorkClaim.SettlementRateClamped(tokenId, settlementRate, expectedClampedRate, mintRate);
        }

        uint256 buyerUsdcBefore = usdc.balanceOf(buyer);
        // Never reverts due to the band, regardless of how far out of band settlementRate is —
        // the whole point of clamping over reverting.
        claim.settleWindowClose(tokenId, buyer, att, sig);

        uint256 actualAmountUsdc = usdc.balanceOf(buyer) - buyerUsdcBefore;
        assertEq(
            actualAmountUsdc,
            (500 * expectedClampedRate) / 1_000_000,
            "payout uses the clamped rate, never the raw attested one"
        );
        assertLe(
            actualAmountUsdc,
            (500 * upperBound) / 1_000_000,
            "clamped payout never exceeds the band-edge amount, however far out of band the real rate was"
        );
    }

    // -------------------------------------------------------------- reserveForWork / release
    //
    // The one-pool property, in tests. Before this existed, a dollar-paid job consumed nothing:
    // scarcity bound the fSIU route alone, so an agent offered "pay in claims or pay in dollars"
    // was really being offered "accept a constraint or don't" — which is not the choice F1 asks
    // about. These reserve against the same `CapacityBond` headroom `mint` draws from.
    //
    // Disclosed asymmetry, deliberately not papered over: a reservation is not a claim. A claim
    // reserves capacity for a *future* window and is transferable; a dollar payment reserves it
    // for immediate work and is not. The two consume one pool, they are not the same instrument.

    address internal seller = makeAddr("seller");
    bytes32 internal constant QUOTE_HASH = keccak256("quote-1");

    /// Opens a real, funded escrow — not a mocked read. `reserveForWork` believes the escrow about
    /// who the seller is and when the deadline falls, so a stub would only test the stub.
    function _openEscrow(bytes32 quoteHash, uint64 expiry) internal returns (uint64) {
        vm.prank(buyer);
        usdc.approve(address(escrowForClaims), 10_000);
        vm.prank(buyer);
        escrowForClaims.openAndFund(quoteHash, seller, address(0), 10_000, expiry);
        return expiry;
    }

    function _openDefaultEscrow() internal returns (uint64 expiry) {
        expiry = uint64(block.timestamp + 3 days);
        _openEscrow(QUOTE_HASH, expiry);
    }

    function test_reserveForWork_consumesTheSamePoolAsMint() public {
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        uint64 expiry = _openDefaultEscrow();

        vm.prank(seller);
        address routed = claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);

        assertEq(routed, issuer, "routed through the same ClaimRouter mint uses");
        assertEq(
            bond.headroom(issuer, CLASS_CODE),
            headroomBefore - 400,
            "a dollar-paid job must draw on the same finite pool a minted claim does"
        );

        (address resIssuer, bytes32 resClass, uint256 resQty, uint64 deadline, bool released, bool exists) =
            claim.reservations(QUOTE_HASH);
        assertEq(resIssuer, issuer);
        assertEq(resClass, CLASS_CODE);
        assertEq(resQty, 400);
        // The escrow's own expiry, not an independently chosen timeout — see the release test.
        assertEq(deadline, expiry);
        assertFalse(released);
        assertTrue(exists);
    }

    function test_reserveForWork_revertsForAnyoneButTheEscrowSeller() public {
        _openDefaultEscrow();
        vm.prank(buyer);
        vm.expectRevert(WorkClaim.NotTheEscrowSeller.selector);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);
    }

    function test_reserveForWork_revertsWithNoEscrowAtAll() public {
        vm.prank(seller);
        vm.expectRevert(WorkClaim.EscrowNotOpen.selector);
        claim.reserveForWork(keccak256("never-opened"), CLASS_CODE, 400);
    }

    function test_reserveForWork_revertsOnceTheEscrowHasSettled() public {
        _openDefaultEscrow();
        vm.prank(seller);
        escrowForClaims.settle(QUOTE_HASH, 10_000, bytes32("receipt"));

        vm.prank(seller);
        vm.expectRevert(WorkClaim.EscrowNotOpen.selector);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);
    }

    function test_reserveForWork_revertsOnZeroQuantity() public {
        _openDefaultEscrow();
        vm.prank(seller);
        vm.expectRevert(WorkClaim.ZeroAmount.selector);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 0);
    }

    /// The pool is finite for this route too — the same `NoIssuerWithHeadroom` a mint gets, at the
    /// moment of acceptance rather than after the work is done.
    function test_reserveForWork_revertsWhenTheClassIsExhausted() public {
        _openDefaultEscrow();
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRouter.NoIssuerWithHeadroom.selector, CLASS_CODE, 60_001)
        );
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 60_001);
    }

    // ----- double-spend, both directions

    function test_reserveForWork_cannotReserveTwiceAgainstOneQuoteHash() public {
        _openDefaultEscrow();
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);

        uint256 headroomAfterFirst = bond.headroom(issuer, CLASS_CODE);
        vm.prank(seller);
        vm.expectRevert(WorkClaim.ReservationExists.selector);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);
        assertEq(
            bond.headroom(issuer, CLASS_CODE),
            headroomAfterFirst,
            "a rejected second reservation must not have moved the pool"
        );
    }

    function test_releaseReservation_cannotReleaseTwice() public {
        _openDefaultEscrow();
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);
        vm.prank(seller);
        escrowForClaims.settle(QUOTE_HASH, 10_000, bytes32("receipt"));

        claim.releaseReservation(QUOTE_HASH);
        uint256 headroomAfterRelease = bond.headroom(issuer, CLASS_CODE);

        vm.expectRevert(WorkClaim.ReservationAlreadyReleased.selector);
        claim.releaseReservation(QUOTE_HASH);
        assertEq(
            bond.headroom(issuer, CLASS_CODE),
            headroomAfterRelease,
            "releasing twice would mint headroom against a bond that never grew"
        );
    }

    function test_releaseReservation_revertsWithNoReservation() public {
        vm.expectRevert(WorkClaim.NoReservation.selector);
        claim.releaseReservation(keccak256("never-reserved"));
    }

    // ----- release paths

    function test_releaseReservation_onSettlementRestoresHeadroomExactly() public {
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        _openDefaultEscrow();
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);
        vm.prank(seller);
        escrowForClaims.settle(QUOTE_HASH, 10_000, bytes32("receipt"));

        vm.expectEmit(true, true, false, true, address(claim));
        emit WorkClaim.ReservationReleased(QUOTE_HASH, issuer, CLASS_CODE, 400, true);
        claim.releaseReservation(QUOTE_HASH);

        assertEq(bond.headroom(issuer, CLASS_CODE), headroomBefore);
    }

    /// The deadline is the escrow's own expiry, chosen rather than an independent timeout for one
    /// reason: past that instant the escrow can no longer settle (`TouchstoneEscrow.settle` reverts
    /// `PastExpiry` once `block.timestamp > expiry`), so the work this reservation was made for can
    /// never be paid for. Any later deadline would hold an issuer's capacity against a job that has
    /// become impossible; any earlier one would free capacity while the job was still live and
    /// payable. There is exactly one correct instant and the escrow already states it.
    function test_releaseReservation_isBlockedWhileTheEscrowCanStillSettle() public {
        uint64 expiry = _openDefaultEscrow();
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);

        vm.warp(expiry - 1);
        vm.expectRevert(WorkClaim.ReservationNotReleasable.selector);
        claim.releaseReservation(QUOTE_HASH);
    }

    /// Permissionless, and that is the point: an escrow opened, reserved against and then
    /// abandoned must not lock an issuer's capacity forever merely because nobody with a stake in
    /// it bothers to call. The caller here is a stranger — neither buyer, seller, nor issuer.
    function test_releaseReservation_anyoneMayReleaseAnAbandonedReservationAtTheDeadline() public {
        uint256 headroomBefore = bond.headroom(issuer, CLASS_CODE);
        uint64 expiry = _openDefaultEscrow();
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, 400);

        vm.warp(expiry);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        claim.releaseReservation(QUOTE_HASH);

        assertEq(
            bond.headroom(issuer, CLASS_CODE),
            headroomBefore,
            "abandoned reservations must return capacity to the issuer, called by anyone"
        );
        (,,,, bool released,) = claim.reservations(QUOTE_HASH);
        assertTrue(released);
    }

    // ----- minted claims are senior to reservations

    /// Invariant 7 of this contract's own set, from the reservation side: headroom a claim already
    /// consumed is not available to reserve, and a claim already minted still redeems after
    /// reservations have taken everything else. A reservation can starve a *future* mint; it can
    /// never reach back into capacity a live claim is already standing on.
    function test_reservationsCannotConsumeHeadroomAMintedClaimAlreadyHolds() public {
        uint256 tokenId = _mint(500);
        uint256 headroomAfterMint = bond.headroom(issuer, CLASS_CODE);
        assertEq(headroomAfterMint, 60_000 - 500);

        // One more than what remains — rejected, because the claim's 500 is not on offer.
        _openEscrow(keccak256("too-big"), uint64(block.timestamp + 3 days));
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ClaimRouter.NoIssuerWithHeadroom.selector, CLASS_CODE, headroomAfterMint + 1
            )
        );
        claim.reserveForWork(keccak256("too-big"), CLASS_CODE, headroomAfterMint + 1);

        // Exactly what remains — accepted, and now the pool is empty.
        _openEscrow(QUOTE_HASH, uint64(block.timestamp + 3 days));
        vm.prank(seller);
        claim.reserveForWork(QUOTE_HASH, CLASS_CODE, headroomAfterMint);
        assertEq(bond.headroom(issuer, CLASS_CODE), 0, "reservations exhausted the pool");

        // The already-minted claim redeems anyway — its capacity was never in the pool to take.
        vm.warp(windowFrom + 1);
        vm.prank(buyer);
        claim.presentForRedemption(tokenId, keccak256("task-spec"));
        vm.prank(issuer);
        claim.serveRedemption(tokenId, buyer, 500, true, bytes32("receipt"));

        assertEq(claim.balanceOf(buyer, tokenId), 0, "a minted claim still redeems on an empty pool");
        assertEq(
            bond.headroom(issuer, CLASS_CODE),
            500,
            "and returns its own 500 to the pool on redemption, not the reserved capacity"
        );
    }
}
