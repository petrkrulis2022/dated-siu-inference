// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CapacityBond} from "./CapacityBond.sol";
import {ClaimRouter} from "./ClaimRouter.sol";
import {MinimalERC1155} from "./MinimalERC1155.sol";
import {RateAttestationVerifier} from "./RateAttestationVerifier.sol";

/**
 * @title WorkClaim
 * @notice Dated work claims, ERC-1155 — Gate Market testbed WP-2
 *         (docs/gate-market-spec.md §4.3-4.4, §5.3; monetary-design.md §5).
 *
 * One token id per (issuer, class, window) — see ClaimRouter.sol's doc comment for why issuer is
 * part of the id, diverging from the spec's fully cross-issuer-fungible pool. Within one token id,
 * units are genuinely fungible: free ERC-1155 transfer, no print read, no issuer involvement,
 * exactly as spec §4.4 describes.
 *
 * ## The three terminal states, and why headroom restoration is the invariant that matters most
 *
 * Every unit of every claim ends in exactly one of three ways (settled via review, 2026-09-22 —
 * the spec's own DEFAULT wording read as if "never presented" and "presented and failed" carry
 * the same consequence, which is the wrong economics here: redemption failure in this system is
 * always issuer-attributable, since the holder supplies only a task spec and the gate grades the
 * issuer's own served output):
 *
 *  - Redeemed  — `serveRedemption` reports a genuine pass. Burned, headroom restored, issuer kept
 *                the mint proceeds already.
 *  - Defaulted — the window closed, `everPresented[tokenId][holder]` is true (at least one
 *                presentation was ever made), and the remaining balance was never successfully
 *                redeemed. Burned, headroom restored, **the bond pays the holder** — the issuer
 *                was tested and failed to deliver on a real commitment.
 *  - Expired   — the window closed and the holder never presented at all. Burned, headroom
 *                restored, **no bond draw** — an unexercised option expiring worthless, not a
 *                default. The issuer was never asked to perform.
 *
 * All three restore headroom. If any one of them didn't, claims nobody touched would silently and
 * permanently lock issuance capacity — the property `WorkClaim.invariant.t.sol` fuzzes hardest.
 *
 * ## Settlement-rate binding — fixed 2026-09-25, real and exploitable, not just disclosed
 *
 * Mint price and default settlement used to take a USD-per-SIU rate as a bare, unverified
 * `uint256` parameter. `settleWindowClose` is deliberately permissionless (any caller may trigger
 * it, for any holder, for liveness — see that function's own doc comment) and `holder` is a
 * caller-supplied address, not `msg.sender`; the only other check on the default payout was that
 * the bond had the funds. So an unverified rate meant any caller could drain a lot's entire
 * bonded USDC by settling even a trivial defaulted claim at an arbitrarily inflated rate — not a
 * disclosed limitation to route around, a working drain, found live 2026-09-25 while reviewing
 * an unrelated rounding fix, before this contract was ever deployed anywhere. Symmetrically, an
 * unverified rate at mint let a buyer consume real issuer headroom while paying an arbitrarily
 * low price.
 *
 * Both `mint` and `settleWindowClose` now take a `RateAttestationVerifier.RateAttestation` plus
 * its signature in place of the bare rate — see that contract's own doc comment for exactly what
 * is and isn't verified. This does not verify a print's full body against
 * `TouchstoneAttestation`'s anchored hash (real, non-trivial on-chain JCS work, still out of
 * scope); it verifies that the real, registered publisher attested this specific rate for this
 * specific print id, which is the number this contract actually uses.
 *
 * A genuine signature alone still leaves the publisher key as a single point of failure — it now
 * signs value-bearing rates, not just prints, and signs automatically in CI every day. Two more
 * layers, added the same day this was found exploitable: `SETTLEMENT_RATE_BAND_BPS` rejects a
 * settlement rate too far from the rate genuinely attested at this tokenId's first mint (defense
 * in depth — bounds a single forged-but-signed attestation, never a substitute for a real
 * signature); and README.md's "Hard precondition before mainnet: split the publisher key" records,
 * as an operational precondition rather than code, that print-signing and rate-attestation-signing
 * must use separate keys before any mainnet deployment.
 *
 * ## Price precision — the rate scale carries real headroom this time
 *
 * The rate is `nanoUsdPerSiu`: nano-USD (1e-9 USD) per whole SIU — three more decimal digits than
 * `RateAttestationVerifier`'s predecessor scale (`microUsdPerSiu`, 1e-6 USD, matching USDC's own
 * 6 decimals) carried. That earlier scale was fixed 2026-09-22 specifically because it needed "two
 * full digits of headroom over dated_siu's published precision" — true when `dated_siu` was a
 * fixed 4 decimal places, false the moment it started rounding to 4 significant figures instead
 * (docs/methodology.md's Rounding section, 2026-09-25): a real Commodity SIU value already needs
 * all 6 of that scale's decimal places, zero headroom left. `nanoUsdPerSiu` starts with real
 * headroom instead of needing this exact fix again the next time the index falls further.
 * `_usdcAmount` truncates only in its final `/ 1_000_000` step (converting the mSIU quantity and
 * nano-USD rate into USDC minor units), bounded at under 1 USDC minor unit (1e-6 USD) of error
 * *total* regardless of `quantity` — the same bound a single final truncating division always
 * gives, independent of the divisor's own size (see git history for the two earlier, coarser
 * scales this same bound was stated against: `usdPerMilliSiu`, then `microUsdPerSiu`).
 */
contract WorkClaim is MinimalERC1155, ReentrancyGuard, RateAttestationVerifier {
    using SafeERC20 for IERC20;

    struct ClaimType {
        address issuer;
        bytes32 classId;
        uint64 windowFrom;
        uint64 windowTo;
        bool exists;
        /// @dev The verified rate attested at this tokenId's first mint — never overwritten by a
        ///      later mint into the same tokenId. See SETTLEMENT_RATE_BAND_BPS's own doc comment
        ///      for what this is checked against and why.
        uint256 referenceNanoUsdPerSiu;
    }

    /// @notice Defense-in-depth: a settlement rate more than this many basis points away from
    ///         `ClaimType.referenceNanoUsdPerSiu` (the genuinely-attested rate recorded at this
    ///         tokenId's first mint) is clamped to the nearest band edge before it is used to pay
    ///         out, even though it carries a valid publisher signature. The publisher key now
    ///         signs value-bearing rate attestations, not just prints (see this contract's
    ///         "Settlement-rate binding" doc comment) — this bounds how much a single compromised
    ///         or mis-issued attestation can drain, on top of (never instead of) requiring a
    ///         genuine signature.
    /// @dev 5000 bps (±50%). Grounded in the real print history, not picked arbitrarily: the
    ///      largest single-day move Commodity SIU has ever shown, recomputed from every published
    ///      commodity print's own basket_costs/weights (2026-09-01 through 2026-09-25, 24 prints),
    ///      is 1.38%. A ±50% band leaves roughly 35x headroom over the largest real movement this
    ///      index has ever shown day-to-day, while still meaningfully bounding an attacker, who
    ///      needs a large multiple of the true rate to drain a bond, not a realistic market move.
    ///      This is a fixed percentage, not scaled by the claim's own window length — a disclosed
    ///      simplification for this testbed pass, the same style as CapacityBond.sol's own
    ///      ISSUANCE_RATIO_BPS ("not because it's correct... but because the testbed needs a
    ///      number"). A real production system would want the band to scale with how long a
    ///      window can stay open, which this does not attempt.
    ///
    ///      Clamps rather than reverts — found live, 2026-09-25: this index has already shown a
    ///      real single-day move over 30% from a basket composition change (a registry admission
    ///      or exclusion moves dated_siu discontinuously, unlike ordinary day-to-day price drift),
    ///      and a real methodology change could move it further still. A genuine attestation for
    ///      such a rate would revert forever under the old design — a defaulted claim that can
    ///      never settle traps the holder's funds permanently, which is a worse outcome than the
    ///      attack this band defends against. Clamping still bounds a forged rate's damage to the
    ///      band edge and still lets a legitimate holder collect a real, bounded payout instead of
    ///      nothing.
    uint16 public constant SETTLEMENT_RATE_BAND_BPS = 5000;
    uint16 private constant BAND_BPS_DENOMINATOR = 10_000;

    /// @notice Emitted only when a genuinely-verified settlement rate actually fell outside the
    ///         band and was clamped — never emitted for an in-band rate, so its mere presence is
    ///         itself a signal worth watching operationally.
    event SettlementRateClamped(
        uint256 indexed tokenId, uint256 attestedNanoUsdPerSiu, uint256 clampedNanoUsdPerSiu, uint256 referenceNanoUsdPerSiu
    );

    IERC20 public immutable usdc;
    CapacityBond public immutable bond;
    ClaimRouter public immutable router;

    mapping(uint256 tokenId => ClaimType) public claimTypes;
    /// @dev Monotonic latch: true the moment a holder ever presents, for that token id, and
    ///      never reset. Decides Default vs Expire at window close — see this contract's own
    ///      top-level doc comment.
    mapping(uint256 tokenId => mapping(address holder => bool)) public everPresented;
    /// @dev Set once a (tokenId, holder) position has reached ANY terminal state — redeemed in
    ///      full, defaulted, or expired. `settleWindowClose` checks this so a defaulted position
    ///      can be paid exactly once; see WorkClaim.invariant.t.sol's default-idempotency check.
    mapping(uint256 tokenId => mapping(address holder => bool)) public settled;

    event Minted(
        uint256 indexed tokenId,
        address indexed issuer,
        address indexed buyer,
        bytes32 classId,
        uint256 quantity,
        uint64 windowFrom,
        uint64 windowTo
    );
    event Presented(uint256 indexed tokenId, address indexed holder, bytes32 taskSpecHash);
    event Served(
        uint256 indexed tokenId,
        address indexed holder,
        uint256 quantity,
        bool passed,
        bytes32 receiptRef
    );
    event Defaulted(
        uint256 indexed tokenId, address indexed holder, uint256 quantity, uint256 amountUsdc
    );
    event Expired(uint256 indexed tokenId, address indexed holder, uint256 quantity);

    error UsdcZero();
    error BondZero();
    error RouterZero();
    error ZeroAmount();
    error BadWindow();
    error WindowNotOpenYet();
    error WindowClosed();
    error WindowNotClosedYet();
    error NotTheRoutedIssuer();
    error NothingToPresent();
    error NothingToSettle();
    error AlreadySettled();
    error InsufficientRedemption(uint256 requested, uint256 balance);

    constructor(IERC20 usdc_, CapacityBond bond_, ClaimRouter router_, address publisher_)
        MinimalERC1155("")
        RateAttestationVerifier(publisher_, "Touchstone Rate Attestation", "1")
    {
        if (address(usdc_) == address(0)) revert UsdcZero();
        if (address(bond_) == address(0)) revert BondZero();
        if (address(router_) == address(0)) revert RouterZero();
        usdc = usdc_;
        bond = bond_;
        router = router_;
    }

    function tokenIdFor(address issuer, bytes32 classId, uint64 windowFrom, uint64 windowTo)
        public
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(issuer, classId, windowFrom, windowTo)));
    }

    /**
     * @notice Mints `quantity` mSIU of a claim in `classId` for the delivery window
     *         [`windowFrom`, `windowTo`), routed to an issuer with headroom — the buyer never
     *         picks (ClaimRouter.sol). Pulls the USDC value of `quantity` at the rate `att`
     *         attests, from the caller.
     * @dev `att`/`signature` must be a genuine, unexpired attestation from `publisher` — see
     *      RateAttestationVerifier.sol. Caller-controlled before this fix (see this contract's
     *      "Settlement-rate binding" note); now cryptographically bound to the real publisher.
     */
    function mint(
        bytes32 classId,
        uint256 quantity,
        uint64 windowFrom,
        uint64 windowTo,
        RateAttestation calldata att,
        bytes calldata signature
    ) external nonReentrant returns (uint256 tokenId) {
        if (quantity == 0) revert ZeroAmount();
        if (windowTo <= windowFrom) revert BadWindow();
        uint256 nanoUsdPerSiu = _verifyRateAttestation(att, signature);
        if (nanoUsdPerSiu == 0) revert ZeroAmount();

        address issuer = router.route(classId, quantity);
        tokenId = tokenIdFor(issuer, classId, windowFrom, windowTo);

        ClaimType storage ct = claimTypes[tokenId];
        if (!ct.exists) {
            claimTypes[tokenId] = ClaimType({
                issuer: issuer,
                classId: classId,
                windowFrom: windowFrom,
                windowTo: windowTo,
                exists: true,
                referenceNanoUsdPerSiu: nanoUsdPerSiu
            });
        }

        bond.consumeHeadroom(issuer, classId, quantity);

        emit Minted(tokenId, issuer, msg.sender, classId, quantity, windowFrom, windowTo);

        _mint(msg.sender, tokenId, quantity, "");

        uint256 totalUsd = _usdcAmount(quantity, nanoUsdPerSiu);
        usdc.safeTransferFrom(msg.sender, issuer, totalUsd);
    }

    /**
     * @dev Converts an mSIU quantity to USDC minor units at `nanoUsdPerSiu` — see this
     *      contract's "Price precision" doc comment for the unit derivation and the truncation
     *      bound. Truncates (rounds toward zero) in the final division only, by construction
     *      under 1 USDC minor unit of error regardless of `quantityMilliSiu`'s size.
     */
    function _usdcAmount(uint256 quantityMilliSiu, uint256 nanoUsdPerSiu)
        internal
        pure
        returns (uint256)
    {
        return (quantityMilliSiu * nanoUsdPerSiu) / 1_000_000;
    }

    /// @dev Returns `rate` unchanged if within ±SETTLEMENT_RATE_BAND_BPS of `referenceRate`,
    ///      otherwise the nearest band edge — see that constant's own doc comment for why this
    ///      clamps rather than reverts, and why it's checked here only (the Defaulted settlement
    ///      path, the one place a verified rate pays out real USDC).
    function _clampToSettlementBand(uint256 rate, uint256 referenceRate)
        internal
        pure
        returns (uint256)
    {
        uint256 lowerBound =
            (referenceRate * (BAND_BPS_DENOMINATOR - SETTLEMENT_RATE_BAND_BPS)) / BAND_BPS_DENOMINATOR;
        uint256 upperBound =
            (referenceRate * (BAND_BPS_DENOMINATOR + SETTLEMENT_RATE_BAND_BPS)) / BAND_BPS_DENOMINATOR;
        if (rate < lowerBound) return lowerBound;
        if (rate > upperBound) return upperBound;
        return rate;
    }

    /**
     * @notice Presents `msg.sender`'s claim of `tokenId` against `taskSpecHash` for redemption.
     * @dev Reverts before the window opens or after it closes (spec §5.4 invariant 2: no early
     *      redemption). Setting `everPresented` is idempotent by construction — a monotonic latch
     *      a second call cannot un-set or double-count. Does not itself run the gate; the issuer
     *      calls `serveRedemption` after actually performing the work off-chain, same
     *      off-chain-gate boundary as gate-market-spec.md §2's whole design.
     */
    function presentForRedemption(uint256 tokenId, bytes32 taskSpecHash) external {
        ClaimType storage ct = claimTypes[tokenId];
        if (!ct.exists) revert NothingToPresent();
        if (block.timestamp < ct.windowFrom) revert WindowNotOpenYet();
        if (block.timestamp >= ct.windowTo) revert WindowClosed();
        if (balanceOf(msg.sender, tokenId) == 0) revert NothingToPresent();

        everPresented[tokenId][msg.sender] = true;
        emit Presented(tokenId, msg.sender, taskSpecHash);
    }

    /**
     * @notice The routed issuer reports the outcome of a redemption attempt.
     * @dev Callable only by `claimTypes[tokenId].issuer` — the sole party this token id could
     *      ever have been routed to (fixed at mint, per ClaimRouter's scoping decision). On
     *      `passed`, burns `quantity` and restores that much headroom; nothing state-changing
     *      happens on a failed attempt (spec §5.4 invariant 3: failed work retires nothing) —
     *      the holder keeps the claim and may re-present within the window.
     */
    function serveRedemption(
        uint256 tokenId,
        address holder,
        uint256 quantity,
        bool passed,
        bytes32 receiptRef
    ) external nonReentrant {
        ClaimType storage ct = claimTypes[tokenId];
        if (!ct.exists) revert NothingToPresent();
        if (msg.sender != ct.issuer) revert NotTheRoutedIssuer();
        if (quantity == 0) revert ZeroAmount();
        if (quantity > balanceOf(holder, tokenId)) {
            revert InsufficientRedemption(quantity, balanceOf(holder, tokenId));
        }

        emit Served(tokenId, holder, quantity, passed, receiptRef);

        // Invariant 3, structurally: this is the ONLY branch in the entire contract that burns a
        // claim as a "pass" and restores headroom outside the default/expire settlement path —
        // and it is reached only when `passed` is true. A failed attempt changes nothing here.
        if (passed) {
            _burn(holder, tokenId, quantity);
            bond.restoreHeadroom(ct.issuer, ct.classId, quantity);
        }
    }

    /**
     * @notice Settles `holder`'s remaining balance of `tokenId` after its window has closed —
     *         Defaulted if they ever presented, Expired if they never did (see this contract's
     *         top-level doc comment). Permissionless: the destination (the same holder whose
     *         balance is being settled) is fixed by state, so anyone triggering it adds liveness
     *         without adding authority, same pattern as TouchstoneEscrow.expire.
     * @dev `settled[tokenId][holder]` makes this callable at most once per (tokenId, holder) —
     *      required so a defaulted position cannot pay out twice, the settlement-side mirror of
     *      serveRedemption's headroom-restoration idempotency.
     */
    /// @dev `att`/`signature` are only verified — and only need to be genuine — on the Defaulted
    ///      branch, where they're actually used to compute a payout. A caller settling a claim
    ///      they already know will Expire (no presentation ever made, checked via the public
    ///      `everPresented` mapping before calling) may pass an empty/zero attestation; it is
    ///      never checked, and its liveness cost (anyone can clean up an expired claim without
    ///      needing a real signed rate first) is exactly why this stays permissionless.
    function settleWindowClose(
        uint256 tokenId,
        address holder,
        RateAttestation calldata att,
        bytes calldata signature
    ) external nonReentrant {
        ClaimType storage ct = claimTypes[tokenId];
        if (!ct.exists) revert NothingToSettle();
        if (block.timestamp < ct.windowTo) revert WindowNotClosedYet();
        if (settled[tokenId][holder]) revert AlreadySettled();

        uint256 quantity = balanceOf(holder, tokenId);
        if (quantity == 0) revert NothingToSettle();

        // Effects before interactions: settled is latched, and the claim is burned, before any
        // external call — a reentrant call during the USDC transfer below sees a zero balance
        // and an already-settled position, not a second draw.
        settled[tokenId][holder] = true;
        _burn(holder, tokenId, quantity);
        bond.restoreHeadroom(ct.issuer, ct.classId, quantity);

        if (everPresented[tokenId][holder]) {
            uint256 nanoUsdPerSiu = _verifyRateAttestation(att, signature);
            uint256 clampedNanoUsdPerSiu =
                _clampToSettlementBand(nanoUsdPerSiu, ct.referenceNanoUsdPerSiu);
            if (clampedNanoUsdPerSiu != nanoUsdPerSiu) {
                emit SettlementRateClamped(
                    tokenId, nanoUsdPerSiu, clampedNanoUsdPerSiu, ct.referenceNanoUsdPerSiu
                );
            }
            uint256 amountUsdc = _usdcAmount(quantity, clampedNanoUsdPerSiu);
            emit Defaulted(tokenId, holder, quantity, amountUsdc);
            bond.drawForDefault(ct.issuer, ct.classId, holder, amountUsdc);
        } else {
            emit Expired(tokenId, holder, quantity);
        }
    }
}
