// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CapacityBond} from "./CapacityBond.sol";
import {ClaimRouter} from "./ClaimRouter.sol";
import {MinimalERC1155} from "./MinimalERC1155.sol";

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
 * ## Known limitation
 *
 * Mint price and default settlement both take a USD-per-SIU rate as a caller-supplied parameter,
 * not one verified against an on-chain print — see CapacityBond.sol's matching disclosure. This
 * contract's own invariants (headroom conservation, exactly-once payout, access control) hold
 * regardless of whether the supplied rate is honest; a dishonest rate is a pricing-manipulation
 * risk, a structurally different problem from the conservation properties fuzzed here.
 */
contract WorkClaim is MinimalERC1155, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ClaimType {
        address issuer;
        bytes32 classId;
        uint64 windowFrom;
        uint64 windowTo;
        bool exists;
    }

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

    constructor(IERC20 usdc_, CapacityBond bond_, ClaimRouter router_) MinimalERC1155("") {
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
     *         picks (ClaimRouter.sol). Pulls `quantity * usdPerMilliSiu` from the caller.
     * @dev `usdPerMilliSiu` is caller-supplied — see this contract's "Known limitation".
     */
    function mint(
        bytes32 classId,
        uint256 quantity,
        uint64 windowFrom,
        uint64 windowTo,
        uint256 usdPerMilliSiu
    ) external nonReentrant returns (uint256 tokenId) {
        if (quantity == 0 || usdPerMilliSiu == 0) revert ZeroAmount();
        if (windowTo <= windowFrom) revert BadWindow();

        address issuer = router.route(classId, quantity);
        tokenId = tokenIdFor(issuer, classId, windowFrom, windowTo);

        ClaimType storage ct = claimTypes[tokenId];
        if (!ct.exists) {
            claimTypes[tokenId] = ClaimType({
                issuer: issuer,
                classId: classId,
                windowFrom: windowFrom,
                windowTo: windowTo,
                exists: true
            });
        }

        bond.consumeHeadroom(issuer, classId, quantity);

        emit Minted(tokenId, issuer, msg.sender, classId, quantity, windowFrom, windowTo);

        _mint(msg.sender, tokenId, quantity, "");

        uint256 totalUsd = quantity * usdPerMilliSiu;
        usdc.safeTransferFrom(msg.sender, issuer, totalUsd);
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
    function settleWindowClose(uint256 tokenId, address holder, uint256 usdPerMilliSiu)
        external
        nonReentrant
    {
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
            uint256 amountUsdc = quantity * usdPerMilliSiu;
            emit Defaulted(tokenId, holder, quantity, amountUsdc);
            bond.drawForDefault(ct.issuer, ct.classId, holder, amountUsdc);
        } else {
            emit Expired(tokenId, holder, quantity);
        }
    }
}
