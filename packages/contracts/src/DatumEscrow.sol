// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title DatumEscrow
 * @notice Non-custodial escrow for datum-quote settlements — build1-spec.md §10.
 *
 * A buyer funds an escrow against a `quoteHash` (keccak256 of the JCS-canonicalised quote body
 * excluding its signature — see docs/datum-quote.md). The seller, or a settler the buyer
 * authorised at funding time, later settles for the amount actually consumed, capped by the
 * amount the buyer escrowed.
 *
 * ## Non-custodial by construction
 *
 * There are exactly three state-mutating functions — `openAndFund`, `settle`, `expire` — and
 * every token movement in all three has a destination fixed by state written at funding time:
 * the recorded seller, the recorded buyer, or the immutable fee treasury. There is no owner, no
 * admin role, no pause, no sweep, no upgrade path, and no setter for any immutable. Nothing in
 * this contract can redirect, freeze, or withdraw a user's funds, because no code path exists
 * that could. `test/DatumEscrow.abi.t.sol` asserts that from the compiled ABI rather than from
 * this comment.
 *
 * There is deliberately no `receive()` or `fallback()`: ETH sent to this contract reverts rather
 * than becoming permanently stranded, which is also why no ETH-rescue function is needed.
 *
 * ## What this contract cannot do
 *
 * It cannot verify that the work a quote paid for was actually performed, or that
 * `actualAmount` reflects real token usage — a seller may settle for anything up to `maxAmount`.
 * Detection is off-chain, by comparing the settlement against the signed quote in
 * `verify_receipt` (build1-spec.md §9); enforcement is reputational, via ERC-8004 identity.
 * docs/datum-quote.md states this limitation normatively.
 *
 * ## Chain-agnostic
 *
 * No chain id, no hardcoded token address, no precompiles, no chain-specific opcodes. The
 * settlement token and fee treasury are constructor parameters, so deploying to another chain is
 * a deployment decision rather than a code change.
 */
contract DatumEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Settled,
        Expired
    }

    struct Escrow {
        // Packed into one slot: 20 + 8 + 1 = 29 bytes.
        address buyer;
        uint64 expiry;
        Status status;
        address seller;
        /// @dev address(0) means seller-only settlement.
        address settler;
        uint256 maxAmount;
    }

    /// @notice Hard ceiling on the fee, enforced at construction. Immutable code, not policy:
    ///         an uncapped fee would be economically equivalent to seizing user funds.
    uint16 public constant MAX_FEE_BPS = 100; // 1%

    uint16 private constant BPS_DENOMINATOR = 10_000;

    /// @notice The settlement token. USDC in build 1, but never assumed to be.
    IERC20 public immutable token;

    /// @notice Fee destination. Immutable — should be a Safe/multisig so signer rotation happens
    ///         at the Safe rather than by redeploying this contract.
    address public immutable treasury;

    /// @notice Fee in basis points, charged on `actualAmount` and deducted from seller proceeds.
    ///         Immutable: no setter, no admin, no timelock.
    uint16 public immutable feeBps;

    mapping(bytes32 => Escrow) public escrows;

    event Opened(
        bytes32 indexed quoteHash,
        address indexed buyer,
        address indexed seller,
        address settler,
        uint256 maxAmount,
        uint64 expiry
    );
    event Settled(bytes32 indexed quoteHash, uint256 actualAmount, bytes32 receiptRef);
    event Expired(bytes32 indexed quoteHash, address indexed buyer, uint256 amount);

    error TokenZero();
    error TreasuryZero();
    error FeeTooHigh(uint16 feeBps, uint16 maxFeeBps);
    error QuoteHashZero();
    error EscrowExists();
    error SellerZero();
    error AmountZero();
    error ExpiryNotInFuture();
    error UnexpectedAmountReceived(uint256 expected, uint256 received);
    error EscrowNotOpen();
    error PastExpiry();
    error NotYetExpired();
    error NotAuthorisedToSettle();
    error AmountExceedsMax(uint256 actualAmount, uint256 maxAmount);

    constructor(IERC20 token_, address treasury_, uint16 feeBps_) {
        if (address(token_) == address(0)) revert TokenZero();
        if (treasury_ == address(0)) revert TreasuryZero();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_, MAX_FEE_BPS);
        token = token_;
        treasury = treasury_;
        feeBps = feeBps_;
    }

    /**
     * @notice Opens an escrow against `quoteHash` and pulls `maxAmount` from the caller.
     * @param quoteHash The quote this escrow settles. Must never have been used before.
     * @param seller The party entitled to settle and to receive proceeds.
     * @param settler An additional party the buyer authorises to call `settle`. Pass
     *        `address(0)` for seller-only settlement.
     * @param maxAmount The ceiling escrowed, in the token's minor units. `settle` can never pay
     *        out more than this.
     * @param expiry Unix timestamp after which the buyer can reclaim and settlement is closed.
     *
     * The caller is the buyer; there is no way to open an escrow that pulls someone else's
     * funds, since the pull is always from `msg.sender`.
     *
     * `settler` is fixed here and can never be changed afterwards — the contract has no function
     * that mutates it. A seller MUST therefore read `settlerOf(quoteHash)` and check it against
     * the settler in their own signed quote before performing any work; see docs/datum-quote.md.
     */
    function openAndFund(
        bytes32 quoteHash,
        address seller,
        address settler,
        uint256 maxAmount,
        uint64 expiry
    ) external nonReentrant {
        if (quoteHash == bytes32(0)) revert QuoteHashZero();
        // Status.None also covers Settled and Expired, so a quoteHash is single-use forever —
        // a settled quote can never be replayed by re-funding the same hash.
        if (escrows[quoteHash].status != Status.None) revert EscrowExists();
        if (seller == address(0)) revert SellerZero();
        if (maxAmount == 0) revert AmountZero();
        if (expiry <= block.timestamp) revert ExpiryNotInFuture();

        escrows[quoteHash] = Escrow({
            buyer: msg.sender,
            expiry: expiry,
            status: Status.Open,
            seller: seller,
            settler: settler,
            maxAmount: maxAmount
        });

        emit Opened(quoteHash, msg.sender, seller, settler, maxAmount, expiry);

        // Effects are complete before this external call; nonReentrant covers the rest.
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), maxAmount);
        uint256 received = token.balanceOf(address(this)) - balanceBefore;

        // A fee-on-transfer or rebasing token would leave the contract holding less than the
        // escrow it just recorded, breaking conservation for every other open escrow too.
        // Reject such tokens outright rather than mis-account them.
        if (received != maxAmount) revert UnexpectedAmountReceived(maxAmount, received);
    }

    /**
     * @notice Settles an open escrow, paying the seller, the treasury and the buyer.
     * @param quoteHash The escrow to settle.
     * @param actualAmount The amount actually consumed, which must not exceed `maxAmount`.
     * @param receiptRef An off-chain receipt reference, emitted for correlation only.
     *
     * Callable by the recorded seller, or by the recorded settler when one was authorised.
     *
     * The fee is charged on `actualAmount`, never on `maxAmount` — a buyer must not pay fees on
     * funds that are refunded to them — and is deducted from the seller's proceeds, so the
     * seller receives `actualAmount - fee`.
     *
     * Conservation holds exactly:
     *   (actualAmount - fee) + fee + (maxAmount - actualAmount) == maxAmount
     */
    function settle(bytes32 quoteHash, uint256 actualAmount, bytes32 receiptRef)
        external
        nonReentrant
    {
        Escrow storage escrow = escrows[quoteHash];

        if (escrow.status != Status.Open) revert EscrowNotOpen();
        // Complementary to expire()'s `> expiry`, so exactly one of the two paths is available
        // at any instant — no window where both or neither can run.
        if (block.timestamp > escrow.expiry) revert PastExpiry();

        address seller = escrow.seller;
        address settler = escrow.settler;
        if (msg.sender != seller && !(settler != address(0) && msg.sender == settler)) {
            revert NotAuthorisedToSettle();
        }

        uint256 maxAmount = escrow.maxAmount;
        if (actualAmount > maxAmount) revert AmountExceedsMax(actualAmount, maxAmount);

        address buyer = escrow.buyer;

        // Effects before interactions: the escrow is terminal from here, so a token that tries
        // to re-enter finds nothing left to settle even before nonReentrant rejects it.
        escrow.status = Status.Settled;

        uint256 fee = (actualAmount * feeBps) / BPS_DENOMINATOR;
        uint256 sellerAmount = actualAmount - fee;
        uint256 refund = maxAmount - actualAmount;

        emit Settled(quoteHash, actualAmount, receiptRef);

        // The only three destinations any token can reach from this contract.
        if (sellerAmount != 0) token.safeTransfer(seller, sellerAmount);
        if (fee != 0) token.safeTransfer(treasury, fee);
        if (refund != 0) token.safeTransfer(buyer, refund);
    }

    /**
     * @notice After expiry, returns the full escrowed amount to the buyer.
     *
     * Permissionless on purpose. The destination is fixed to the recorded buyer, so allowing
     * anyone (a keeper, the seller, the buyer) to trigger it adds liveness without adding any
     * authority over where the money goes.
     */
    function expire(bytes32 quoteHash) external nonReentrant {
        Escrow storage escrow = escrows[quoteHash];

        if (escrow.status != Status.Open) revert EscrowNotOpen();
        if (block.timestamp <= escrow.expiry) revert NotYetExpired();

        address buyer = escrow.buyer;
        uint256 amount = escrow.maxAmount;

        escrow.status = Status.Expired;

        emit Expired(quoteHash, buyer, amount);

        token.safeTransfer(buyer, amount);
    }

    /**
     * @notice The settler authorised for a quote, or address(0) for seller-only settlement.
     * @dev Exists so a seller can perform the check docs/datum-quote.md requires of them before
     *      starting work, without decoding the full escrow tuple.
     */
    function settlerOf(bytes32 quoteHash) external view returns (address) {
        return escrows[quoteHash].settler;
    }

    /// @notice Whether `account` may currently call `settle` for `quoteHash`.
    function canSettle(bytes32 quoteHash, address account) external view returns (bool) {
        Escrow storage escrow = escrows[quoteHash];
        if (escrow.status != Status.Open || block.timestamp > escrow.expiry) return false;
        if (account == address(0)) return false;
        return account == escrow.seller || account == escrow.settler;
    }
}
