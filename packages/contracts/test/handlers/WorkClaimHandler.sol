// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CapacityBond} from "../../src/CapacityBond.sol";
import {ClaimRouter} from "../../src/ClaimRouter.sol";
import {WorkClaim} from "../../src/WorkClaim.sol";
import {RateAttestationVerifier} from "../../src/RateAttestationVerifier.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * Drives WorkClaim/CapacityBond through arbitrary interleavings of mint / present / serve
 * (pass and fail) / transfer / settleWindowClose / time-passage, from a small fixed actor set —
 * multiple issuers and multiple holders, per review's explicit ask for invariant 3 — plus
 * dedicated adversarial actions proving access control and idempotency structurally rather than
 * by their absence from the code the handler was written to call.
 *
 * Invariant 3 ("failed work retires nothing") is checked twice, deliberately: inline in
 * `serveFail` below, immediately after every single failed serve call, localizing the exact
 * sequence that would break it; and again in aggregate by `WorkClaim.invariant.t.sol`'s
 * `invariant_outstandingEqualsSumOfLiveClaims`, which would also fail if any failed serve had
 * secretly moved something.
 */
contract WorkClaimHandler is Test {
    MockUSDC public immutable usdc;
    CapacityBond public immutable bond;
    ClaimRouter public immutable router;
    WorkClaim public immutable claim;

    bytes32 public constant CLASS_A = keccak256("classA");
    bytes32 public constant CLASS_B = keccak256("classB");
    bytes32[2] public classes = [CLASS_A, CLASS_B];

    address[2] public issuers;
    address[3] public holders;
    address public attacker;

    uint256[] public knownTokenIds;
    mapping(uint256 => bool) public knownTokenId;

    // Ghost counters, updated only on confirmed contract-level success/revert.
    uint256 public ghostMints;
    uint256 public ghostPresents;
    uint256 public ghostServePasses;
    uint256 public ghostServeFails;
    uint256 public ghostDefaults;
    uint256 public ghostExpires;
    uint256 public ghostTransfers;
    uint256 public ghostRejectedUnauthorisedServes;
    uint256 public ghostRejectedDoubleSettles;
    uint256 public ghostRejectedDoubleServesOnRetired;
    /// Incremented ONLY if an unauthorised serve call actually succeeded — the one number that
    /// must stay zero for the access-control property to hold. Kept separate from the "rejected"
    /// counters above: conservation (outstanding == sum of live balances) would NOT by itself
    /// catch a successful forged pass, since burn+restore stays internally consistent regardless
    /// of who the caller was — this is the direct check for that.
    uint256 public ghostUnauthorisedServeSucceeded;
    uint256 public ghostDoubleServeOnRetiredSucceeded;

    /// Same test-only publisher key WorkClaim was deployed to trust — the handler signs every
    /// rate attestation it uses itself, real secp256k1 via vm.sign, not a stub.
    uint256 internal immutable publisherPk;

    constructor(
        MockUSDC usdc_,
        CapacityBond bond_,
        ClaimRouter router_,
        WorkClaim claim_,
        address[2] memory issuers_,
        address[3] memory holders_,
        address attacker_,
        uint256 publisherPk_
    ) {
        usdc = usdc_;
        bond = bond_;
        router = router_;
        claim = claim_;
        issuers = issuers_;
        holders = holders_;
        attacker = attacker_;
        publisherPk = publisherPk_;
    }

    /// A generously-valid (1 year), fixed-rate attestation — the fuzz depth here targets the
    /// conservation/access-control properties WorkClaim.invariant.t.sol's own doc comment names,
    /// not rate-attestation edge cases (those are WorkClaim.t.sol's own, explicit, unit tests).
    function _rate()
        internal
        view
        returns (RateAttestationVerifier.RateAttestation memory att, bytes memory sig)
    {
        att = RateAttestationVerifier.RateAttestation({
            printId: "handler-fixed-rate",
            nanoUsdPerSiu: 1_000_000,
            validUntil: uint64(block.timestamp + 365 days)
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(publisherPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function knownTokenIdCount() external view returns (uint256) {
        return knownTokenIds.length;
    }

    function _addKnownTokenId(uint256 tokenId) internal {
        if (!knownTokenId[tokenId]) {
            knownTokenId[tokenId] = true;
            knownTokenIds.push(tokenId);
        }
    }

    // ------------------------------------------------------------------ mint

    /// @dev windowFrom is deliberately a fixed offset (not randomised from windowSeed) so
    ///      present/serve/settle calls reliably land inside an *open* window within a short
    ///      invariant depth — found live, 2026-09-22: randomising it against a similarly
    ///      randomised `warp()` step made alignment statistically rare, so coverage guards
    ///      (afterInvariant) failed not because any property broke, but because serveFail and
    ///      the adversarial paths almost never got a chance to run at all within 40-call depths.
    ///      The window's real flexibility is unchanged in the contract; this only fixes what the
    ///      *fuzzer* explores, which is what "multiple claims and issuers" needs reachable, not
    ///      "every possible window offset" — a materially different, less important axis here.
    uint64 internal constant WINDOW_OPEN_DELAY = 1 hours;
    uint64 internal constant WINDOW_DURATION = 3 days;

    function mint(uint256 buyerSeed, uint256 classSeed, uint256 quantitySeed, uint256 windowSeed)
        external
    {
        address buyer = holders[bound(buyerSeed, 0, holders.length - 1)];
        bytes32 classId = classes[classSeed % 2];
        uint256 quantity = bound(quantitySeed, 1, 2000);
        windowSeed; // no longer used for timing — see WINDOW_OPEN_DELAY's doc comment
        uint64 windowFrom = uint64(block.timestamp + WINDOW_OPEN_DELAY);
        uint64 windowTo = windowFrom + WINDOW_DURATION;

        if (usdc.balanceOf(buyer) < quantity * 1000) usdc.mint(buyer, quantity * 1000 * 10);

        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _rate();
        vm.prank(buyer);
        try claim.mint(classId, quantity, windowFrom, windowTo, att, sig) returns (uint256 tokenId) {
            _addKnownTokenId(tokenId);
            ghostMints++;
        } catch {}
    }

    // ------------------------------------------------------------------ present

    /// @dev Searches for a holder that actually holds `tokenId`, starting from the seed-selected
    ///      index and wrapping, rather than picking one of 3 holders uniformly at random. Found
    ///      live, 2026-09-22: pure random pairing made present/serve calls almost never land on a
    ///      real (tokenId, holder-with-balance) pair once more than a couple of token ids existed
    ///      — not a timing issue (serveRedemption has none), a search-strategy one.
    function _holderWithBalance(uint256 tokenId, uint256 holderSeed)
        internal
        view
        returns (address holder, uint256 balance)
    {
        uint256 start = bound(holderSeed, 0, holders.length - 1);
        for (uint256 k = 0; k < holders.length; k++) {
            address candidate = holders[(start + k) % holders.length];
            uint256 bal = claim.balanceOf(candidate, tokenId);
            if (bal > 0) return (candidate, bal);
        }
        return (holders[start], 0);
    }

    function present(uint256 tokenIdSeed, uint256 holderSeed, uint256 taskSeed) external {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (address holder,) = _holderWithBalance(tokenId, holderSeed);

        vm.prank(holder);
        try claim.presentForRedemption(tokenId, keccak256(abi.encode("task", taskSeed))) {
            ghostPresents++;
        } catch {}
    }

    // ------------------------------------------------------------------ serve (pass) and serve (fail, self-checked)

    function _issuerOf(uint256 tokenId) internal view returns (address issuer, bool exists) {
        (address i,,,, bool e,) = claim.claimTypes(tokenId);
        return (i, e);
    }

    function servePass(uint256 tokenIdSeed, uint256 holderSeed, uint256 quantitySeed) external {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (address issuer, bool exists) = _issuerOf(tokenId);
        if (!exists) return;
        (address holder, uint256 bal) = _holderWithBalance(tokenId, holderSeed);
        if (bal == 0) return;
        uint256 quantity = bound(quantitySeed, 1, bal);

        vm.prank(issuer);
        try claim.serveRedemption(tokenId, holder, quantity, true, keccak256("r")) {
            ghostServePasses++;
        } catch {}
    }

    /// The property review asked to fuzz hardest: a failed serve must leave the claim balance and
    /// headroom both exactly unchanged. Checked inline, immediately, not just in the aggregate
    /// invariant — a failure here points directly at the call that broke it.
    function serveFail(uint256 tokenIdSeed, uint256 holderSeed, uint256 quantitySeed) external {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (address issuer, bool exists) = _issuerOf(tokenId);
        if (!exists) return;
        (address holder, uint256 bal) = _holderWithBalance(tokenId, holderSeed);
        if (bal == 0) return;
        uint256 quantity = bound(quantitySeed, 1, bal);

        (, bytes32 classId,,,,) = claim.claimTypes(tokenId);
        uint256 headroomBefore = bond.headroom(issuer, classId);

        vm.prank(issuer);
        try claim.serveRedemption(tokenId, holder, quantity, false, keccak256("r")) {
            ghostServeFails++;
            assertEq(
                claim.balanceOf(holder, tokenId),
                bal,
                "invariant 3: failed serve changed the balance"
            );
            assertEq(
                bond.headroom(issuer, classId),
                headroomBefore,
                "invariant 3: failed serve changed headroom"
            );
        } catch {}
    }

    // ------------------------------------------------------------------ window close settlement

    function settleWindowClose(uint256 tokenIdSeed, uint256 holderSeed) external {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (,,, uint64 windowTo, bool exists,) = claim.claimTypes(tokenId);
        if (!exists) return;
        address holder = holders[bound(holderSeed, 0, holders.length - 1)];
        bool wasPresented = claim.everPresented(tokenId, holder);
        bool alreadySettled = claim.settled(tokenId, holder);

        vm.warp(block.timestamp >= windowTo ? block.timestamp : windowTo);

        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _rate();
        try claim.settleWindowClose(tokenId, holder, att, sig) {
            if (wasPresented) ghostDefaults++;
            else ghostExpires++;
        } catch {
            if (alreadySettled) ghostRejectedDoubleSettles++;
        }
    }

    // ------------------------------------------------------------------ transfer (free, no issuer involvement)

    function transfer(uint256 tokenIdSeed, uint256 fromSeed, uint256 toSeed, uint256 quantitySeed)
        external
    {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (address from, uint256 bal) = _holderWithBalance(tokenId, fromSeed);
        address to = holders[bound(toSeed, 0, holders.length - 1)];
        if (bal == 0) return;
        uint256 quantity = bound(quantitySeed, 1, bal);

        vm.prank(from);
        try claim.safeTransferFrom(from, to, tokenId, quantity, "") {
            ghostTransfers++;
        } catch {}
    }

    // ------------------------------------------------------------------ adversarial: access control

    /// The specific attack that would mint free work: an unrouted party reporting its own pass.
    /// Must always revert; ghostRejectedUnauthorisedServes only increments on the catch branch, so
    /// a run where this ever succeeds is directly visible as a discrepancy against ghostServePasses.
    /// @dev Deliberately does NOT require the holder to have a balance: `serveRedemption` checks
    ///      `msg.sender == ct.issuer` before it ever looks at quantity or balance (see
    ///      WorkClaim.sol), so the access-control property holds regardless of balance — an
    ///      earlier version of this function required `bal > 0` first, which (combined with pure
    ///      random holder selection) meant it almost never actually attempted the call at all,
    ///      found live, 2026-09-22, the same root cause as serveFail's own coverage gap.
    function attackerServeUnrouted(uint256 tokenIdSeed, uint256 holderSeed, uint256 quantitySeed)
        external
    {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (address issuer, bool exists) = _issuerOf(tokenId);
        if (!exists || attacker == issuer) return;
        address holder = holders[bound(holderSeed, 0, holders.length - 1)];
        uint256 quantity = bound(quantitySeed, 1, type(uint128).max);

        vm.prank(attacker);
        try claim.serveRedemption(tokenId, holder, quantity, true, keccak256("forged")) {
            ghostUnauthorisedServeSucceeded++;
        } catch {
            ghostRejectedUnauthorisedServes++;
        }
    }

    // ------------------------------------------------------------------ adversarial: settle a default twice

    /// The settlement-side mirror of serve idempotency: a claim that has already reached a
    /// terminal state (redeemed out, defaulted, or expired) via settleWindowClose must not pay
    /// out — or restore headroom — a second time. Forces window-close first if needed, then
    /// immediately retries the same (tokenId, holder) settlement.
    function attackerDoubleSettle(uint256 tokenIdSeed, uint256 holderSeed) external {
        if (knownTokenIds.length == 0) return;
        uint256 tokenId = knownTokenIds[bound(tokenIdSeed, 0, knownTokenIds.length - 1)];
        (,, uint64 windowFrom, uint64 windowTo, bool exists,) = claim.claimTypes(tokenId);
        windowFrom; // silence unused-var warning; window bounds read for clarity only
        if (!exists) return;
        (address holder,) = _holderWithBalance(tokenId, holderSeed);

        if (block.timestamp < windowTo) vm.warp(windowTo);
        if (!claim.settled(tokenId, holder)) {
            // Get it into the settled state first — success or failure (e.g. zero balance) here
            // isn't what's under test, only what happens on the *second* attempt below.
            (RateAttestationVerifier.RateAttestation memory firstAtt, bytes memory firstSig) = _rate();
            try claim.settleWindowClose(tokenId, holder, firstAtt, firstSig) {} catch {}
        }
        if (!claim.settled(tokenId, holder)) return; // nothing reached a terminal state to replay against

        uint256 bondedBefore = _bondedAmountFor(tokenId);

        (RateAttestationVerifier.RateAttestation memory att, bytes memory sig) = _rate();
        try claim.settleWindowClose(tokenId, holder, att, sig) {
            ghostDoubleServeOnRetiredSucceeded++;
        } catch {
            ghostRejectedDoubleServesOnRetired++;
            assertEq(
                _bondedAmountFor(tokenId),
                bondedBefore,
                "bond drained by a replayed default settlement"
            );
        }
    }

    function _bondedAmountFor(uint256 tokenId) internal view returns (uint256 bondedUsdc) {
        (address issuer, bytes32 classId,,,,) = claim.claimTypes(tokenId);
        (,, bondedUsdc,,) = bond.lots(issuer, classId);
    }

    /// @dev Small steps (30 min-1 day), not the 10-day jumps an earlier version used — same
    ///      alignment reasoning as WINDOW_OPEN_DELAY above: a single huge warp can jump clean
    ///      over a 3-day-wide open window before any present/serve call ever lands inside it.
    ///      Many small steps give repeated chances to land inside, and still comfortably clear
    ///      any window's close given enough calls within a run.
    function warp(uint256 deltaSeed) external {
        uint256 delta = bound(deltaSeed, 30 minutes, 1 days);
        vm.warp(block.timestamp + delta);
    }

    /// Sum of every known holder's live balance across every known token id backed by
    /// (issuer, classId) — what CapacityBond's own `outstanding` must equal at all times.
    function sumLiveClaims(address issuer, bytes32 classId) external view returns (uint256 total) {
        for (uint256 i = 0; i < knownTokenIds.length; i++) {
            uint256 tokenId = knownTokenIds[i];
            (address tIssuer, bytes32 tClass,,, bool exists,) = claim.claimTypes(tokenId);
            if (!exists || tIssuer != issuer || tClass != classId) continue;
            for (uint256 h = 0; h < holders.length; h++) {
                total += claim.balanceOf(holders[h], tokenId);
            }
        }
    }
}
