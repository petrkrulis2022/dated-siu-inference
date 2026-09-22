// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title CapacityBond
 * @notice Per-issuer, per-class bonded capacity and headroom accounting — Gate Market testbed
 *         WP-2 (docs/gate-market-spec.md §5.3, monetary-design.md §7).
 *
 * An issuer bonds real USDC against a claimed capacity lot (hours committed, measured SIU/hour
 * rate) and may mint claims up to `issuanceLimit = committedCapacityHours * measuredRate * 0.5`.
 * 0.5 (`ISSUANCE_RATIO_BPS`) is fixed, not configurable — monetary-design.md §7.5: "not because
 * 0.5 is correct... but because the testbed needs a number and a conservative one makes headroom
 * exhaustion reachable within the run." Making it a per-lot parameter would let an issuer choose
 * their own leverage, which is a real economic question this build deliberately doesn't open.
 *
 * `outstanding` is mutated only by `WorkClaim` — the immutable `workClaim` address set at
 * construction, never changeable. This contract holds the collateral and the headroom arithmetic;
 * `WorkClaim` owns claim lifecycle and decides when headroom is consumed or restored. Splitting it
 * this way means the money-holding contract never has to reason about ERC-1155 semantics, and the
 * token contract never directly moves USDC except through here.
 *
 * ## Known limitation, disclosed rather than half-solved (see also WorkClaim.sol)
 *
 * `drawForDefault` takes the settlement amount as a caller-supplied parameter. The honest fix —
 * verifying a claimed dated_siu value against `TouchstoneAttestation`'s anchored bodyHash on this
 * same chain — requires reproducing the print body's exact JCS canonicalisation on-chain, which
 * is real, non-trivial work deliberately out of scope for this pass. This mirrors
 * TouchstoneEscrow's own disclosed limitation ("cannot verify the work a quote paid for") rather
 * than silently pretending the number is verified when it isn't. See README.md's "Hard
 * precondition" section for what has to be true before this can be closed for real.
 */
contract CapacityBond {
    using SafeERC20 for IERC20;

    struct Lot {
        uint256 committedCapacityHours;
        /// @dev SIU per hour, in mSIU (1/1000 SIU) — methodology.md §10's integer unit, chosen so
        ///      issuance limits and headroom are always whole integers, never requiring fixed-point
        ///      arithmetic on-chain.
        uint256 measuredRateMilliSiuPerHour;
        uint256 bondedUsdc;
        /// @dev Consumed issuance capacity, in mSIU. Restored on redeem, default, and expire alike
        ///      — see WorkClaim.sol's settleWindowClose for why all three terminal states must.
        uint256 outstanding;
        bool exists;
    }

    /// @notice Fixed at 0.5 — see this contract's own top-level doc comment for why it is not a
    ///         per-lot or per-issuer parameter.
    uint16 public constant ISSUANCE_RATIO_BPS = 5000;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable usdc;

    /// @notice The only address ever permitted to consume/restore headroom or draw a bond.
    ///         Immutable — set once at construction to WorkClaim's own (precomputed) address, so
    ///         no setter is ever needed for what would otherwise be a circular dependency between
    ///         the two contracts. See script/DeployGateMarket.s.sol for how the address is
    ///         precomputed before either contract is deployed.
    address public immutable workClaim;

    mapping(address issuer => mapping(bytes32 classId => Lot)) public lots;
    mapping(bytes32 classId => address[]) private _issuersForClass;
    mapping(address issuer => mapping(bytes32 classId => bool)) private _isRegisteredForClass;

    event LotCreated(
        address indexed issuer,
        bytes32 indexed classId,
        uint256 committedCapacityHours,
        uint256 measuredRateMilliSiuPerHour,
        uint256 bondedUsdc
    );
    event HeadroomConsumed(address indexed issuer, bytes32 indexed classId, uint256 amount);
    event HeadroomRestored(address indexed issuer, bytes32 indexed classId, uint256 amount);
    event DefaultPaid(
        address indexed issuer, bytes32 indexed classId, address indexed holder, uint256 amountUsdc
    );

    error UsdcZero();
    error WorkClaimZero();
    error LotExists();
    error ZeroAmount();
    error OnlyWorkClaim();
    error InsufficientHeadroom(uint256 requested, uint256 available);
    error OutstandingUnderflow(uint256 requested, uint256 available);
    error InsufficientBond(uint256 requested, uint256 available);

    modifier onlyWorkClaim() {
        _checkOnlyWorkClaim();
        _;
    }

    function _checkOnlyWorkClaim() internal view {
        if (msg.sender != workClaim) revert OnlyWorkClaim();
    }

    constructor(IERC20 usdc_, address workClaim_) {
        if (address(usdc_) == address(0)) revert UsdcZero();
        if (workClaim_ == address(0)) revert WorkClaimZero();
        usdc = usdc_;
        workClaim = workClaim_;
    }

    /**
     * @notice Bonds `bondedUsdc` and opens a capacity lot for `msg.sender` in `classId`.
     * @dev One lot per (issuer, class) forever — no top-up, no re-bonding, matching the testbed's
     *      "the run needs a number" simplicity. A real second lot is a new class or, if genuinely
     *      needed, a future contract version — not a mutation of an existing lot's committed
     *      figures, which would retroactively change the basis every already-minted claim against
     *      it was issued under.
     */
    function createLot(
        bytes32 classId,
        uint256 committedCapacityHours,
        uint256 measuredRateMilliSiuPerHour,
        uint256 bondedUsdc
    ) external {
        if (lots[msg.sender][classId].exists) revert LotExists();
        if (committedCapacityHours == 0 || measuredRateMilliSiuPerHour == 0 || bondedUsdc == 0) {
            revert ZeroAmount();
        }

        lots[msg.sender][classId] = Lot({
            committedCapacityHours: committedCapacityHours,
            measuredRateMilliSiuPerHour: measuredRateMilliSiuPerHour,
            bondedUsdc: bondedUsdc,
            outstanding: 0,
            exists: true
        });
        if (!_isRegisteredForClass[msg.sender][classId]) {
            _isRegisteredForClass[msg.sender][classId] = true;
            _issuersForClass[classId].push(msg.sender);
        }

        emit LotCreated(
            msg.sender, classId, committedCapacityHours, measuredRateMilliSiuPerHour, bondedUsdc
        );

        usdc.safeTransferFrom(msg.sender, address(this), bondedUsdc);
    }

    /// @notice Every issuer that has ever created a lot in `classId` — ClaimRouter's candidate set.
    ///         Includes issuers whose lot may since be fully consumed; ClaimRouter filters on
    ///         live headroom, this just enumerates who to ask.
    function issuersForClass(bytes32 classId) external view returns (address[] memory) {
        return _issuersForClass[classId];
    }

    function issuanceLimit(address issuer, bytes32 classId) public view returns (uint256) {
        Lot storage lot = lots[issuer][classId];
        if (!lot.exists) return 0;
        return (lot.committedCapacityHours * lot.measuredRateMilliSiuPerHour * ISSUANCE_RATIO_BPS)
            / BPS_DENOMINATOR;
    }

    function headroom(address issuer, bytes32 classId) public view returns (uint256) {
        uint256 limit = issuanceLimit(issuer, classId);
        uint256 out = lots[issuer][classId].outstanding;
        return out >= limit ? 0 : limit - out;
    }

    /// @notice Consumes `amount` of headroom — called by WorkClaim on mint only.
    function consumeHeadroom(address issuer, bytes32 classId, uint256 amount)
        external
        onlyWorkClaim
    {
        if (amount == 0) revert ZeroAmount();
        uint256 avail = headroom(issuer, classId);
        if (amount > avail) revert InsufficientHeadroom(amount, avail);
        lots[issuer][classId].outstanding += amount;
        emit HeadroomConsumed(issuer, classId, amount);
    }

    /// @notice Restores `amount` of headroom — called by WorkClaim on redeem, default, and expire
    ///         alike. Which terminal path a claim took is WorkClaim's concern; every one of them
    ///         must free the capacity it consumed, or headroom locks up permanently for claims
    ///         nobody redeemed and nobody defaulted on either.
    function restoreHeadroom(address issuer, bytes32 classId, uint256 amount)
        external
        onlyWorkClaim
    {
        if (amount == 0) revert ZeroAmount();
        Lot storage lot = lots[issuer][classId];
        if (amount > lot.outstanding) revert OutstandingUnderflow(amount, lot.outstanding);
        lot.outstanding -= amount;
        emit HeadroomRestored(issuer, classId, amount);
    }

    /// @notice Pays `holder` from `issuer`'s bonded collateral — called by WorkClaim exactly once
    ///         per defaulted position (WorkClaim's own `settled` latch enforces the "exactly
    ///         once" property; this function only enforces that the bond has the funds).
    function drawForDefault(address issuer, bytes32 classId, address holder, uint256 amountUsdc)
        external
        onlyWorkClaim
    {
        if (amountUsdc == 0) revert ZeroAmount();
        Lot storage lot = lots[issuer][classId];
        if (amountUsdc > lot.bondedUsdc) revert InsufficientBond(amountUsdc, lot.bondedUsdc);
        lot.bondedUsdc -= amountUsdc;
        emit DefaultPaid(issuer, classId, holder, amountUsdc);
        usdc.safeTransfer(holder, amountUsdc);
    }
}
