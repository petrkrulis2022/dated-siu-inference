// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {WorkClaim} from "./WorkClaim.sol";
import {RateAttestationVerifier} from "./RateAttestationVerifier.sol";
import {AguBuffer} from "./AguBuffer.sol";

/**
 * @title AguLab
 * @notice AGU-lab: the CR lab's inside unit, an ERC-20 whose units are pro-rata shares of a
 *         reserve of Commodity-grade work claims. Testnet only, inside the CR economy
 *         (docs/part5-build-plan.md §4.3, rules R1 to R12; decisions recorded below).
 *
 * The contract is the reserve and the AGU-lab issuer's rules for it. It holds WorkClaim lots and
 * no USDC at rest. Three things change it, each by one function and one role:
 *
 *  - `create`, the authorised participant only: delivers claims in, mints units at NAV.
 *  - `redeem`, any holder: burns units, pays the holder its pro-rata share of every live lot,
 *    in kind. Never USDC, never the buffer, never paused or delayed.
 *  - `roll`, the AGU-lab issuer role only: in one call, retires the front lots, sells front claims
 *    to agents for USDC at the posted price, buys next window's claims through WorkClaim, covers
 *    a shortfall from the buffer, sends carry to the buffer and the income ledger, and ends at
 *    exactly zero USDC or reverts.
 *
 * ## Units (R1, R3)
 *
 * A plain OpenZeppelin ERC-20, 6 decimals, no fee, no rebase, no transfer hook: the CR economy's
 * second TouchstoneEscrow rejects any token whose balances move by anything but the amount sent,
 * and its MIN_SETTLEMENT is 100 base units. NAV floats through the reserve, never through
 * balances. At the first creation 1 mSIU of face is 1,000 base units, so 1 SIU is 1 AGU-lab;
 * after that a creation mints `faceMilli × totalSupply ÷ liveFaceMilli`, rounded down, so a
 * creator pays exactly the reserve value per unit existing holders hold, whether NAV is above 1
 * or below (rounding favours the holders).
 *
 * ## The grade check is by series (decision 1)
 *
 * In WorkClaim a claim's `classId` is its task class and its `series` is its grade
 * (SERIES_COMMODITY or SERIES_FRONTIER). AGU-lab is single-grade (the owner's change (a)): the
 * reserve holds claims of one series, the immutable `reserveSeries` (SERIES_COMMODITY in the CR
 * deployment), and any task class. The plan named this `commodityClassId`; that was a misnomer
 * for the series, and the series is what is checked: on `create` against the lot's own
 * `claimTypes` entry, and on `roll` twice, against the rate attestation's series and by minting
 * with `reserveSeries` itself.
 *
 * **Limitation: a claim's series is a label its minter chose, not a property of its issuer.**
 * `WorkClaim.mint` takes `series` from the caller and routes by `classId` alone, so the series
 * check here proves only that whoever minted the lot called it Commodity. If a Frontier issuer
 * held a CapacityBond lot in a class the Commodity issuers also serve, a claim minted with the
 * Commodity series could be routed to it, and this contract would accept that claim into the
 * reserve. Nothing on-chain prevents it (WorkClaim is unchanged). In the CR deployment it is
 * prevented by configuration: the Frontier issuer holds CR-VS lots only, and the Commodity
 * issuers hold CR-PL, CR-SM and CR-UO lots, so a mint in a Commodity class can only route to a
 * Commodity issuer (DeployCrEconomy.t.sol's smoke run asserts that for CR-PL). Any change to
 * which issuer bonds which class has to keep that separation, or the single-grade rule (R3)
 * stops holding.
 *
 * ## Live face, and retired lots (decision 3)
 *
 * Live face is the sum of the reserve's balances over lots that are not retired and whose window
 * has not closed. It is read from WorkClaim's own balances, never a copy kept here, so it cannot
 * drift from the claims actually held; this also means a burn the reserve did not make (a routed
 * issuer can burn any holder's claims through `serveRedemption`, a WorkClaim property) lowers NAV
 * honestly instead of blocking redemption on a balance that is no longer there.
 *
 * The roll retires the front lots it names. A retired lot leaves live face and redemption at
 * once, so NAV never counts a front lot and its replacement together. Its unsold claims stay
 * held until its window closes, and are then burned by anyone calling
 * `WorkClaim.settleWindowClose(tokenId, address(aguLab), emptyAttestation, "")`: Expired, never
 * presented, so no bond draw. AguLab never calls `presentForRedemption` (NoAdminPathAguLab.t.sol
 * scans the bytecode for that selector).
 *
 * ## The roll's money (decision 7, R5 to R7)
 *
 * One Commodity rate attestation prices both legs: front claims sell at
 * `rate × (10,000 − discountBps) ÷ 10,000` and next-window claims cost `rate` through
 * `WorkClaim.mint`. It is signed twice by the same lab key, once for this contract's EIP-712
 * domain and once for WorkClaim's, because RateAttestationVerifier binds the verifying contract
 * into the domain. Funds are the sale proceeds plus any stray USDC already here. The required
 * face R is the face of the front lots retired (sold plus unsold). Then:
 *
 *  - Buying R in full is the rule while it can be paid for. Funds pay first; the buffer pays any
 *    shortfall. Whatever funds are left over is carry: to the buffer up to its target, the rest to
 *    the income ledger, never into claims (R7: carry in the reserve would lift NAV above 1).
 *  - Only when funds plus the whole buffer cannot pay for R may the roll buy less, and then it
 *    must buy the most face that money pays for (less than the price of one more mSIU left over).
 *    NAV falls. The buffer pays the difference between cost and funds; leftover dust goes to the
 *    buffer. The buffer is drawn for exactly what the purchase needs rather than emptied and
 *    refilled with the dust; the end balances are the same.
 *  - Buying more than R is refused.
 *
 * Participant USDC, agents' USDC other than a sale buyer paying the posted price, and the income
 * ledger are never inputs: the roll pulls only from the listed buyers (none of which may be the
 * participant, the income ledger, the buffer or the issuer role) and from the buffer.
 *
 * Because both legs use the same rate and the discount is non-negative, the proceeds of a sale
 * never exceed the cost of replacing what was sold, so positive carry arises only from stray USDC
 * (or a zero discount with rounding). That is the design as specified, stated so nobody reads a
 * missing carry as a fault.
 *
 * ## No admin path (R2)
 *
 * The issuer role, the participant, the income ledger, the buffer, WorkClaim, the series, the
 * minimum tenor and the discount are immutable. No owner, pause, upgrade, sweep or setter. Nothing
 * moves a holder's units except the holder's own transfer, approve or redeem. The reserve accepts
 * ERC-1155 claims only when it pulled them itself, so no one can push claims into it. Invariant
 * 7 holds by construction: `create` takes a claim and a face amount, never a gate verdict or a
 * proof, so verified-work proofs never feed supply.
 */
contract AguLab is ERC20, ReentrancyGuard, RateAttestationVerifier, IERC1155Receiver {
    using SafeERC20 for IERC20;

    /// @notice One front-claim sale in a roll: `quantityMilli` mSIU of retired lot `tokenId` to
    ///         `buyer`, who pays the posted price from its prior USDC approval to this contract.
    struct Sale {
        address buyer;
        uint256 tokenId;
        uint256 quantityMilli;
    }

    /// @notice One next-window purchase in a roll: `quantityMilli` mSIU in task class `classId`,
    ///         of the reserve's series, routed by WorkClaim's router (never picked here).
    struct Buy {
        bytes32 classId;
        uint256 quantityMilli;
    }

    /// @notice Everything a roll does, in one argument. `buyFrom`/`buyTo` is the next window,
    ///         shared by every purchase.
    struct RollOrder {
        uint256[] frontLots;
        Sale[] sales;
        Buy[] buys;
        uint64 buyFrom;
        uint64 buyTo;
    }

    struct Lot {
        bool known;
        bool retired;
        uint64 windowFrom;
        uint64 windowTo;
        /// @dev The roll that retired it (0 if never): a roll may sell only what it retired.
        uint64 retiredAtRoll;
    }

    /// @dev One roll's figures, kept in memory: the roll touches more values than the EVM's
    ///      sixteen reachable stack slots hold.
    struct RollTotals {
        uint256 rate;
        uint256 proceeds;
        uint256 stray;
        uint256 cost;
        uint256 cover;
        uint256 toBuffer;
        uint256 toIncome;
        uint256 faceSold;
        uint256 faceUnsold;
        uint256 faceBought;
        uint256 faceRequired;
        uint64 frontEnd;
    }

    /// @notice 1 mSIU of face is 1,000 base units at the first creation (1 SIU = 1 AGU-lab).
    uint256 public constant UNITS_PER_MILLI_SIU = 1_000;
    uint16 private constant BPS = 10_000;
    /// @dev mSIU × nano-USD per SIU ÷ 1e6 = USDC base units: WorkClaim's own `_usdcAmount`.
    uint256 private constant MILLI_NANO_TO_USDC = 1_000_000;

    WorkClaim public immutable workClaim;
    /// @notice WorkClaim's own USDC: the only dollar the roll ever handles.
    IERC20 public immutable usdc;
    AguBuffer public immutable buffer;
    /// @notice The AGU-lab issuer role (plan §4.2), not a WorkClaim issuer: the only caller of
    ///         `roll`.
    address public immutable aguIssuer;
    /// @notice The authorised participant: the only caller of `create`.
    address public immutable participant;
    /// @notice The issuer's income ledger: receives carry above the buffer's target, nothing else.
    address public immutable incomeLedger;
    /// @notice The one series (grade) the reserve holds. See "The grade check is by series".
    bytes32 public immutable reserveSeries;
    /// @notice A created or bought lot must have at least this long left before its window ends.
    uint64 public immutable minTenor;
    /// @notice The roll's discount on the attested rate for front-claim sales, in basis points.
    uint16 public immutable discountBps;

    /// @notice True only inside `roll`; AguBuffer reads it before paying cover.
    bool public rollInProgress;
    uint256 public rollCount;
    mapping(uint256 tokenId => Lot) public lots;
    /// @dev Every lot whose window has not closed as of the last roll; closed lots are dropped
    ///      by `roll`, so the loops below stay bounded by a few windows of lots.
    uint256[] private _lotIds;

    event Created(
        address indexed participant, uint256 indexed tokenId, uint256 faceMilli, uint256 units
    );
    /// @notice R12: names every lot delivered, with its amount and its window end, so the engine
    ///         can give the holder the same arrival notice and lapse warning as a bought claim.
    event Redeemed(
        address indexed holder,
        uint256 units,
        uint256[] tokenIds,
        uint256[] amounts,
        uint64[] windowTos
    );
    event FrontLotRetired(
        uint256 indexed rollId, uint256 indexed tokenId, uint256 faceMilli, uint64 windowTo
    );
    event FrontClaimSold(
        uint256 indexed rollId,
        address indexed buyer,
        uint256 indexed tokenId,
        uint256 quantityMilli,
        uint256 usdcAmount
    );
    event NextClaimBought(
        uint256 indexed rollId,
        uint256 indexed tokenId,
        bytes32 classId,
        uint256 quantityMilli,
        uint256 usdcAmount
    );
    /// @notice One per roll: every figure the engine logs as roll-sale, roll-buy, roll-cover and
    ///         roll-carry. `stray` is USDC that was here before the roll's own sales.
    event Rolled(
        uint256 indexed rollId,
        uint256 rateNanoUsdPerSiu,
        uint256 proceeds,
        uint256 stray,
        uint256 cost,
        uint256 cover,
        uint256 toBuffer,
        uint256 toIncome,
        uint256 faceSold,
        uint256 faceUnsold,
        uint256 faceBought
    );

    error WorkClaimZero();
    error BufferZero();
    error AguIssuerZero();
    error ParticipantZero();
    error IncomeLedgerZero();
    error SeriesZero();
    error MinTenorZero();
    error DiscountTooHigh(uint16 discountBps);
    /// @notice R10: the issuer role, the participant, the income ledger and the buffer are four
    ///         separate wallets.
    error RolesNotSeparate();
    error BufferNotBoundToThisLab(address boundTo);
    error BufferDollarMismatch(address bufferUsdc, address claimUsdc);
    error NotParticipant(address caller);
    error NotAguIssuer(address caller);
    error ZeroAmount();
    error ZeroRate();
    error UnknownClaim(uint256 tokenId);
    /// @notice R3: AGU-lab is single-grade.
    error WrongSeries(bytes32 series, bytes32 reserveSeries);
    error TenorTooShort(uint64 windowTo, uint64 minTenor);
    error LotRetired(uint256 tokenId);
    /// @notice Units are outstanding but no live face holds them: NAV is zero and creation at
    ///         NAV is undefined.
    error NoLiveFace();
    error ZeroUnits();
    /// @notice Too few units to round to one mSIU of any lot: refused rather than burned for
    ///         nothing.
    error NothingToRedeem(uint256 units);
    error NotLiveLot(uint256 tokenId);
    error NotAFrontLot(uint256 tokenId, uint64 windowFrom, uint64 windowTo);
    error NotRetiredThisRoll(uint256 tokenId);
    /// @notice R6: participant USDC, the income ledger, the buffer and the issuer role never pay
    ///         into a roll.
    error IneligibleBuyer(address buyer);
    error SaleRoundsToZero(uint256 quantityMilli);
    error BuyWindowOverlapsFront(uint64 buyFrom, uint64 frontWindowTo);
    /// @notice R7: carry never buys claims beyond the face retired.
    error RollOverbuys(uint256 faceBought, uint256 faceRequired);
    /// @notice R6: face may fall short only when no more of it can be paid for.
    error RollUnderbuys(
        uint256 faceBought, uint256 faceRequired, uint256 leftover, uint256 oneMoreMilliCost
    );
    /// @notice R6: the full face costs more than funds plus the buffer; buy the most affordable.
    error RollShortfallExceedsBuffer(uint256 shortfall, uint256 bufferBalance);
    error RollUnaffordable(uint256 cost, uint256 available);
    /// @notice WorkClaim took a different amount than its own price formula gives.
    error CostMismatch(uint256 expected, uint256 spent);
    /// @notice R5/Q11: the roll must end with the reserve holding exactly zero USDC.
    error ReserveUsdcNotZero(uint256 balance);
    /// @notice The reserve accepts claims only when it pulled them itself.
    error UnsolicitedClaims(address operator);

    constructor(
        WorkClaim workClaim_,
        AguBuffer buffer_,
        address aguIssuer_,
        address participant_,
        address incomeLedger_,
        bytes32 reserveSeries_,
        uint64 minTenor_,
        uint16 discountBps_
    )
        ERC20("AGU-lab (Touchstone CR lab, testnet only)", "AGU-lab")
        RateAttestationVerifier(_publisherOf(workClaim_), "Touchstone Rate Attestation", "1")
    {
        if (address(buffer_) == address(0)) revert BufferZero();
        if (aguIssuer_ == address(0)) revert AguIssuerZero();
        if (participant_ == address(0)) revert ParticipantZero();
        if (incomeLedger_ == address(0)) revert IncomeLedgerZero();
        if (reserveSeries_ == bytes32(0)) revert SeriesZero();
        if (minTenor_ == 0) revert MinTenorZero();
        if (discountBps_ >= BPS) revert DiscountTooHigh(discountBps_);
        if (
            aguIssuer_ == participant_ || aguIssuer_ == incomeLedger_
                || participant_ == incomeLedger_ || address(buffer_) == aguIssuer_
                || address(buffer_) == participant_ || address(buffer_) == incomeLedger_
        ) revert RolesNotSeparate();
        if (buffer_.aguLab() != address(this)) revert BufferNotBoundToThisLab(buffer_.aguLab());
        IERC20 claimUsdc = workClaim_.usdc();
        if (address(buffer_.usdc()) != address(claimUsdc)) {
            revert BufferDollarMismatch(address(buffer_.usdc()), address(claimUsdc));
        }

        workClaim = workClaim_;
        usdc = claimUsdc;
        buffer = buffer_;
        aguIssuer = aguIssuer_;
        participant = participant_;
        incomeLedger = incomeLedger_;
        reserveSeries = reserveSeries_;
        minTenor = minTenor_;
        discountBps = discountBps_;
    }

    /// @dev The lab key WorkClaim trusts, so both verify the same publisher. Checked for zero
    ///      here because it runs in the base-constructor arguments, before the body.
    function _publisherOf(WorkClaim workClaim_) private view returns (address) {
        if (address(workClaim_) == address(0)) revert WorkClaimZero();
        return workClaim_.publisher();
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ================================================================== create (R3)

    /**
     * @notice The participant delivers `faceMilli` mSIU of claim `tokenId` and is minted units at
     *         NAV: `faceMilli × 1,000` at the first creation, `faceMilli × supply ÷ live face`
     *         after, rounded down.
     * @dev Refuses another series, a retired lot, and a lot with less than `minTenor` left.
     *      Pulls the claims with `safeTransferFrom` (the participant has approved this contract
     *      with `setApprovalForAll`). Units are computed before the pull, because the pull itself
     *      changes live face.
     */
    function create(uint256 tokenId, uint256 faceMilli)
        external
        nonReentrant
        returns (uint256 units)
    {
        if (msg.sender != participant) revert NotParticipant(msg.sender);
        if (faceMilli == 0) revert ZeroAmount();
        (,, bytes32 series, uint64 windowFrom, uint64 windowTo, bool exists,) =
            workClaim.claimTypes(tokenId);
        if (!exists) revert UnknownClaim(tokenId);
        if (series != reserveSeries) revert WrongSeries(series, reserveSeries);
        if (lots[tokenId].retired) revert LotRetired(tokenId);
        _requireTenor(windowTo);

        units = _unitsFor(faceMilli);
        _track(tokenId, windowFrom, windowTo);
        emit Created(msg.sender, tokenId, faceMilli, units);

        workClaim.safeTransferFrom(msg.sender, address(this), tokenId, faceMilli, "");
        _mint(msg.sender, units);
    }

    function _unitsFor(uint256 faceMilli) internal view returns (uint256 units) {
        uint256 supply = totalSupply();
        if (supply == 0) return faceMilli * UNITS_PER_MILLI_SIU;
        uint256 live = liveFaceMilli();
        if (live == 0) revert NoLiveFace();
        units = (faceMilli * supply) / live;
        if (units == 0) revert ZeroUnits();
    }

    // ================================================================== redeem (R4, R12)

    /**
     * @notice Burns `units` of the caller's AGU-lab and transfers it
     *         `floor(units × lot balance ÷ supply)` of every live lot, in kind.
     * @dev Claims only: no USDC path exists here, and the buffer is never touched. Rounding down
     *      leaves dust in the reserve, so nobody takes more than a pro-rata share. Burns before
     *      transferring, so a receiver hook that re-enters (refused anyway by the guard) would
     *      find the units gone. Emits `Redeemed` naming every lot delivered (R12).
     */
    function redeem(uint256 units)
        external
        nonReentrant
        returns (uint256[] memory tokenIds, uint256[] memory amounts)
    {
        if (units == 0) revert ZeroAmount();
        uint64[] memory windowTos;
        (tokenIds, amounts, windowTos) = _shareOf(units, totalSupply());
        if (tokenIds.length == 0) revert NothingToRedeem(units);

        _burn(msg.sender, units);
        emit Redeemed(msg.sender, units, tokenIds, amounts, windowTos);
        for (uint256 i = 0; i < tokenIds.length; i++) {
            workClaim.safeTransferFrom(address(this), msg.sender, tokenIds[i], amounts[i], "");
        }
    }

    /// @dev The non-zero pro-rata share of `units` out of `supply` in every live lot.
    function _shareOf(uint256 units, uint256 supply)
        internal
        view
        returns (uint256[] memory tokenIds, uint256[] memory amounts, uint64[] memory windowTos)
    {
        uint256 n = _lotIds.length;
        tokenIds = new uint256[](n);
        amounts = new uint256[](n);
        windowTos = new uint64[](n);
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            uint256 id = _lotIds[i];
            if (!isLive(id)) continue;
            uint256 amount = (units * workClaim.balanceOf(address(this), id)) / supply;
            if (amount == 0) continue;
            tokenIds[count] = id;
            amounts[count] = amount;
            windowTos[count] = lots[id].windowTo;
            count++;
        }
        assembly {
            mstore(tokenIds, count)
            mstore(amounts, count)
            mstore(windowTos, count)
        }
    }

    // ================================================================== roll (R5, R6, R7)

    /**
     * @notice The roll, in one call: verify the Commodity rate, retire the front lots, sell
     *         front claims to the listed buyers, buy next window's claims, cover a shortfall from
     *         the buffer, send carry out, and end at exactly zero USDC or revert.
     * @param order The front lots to retire, the sales, the purchases and the next window.
     * @param att One Commodity rate attestation for both legs.
     * @param labSig `att` signed by the lab key for this contract's EIP-712 domain.
     * @param claimSig `att` signed by the lab key for WorkClaim's domain, passed to its `mint`.
     */
    function roll(
        RollOrder calldata order,
        RateAttestation calldata att,
        bytes calldata labSig,
        bytes calldata claimSig
    ) external nonReentrant {
        if (msg.sender != aguIssuer) revert NotAguIssuer(msg.sender);
        rollInProgress = true;
        uint256 rollId = ++rollCount;

        RollTotals memory t;
        t.rate = _reserveRate(att, labSig);
        _retireFront(rollId, order.frontLots, t);
        _sellFront(rollId, order.sales, t);
        t.faceUnsold = t.faceRequired - t.faceSold;
        _priceBuys(order, t);

        uint256 funds = usdc.balanceOf(address(this));
        t.stray = funds - t.proceeds;
        _drawCover(order.buys, t, funds);
        _buyNext(rollId, order, att, claimSig, t);
        _sendLeftover(t);
        _dropClosedLots();

        uint256 left = usdc.balanceOf(address(this));
        if (left != 0) revert ReserveUsdcNotZero(left);
        rollInProgress = false;
        _emitRolled(rollId, t);
    }

    function _reserveRate(RateAttestation calldata att, bytes calldata labSig)
        internal
        view
        returns (uint256 rate)
    {
        bytes32 series;
        (rate, series,) = _verifyRateAttestation(att, labSig);
        if (series != reserveSeries) revert WrongSeries(series, reserveSeries);
        if (rate == 0) revert ZeroRate();
    }

    /// @dev A front lot is one the reserve holds, not yet retired, whose window is open now.
    function _retireFront(uint256 rollId, uint256[] calldata ids, RollTotals memory t) internal {
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            Lot storage lot = lots[id];
            if (!lot.known || lot.retired) revert NotLiveLot(id);
            if (block.timestamp < lot.windowFrom || block.timestamp >= lot.windowTo) {
                revert NotAFrontLot(id, lot.windowFrom, lot.windowTo);
            }
            lot.retired = true;
            lot.retiredAtRoll = uint64(rollId);
            uint256 face = workClaim.balanceOf(address(this), id);
            t.faceRequired += face;
            if (lot.windowTo > t.frontEnd) t.frontEnd = lot.windowTo;
            emit FrontLotRetired(rollId, id, face, lot.windowTo);
        }
    }

    function _sellFront(uint256 rollId, Sale[] calldata sales, RollTotals memory t) internal {
        uint256 price = (t.rate * (BPS - discountBps)) / BPS;
        for (uint256 i = 0; i < sales.length; i++) {
            Sale calldata s = sales[i];
            _checkBuyer(s.buyer);
            if (s.quantityMilli == 0) revert ZeroAmount();
            Lot storage lot = lots[s.tokenId];
            if (!lot.retired || lot.retiredAtRoll != rollId) revert NotRetiredThisRoll(s.tokenId);
            uint256 amount = (s.quantityMilli * price) / MILLI_NANO_TO_USDC;
            if (amount == 0) revert SaleRoundsToZero(s.quantityMilli);

            t.proceeds += amount;
            t.faceSold += s.quantityMilli;
            emit FrontClaimSold(rollId, s.buyer, s.tokenId, s.quantityMilli, amount);
            usdc.safeTransferFrom(s.buyer, address(this), amount);
            workClaim.safeTransferFrom(address(this), s.buyer, s.tokenId, s.quantityMilli, "");
        }
    }

    function _checkBuyer(address buyer) internal view {
        if (
            buyer == address(0) || buyer == participant || buyer == incomeLedger
                || buyer == address(buffer) || buyer == aguIssuer || buyer == address(this)
        ) revert IneligibleBuyer(buyer);
    }

    /// @dev Validates the next window and the quantities, and prices them with WorkClaim's own
    ///      formula. Refuses buying more face than was retired (R7).
    function _priceBuys(RollOrder calldata order, RollTotals memory t) internal view {
        if (order.buys.length > 0) {
            if (order.buyFrom < t.frontEnd) {
                revert BuyWindowOverlapsFront(order.buyFrom, t.frontEnd);
            }
            _requireTenor(order.buyTo);
        }
        for (uint256 i = 0; i < order.buys.length; i++) {
            uint256 q = order.buys[i].quantityMilli;
            if (q == 0) revert ZeroAmount();
            t.cost += _usdcFor(q, t.rate);
            t.faceBought += q;
        }
        if (t.faceBought > t.faceRequired) revert RollOverbuys(t.faceBought, t.faceRequired);
    }

    /// @dev The waterfall (R6): funds first, then the buffer; face may fall short only when funds
    ///      plus the whole buffer leave less than the price of one more mSIU.
    function _drawCover(Buy[] calldata buys, RollTotals memory t, uint256 funds) internal {
        uint256 bufferBalance = usdc.balanceOf(address(buffer));
        if (t.faceBought == t.faceRequired) {
            if (t.cost > funds) {
                uint256 shortfall = t.cost - funds;
                if (shortfall > bufferBalance) {
                    revert RollShortfallExceedsBuffer(shortfall, bufferBalance);
                }
                t.cover = shortfall;
            }
        } else {
            uint256 available = funds + bufferBalance;
            if (t.cost > available) revert RollUnaffordable(t.cost, available);
            uint256 oneMore = _oneMoreMilliCost(buys, t.rate);
            if (available - t.cost >= oneMore) {
                revert RollUnderbuys(t.faceBought, t.faceRequired, available - t.cost, oneMore);
            }
            if (t.cost > funds) t.cover = t.cost - funds;
        }
        if (t.cover > 0) buffer.cover(t.cover);
    }

    /// @dev What one more mSIU on the last purchase line would add to the cost (or one mSIU on
    ///      its own, with no lines), at WorkClaim's rounding.
    function _oneMoreMilliCost(Buy[] calldata buys, uint256 rate) internal pure returns (uint256) {
        if (buys.length == 0) return _usdcFor(1, rate);
        uint256 q = buys[buys.length - 1].quantityMilli;
        return _usdcFor(q + 1, rate) - _usdcFor(q, rate);
    }

    function _buyNext(
        uint256 rollId,
        RollOrder calldata order,
        RateAttestation calldata att,
        bytes calldata claimSig,
        RollTotals memory t
    ) internal {
        if (order.buys.length == 0) return;
        uint256 before = usdc.balanceOf(address(this));
        usdc.forceApprove(address(workClaim), t.cost);
        for (uint256 i = 0; i < order.buys.length; i++) {
            Buy calldata b = order.buys[i];
            uint256 id = workClaim.mint(
                b.classId, reserveSeries, b.quantityMilli, order.buyFrom, order.buyTo, att, claimSig
            );
            // A retired lot's window is open now and the next window starts after it, so the
            // ids can never coincide; checked anyway, because a match would hide face.
            if (lots[id].retired) revert LotRetired(id);
            _track(id, order.buyFrom, order.buyTo);
            emit NextClaimBought(
                rollId, id, b.classId, b.quantityMilli, _usdcFor(b.quantityMilli, t.rate)
            );
        }
        uint256 spent = before - usdc.balanceOf(address(this));
        if (spent != t.cost) revert CostMismatch(t.cost, spent);
    }

    /// @dev Carry (R7) when the face was restored in full: to the buffer up to its target, the
    ///      rest to the income ledger. Dust after a short roll goes to the buffer.
    function _sendLeftover(RollTotals memory t) internal {
        uint256 left = usdc.balanceOf(address(this));
        if (left == 0) return;
        if (t.faceBought == t.faceRequired) {
            uint256 target = buffer.target();
            uint256 held = usdc.balanceOf(address(buffer));
            uint256 room = target > held ? target - held : 0;
            t.toBuffer = left < room ? left : room;
            t.toIncome = left - t.toBuffer;
        } else {
            t.toBuffer = left;
        }
        if (t.toBuffer > 0) usdc.safeTransfer(address(buffer), t.toBuffer);
        if (t.toIncome > 0) usdc.safeTransfer(incomeLedger, t.toIncome);
    }

    function _emitRolled(uint256 rollId, RollTotals memory t) internal {
        emit Rolled(
            rollId,
            t.rate,
            t.proceeds,
            t.stray,
            t.cost,
            t.cover,
            t.toBuffer,
            t.toIncome,
            t.faceSold,
            t.faceUnsold,
            t.faceBought
        );
    }

    /// @dev Drops lots whose window has closed. Their face is already out of live face; any
    ///      claims still held are awaiting `settleWindowClose` (Expired).
    function _dropClosedLots() internal {
        uint256 i = 0;
        while (i < _lotIds.length) {
            if (lots[_lotIds[i]].windowTo <= block.timestamp) {
                _lotIds[i] = _lotIds[_lotIds.length - 1];
                _lotIds.pop();
            } else {
                i++;
            }
        }
    }

    // ================================================================== shared internals

    function _requireTenor(uint64 windowTo) internal view {
        if (windowTo <= block.timestamp || windowTo - block.timestamp < minTenor) {
            revert TenorTooShort(windowTo, minTenor);
        }
    }

    function _track(uint256 id, uint64 windowFrom, uint64 windowTo) internal {
        if (lots[id].known) return;
        lots[id] = Lot({
            known: true,
            retired: false,
            windowFrom: windowFrom,
            windowTo: windowTo,
            retiredAtRoll: 0
        });
        _lotIds.push(id);
    }

    /// @dev WorkClaim's own price: `floor(quantityMilli × nanoUsdPerSiu ÷ 1e6)` USDC base units.
    function _usdcFor(uint256 quantityMilli, uint256 nanoUsdPerSiu)
        internal
        pure
        returns (uint256)
    {
        return (quantityMilli * nanoUsdPerSiu) / MILLI_NANO_TO_USDC;
    }

    // ================================================================== views (R8)

    /// @notice The reserve's live face in mSIU: its balances over lots not retired and not closed.
    function liveFaceMilli() public view returns (uint256 face) {
        for (uint256 i = 0; i < _lotIds.length; i++) {
            uint256 id = _lotIds[i];
            if (isLive(id)) face += workClaim.balanceOf(address(this), id);
        }
    }

    /// @notice Reserve NAV in SIU per AGU-lab, scaled by 1e18: live face ÷ supply. With no
    ///         supply it reports 1e18, the rate a first creation gets. The buffer-supported NAV is
    ///         published off-chain (R8): this contract values claims only.
    function navWad() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (liveFaceMilli() * UNITS_PER_MILLI_SIU * 1e18) / supply;
    }

    function isLive(uint256 tokenId) public view returns (bool) {
        Lot storage lot = lots[tokenId];
        return lot.known && !lot.retired && lot.windowTo > block.timestamp;
    }

    function reserveBalance(uint256 tokenId) external view returns (uint256) {
        return workClaim.balanceOf(address(this), tokenId);
    }

    /// @notice Every lot whose window had not closed at the last roll, retired or not.
    function lotIds() external view returns (uint256[] memory) {
        return _lotIds;
    }

    function previewCreate(uint256 faceMilli) external view returns (uint256) {
        return _unitsFor(faceMilli);
    }

    /// @notice What `redeem(units)` would deliver now; empty when it would deliver nothing.
    function previewRedeem(uint256 units)
        external
        view
        returns (uint256[] memory tokenIds, uint256[] memory amounts, uint64[] memory windowTos)
    {
        uint256 supply = totalSupply();
        if (units == 0 || units > supply) {
            return (new uint256[](0), new uint256[](0), new uint64[](0));
        }
        return _shareOf(units, supply);
    }

    // ================================================================== ERC-1155 receipt

    /// @notice Accepts claims only when this contract pulled them itself (a creation's
    ///         `safeTransferFrom`, or a roll's `WorkClaim.mint`), so nobody can push claims into
    ///         the reserve and change its face without units. `view`: it records nothing.
    function onERC1155Received(address operator, address, uint256, uint256, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(workClaim) || operator != address(this)) {
            revert UnsolicitedClaims(operator);
        }
        return this.onERC1155Received.selector;
    }

    /// @notice The reserve never receives a batch: it pulls and mints one lot at a time.
    function onERC1155BatchReceived(
        address operator,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert UnsolicitedClaims(operator);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }
}
