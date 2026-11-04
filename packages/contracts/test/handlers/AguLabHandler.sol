// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {CapacityBond} from "../../src/CapacityBond.sol";
import {WorkClaim} from "../../src/WorkClaim.sol";
import {RateAttestationVerifier} from "../../src/RateAttestationVerifier.sol";
import {AguBuffer} from "../../src/AguBuffer.sol";
import {AguLab} from "../../src/AguLab.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * Drives AguLab through arbitrary interleavings of create / transfer / redeem / roll / stray
 * donations / buffer seeds / time / expiry settlement, plus attempts by an outsider at every
 * privileged path, for AguLab.invariant.t.sol's seven invariants (docs/part5-build-plan.md §5).
 *
 * Checks that must hold across a single call (value per unit through a creation or a
 * redemption, the reserve at zero USDC after a roll, which balances a roll may move) are made
 * here, immediately around the call, and recorded as violation counters rather than asserted,
 * so each violation is reported against the invariant it breaks, and so the handler stays sound
 * under the repository's default `fail_on_revert = false`, where an assertion failing inside a
 * handler call would be swallowed as an ordinary revert. (AguLab.invariant.t.sol itself turns
 * fail-on-revert on, because this handler is written never to revert.) Each counter must stay
 * zero, and the invariant test asserts exactly that.
 *
 * The handler keeps its own ghost record of every balance the contracts hold (units per holder,
 * claims per lot, the buffer's and the income ledger's inflows and outflows), built only from
 * what each call returned or emitted, and the invariants compare that record with the chain.
 */
contract AguLabHandler is Test {
    MockUSDC public immutable usdc;
    CapacityBond public immutable bond;
    WorkClaim public immutable workClaim;
    AguBuffer public immutable buffer;
    AguLab public immutable lab;

    address public immutable aguIssuer;
    address public immutable participant;
    address public immutable incomeLedger;
    address public immutable attacker;
    address public immutable donor;
    address[3] internal holders;
    address[2] internal agents;
    bytes32[2] internal classes;

    uint256 internal immutable publisherPk;
    uint256 public immutable rate;
    uint64 public immutable base;
    uint64 public constant WINDOW = 1 days;

    // ---------------------------------------------------------------- ghost record

    uint256 public ghostCreated;
    uint256 public ghostRedeemed;
    mapping(address => uint256) public ghostUnits;
    uint256[] public knownLots;
    mapping(uint256 => bool) public isKnownLot;
    mapping(uint256 => uint256) public ghostLotBalance;
    mapping(uint256 => uint64) public ghostLotWindowTo;
    mapping(uint256 => bool) public ghostRetired;
    uint256 public ghostSeeds;
    uint256 public ghostToBuffer;
    uint256 public ghostCover;
    uint256 public ghostToIncome;
    uint256 public ghostStray;

    // ---------------------------------------------------------------- violations (stay zero)

    uint256 public ghostDilutions;
    uint256 public ghostRollEndedHoldingUsdc;
    uint256 public ghostRedeemMovedUsdc;
    uint256 public ghostBufferMovedOutsideRoll;
    uint256 public ghostBufferRollMismatch;
    uint256 public ghostIncomeDecreased;
    uint256 public ghostSupplyMovedByRoll;
    uint256 public ghostHolderMovedByRoll;
    uint256 public ghostOutsiderUsdcMovedByRoll;
    uint256 public ghostUnauthorisedSucceeded;
    uint256 public ghostUnexpectedRollReverts;
    uint256 public ghostBondDrawnOnExpiry;
    uint256 public ghostReservePresented;
    uint256 public ghostDeliveryMismatch;
    uint256 public ghostBuyerPaidOffPrice;

    // ---------------------------------------------------------------- coverage

    uint256 public ghostCreates;
    uint256 public ghostRedeems;
    uint256 public ghostRolls;
    uint256 public ghostRollsNavFell;
    uint256 public ghostRollsWithCover;
    uint256 public ghostRollsWithCarry;
    uint256 public ghostDonations;
    uint256 public ghostExpiries;
    uint256 public ghostTransfers;
    uint256 public ghostRejectedOutsiders;

    struct Roll {
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
    }

    constructor(
        MockUSDC usdc_,
        CapacityBond bond_,
        WorkClaim workClaim_,
        AguBuffer buffer_,
        AguLab lab_,
        address[3] memory holders_,
        address[2] memory agents_,
        bytes32[2] memory classes_,
        uint256 publisherPk_,
        uint256 rate_,
        uint64 base_
    ) {
        usdc = usdc_;
        bond = bond_;
        workClaim = workClaim_;
        buffer = buffer_;
        lab = lab_;
        aguIssuer = lab_.aguIssuer();
        participant = lab_.participant();
        incomeLedger = lab_.incomeLedger();
        attacker = makeAddr("handlerAttacker");
        donor = makeAddr("handlerDonor");
        holders = holders_;
        agents = agents_;
        classes = classes_;
        publisherPk = publisherPk_;
        rate = rate_;
        base = base_;
        ghostSeeds = usdc_.balanceOf(address(buffer_));

        for (uint256 i = 0; i < agents_.length; i++) {
            vm.prank(agents_[i]);
            usdc_.approve(address(lab_), type(uint256).max);
        }
        vm.prank(attacker);
        usdc_.approve(address(workClaim_), type(uint256).max);
    }

    // ================================================================ actions

    function create(uint256 classSeed, uint256 faceSeed, uint256 aheadSeed) external {
        // Up to 20 SIU a lot, so a roll's replacement can outrun the buffer and NAV can fall.
        uint256 face = bound(faceSeed, 1, 20_000);
        uint256 k = _currentWindow() + 1 + (aheadSeed % 2);
        uint256 lot = _mintClaims(participant, classes[classSeed % 2], face, k);

        uint256 face0 = lab.liveFaceMilli();
        uint256 supply0 = lab.totalSupply();
        (uint256 labUsdc, uint256 bufferUsdc, uint256 incomeUsdc) = _dollars();

        vm.prank(participant);
        try lab.create(lot, face) returns (uint256 units) {
            ghostCreates++;
            ghostCreated += units;
            ghostUnits[participant] += units;
            _track(lot, _windowTo(k));
            ghostLotBalance[lot] += face;
            if (supply0 > 0 && lab.liveFaceMilli() * supply0 < face0 * lab.totalSupply()) {
                ghostDilutions++;
            }
        } catch {
            // NoLiveFace (units outstanding, no live face) or ZeroUnits: the claims stay with the
            // participant, nothing else moves.
        }
        _noDollarMoved(labUsdc, bufferUsdc, incomeUsdc);
    }

    function transferUnits(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external {
        address from = _unitHolder(fromSeed);
        address to = _unitHolder(toSeed);
        uint256 amount = bound(amountSeed, 0, lab.balanceOf(from));
        vm.prank(from);
        lab.transfer(to, amount);
        ghostUnits[from] -= amount;
        ghostUnits[to] += amount;
        ghostTransfers++;
    }

    /// The state a call is checked against, taken just before it.
    struct Before {
        uint256 face;
        uint256 supply;
        uint256 labUsdc;
        uint256 bufferUsdc;
        uint256 incomeUsdc;
        uint256 actorUsdc;
    }

    function _before(address actor) internal view returns (Before memory b) {
        b.face = lab.liveFaceMilli();
        b.supply = lab.totalSupply();
        (b.labUsdc, b.bufferUsdc, b.incomeUsdc) = _dollars();
        b.actorUsdc = usdc.balanceOf(actor);
    }

    function redeem(uint256 holderSeed, uint256 unitsSeed) external {
        address who = _unitHolder(holderSeed);
        uint256 balance = lab.balanceOf(who);
        if (balance == 0) return;
        uint256 units = bound(unitsSeed, 1, balance);
        (, uint256[] memory preview,) = lab.previewRedeem(units);
        if (preview.length == 0) return;

        Before memory b = _before(who);
        uint256[] memory claimsBefore = _claimsOf(who);

        vm.prank(who);
        (uint256[] memory ids, uint256[] memory amounts) = lab.redeem(units);
        ghostRedeems++;
        ghostRedeemed += units;
        ghostUnits[who] -= units;
        for (uint256 i = 0; i < ids.length; i++) {
            ghostLotBalance[ids[i]] -= amounts[i];
        }
        _checkDelivery(who, claimsBefore, ids, amounts);
        _checkRedeemMovedNoDollar(who, b);
    }

    function _claimsOf(address who) internal view returns (uint256[] memory held) {
        held = new uint256[](knownLots.length);
        for (uint256 i = 0; i < knownLots.length; i++) {
            held[i] = workClaim.balanceOf(who, knownLots[i]);
        }
    }

    function _checkDelivery(
        address who,
        uint256[] memory claimsBefore,
        uint256[] memory ids,
        uint256[] memory amounts
    ) internal {
        for (uint256 i = 0; i < claimsBefore.length; i++) {
            uint256 got = workClaim.balanceOf(who, knownLots[i]) - claimsBefore[i];
            if (got != _amountFor(ids, amounts, knownLots[i])) ghostDeliveryMismatch++;
        }
    }

    function _checkRedeemMovedNoDollar(address who, Before memory b) internal {
        uint256 supply1 = lab.totalSupply();
        if (supply1 > 0 && lab.liveFaceMilli() * b.supply < b.face * supply1) ghostDilutions++;
        if (usdc.balanceOf(who) != b.actorUsdc) ghostRedeemMovedUsdc++;
        if (usdc.balanceOf(address(lab)) != b.labUsdc) ghostRedeemMovedUsdc++;
        if (usdc.balanceOf(address(buffer)) != b.bufferUsdc) ghostBufferMovedOutsideRoll++;
        if (usdc.balanceOf(incomeLedger) < b.incomeUsdc) ghostIncomeDecreased++;
    }

    function roll(uint256 saleBpsSeed, uint256 agentSeed, uint256 classSeed) external {
        address buyer = agents[agentSeed % 2];
        address idle = agents[1 - (agentSeed % 2)];
        if (usdc.balanceOf(buyer) < 1e9) usdc.mint(buyer, 1e10);
        AguLab.RollOrder memory order =
            _planRoll(buyer, bound(saleBpsSeed, 0, 10_000), classes[classSeed % 2]);

        Before memory b = _before(buyer);
        address[6] memory who = _outsiders(idle);
        uint256[6] memory outsiders;
        for (uint256 i = 0; i < who.length; i++) {
            outsiders[i] = usdc.balanceOf(who[i]);
        }
        uint256[4] memory units = _unitBalances();

        (bool ok, Vm.Log[] memory logs) = _sendRoll(order);
        if (!ok) {
            ghostUnexpectedRollReverts++;
            return;
        }
        Roll memory r = _rolled(logs);
        ghostRolls++;
        if (r.cover > 0) ghostRollsWithCover++;
        if (r.toBuffer + r.toIncome > 0) ghostRollsWithCarry++;
        if (r.faceBought < r.faceSold + r.faceUnsold) ghostRollsNavFell++;

        _checkRollMoves(buyer, r, b, who, outsiders, units);
        ghostToBuffer += r.toBuffer;
        ghostCover += r.cover;
        ghostToIncome += r.toIncome;
        ghostStray = 0;
        _recordRollClaims(order, logs);
    }

    function _sendRoll(AguLab.RollOrder memory order)
        internal
        returns (bool ok, Vm.Log[] memory logs)
    {
        RateAttestationVerifier.RateAttestation memory att = _att();
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        vm.recordLogs();
        vm.prank(aguIssuer);
        try lab.roll(order, att, labSig, claimSig) {
            ok = true;
        } catch {}
        logs = vm.getRecordedLogs();
    }

    /// The ledger moves the roll is allowed to make, and nothing else.
    function _checkRollMoves(
        address buyer,
        Roll memory r,
        Before memory b,
        address[6] memory who,
        uint256[6] memory outsiders,
        uint256[4] memory units
    ) internal {
        if (usdc.balanceOf(address(lab)) != 0) ghostRollEndedHoldingUsdc++;
        if (r.stray != b.labUsdc) ghostRollEndedHoldingUsdc++;
        if (usdc.balanceOf(address(buffer)) + r.cover != b.bufferUsdc + r.toBuffer) {
            ghostBufferRollMismatch++;
        }
        if (usdc.balanceOf(incomeLedger) != b.incomeUsdc + r.toIncome) ghostIncomeDecreased++;
        if (b.actorUsdc - usdc.balanceOf(buyer) != r.proceeds) ghostBuyerPaidOffPrice++;
        if (lab.totalSupply() != b.supply) ghostSupplyMovedByRoll++;
        for (uint256 i = 0; i < who.length; i++) {
            if (usdc.balanceOf(who[i]) != outsiders[i]) ghostOutsiderUsdcMovedByRoll++;
        }
        uint256[4] memory unitsAfter = _unitBalances();
        for (uint256 i = 0; i < 4; i++) {
            if (unitsAfter[i] != units[i]) ghostHolderMovedByRoll++;
        }
    }

    function donate(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 10_000);
        usdc.mint(donor, amount);
        vm.prank(donor);
        usdc.transfer(address(lab), amount);
        ghostStray += amount;
        ghostDonations++;
    }

    function seedBuffer(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 20_000);
        usdc.mint(address(this), amount);
        usdc.approve(address(buffer), amount);
        buffer.seed(amount);
        ghostSeeds += amount;
    }

    function warp(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1 hours, 20 hours));
    }

    /// The expiry of a lot the reserve still holds after its window closed: never presented,
    /// so Expired, and the issuer's bond is never drawn.
    function settleExpired(uint256 lotSeed) external {
        if (knownLots.length == 0) return;
        uint256 lot = knownLots[lotSeed % knownLots.length];
        if (ghostLotWindowTo[lot] > block.timestamp) return;
        if (workClaim.balanceOf(address(lab), lot) == 0) return;
        (address issuer, bytes32 classId,,,,,) = workClaim.claimTypes(lot);
        (,, uint256 bonded,,) = bond.lots(issuer, classId);
        if (workClaim.everPresented(lot, address(lab))) ghostReservePresented++;

        RateAttestationVerifier.RateAttestation memory empty;
        workClaim.settleWindowClose(lot, address(lab), empty, "");
        ghostLotBalance[lot] = 0;
        ghostExpiries++;
        (,, uint256 bondedAfter,,) = bond.lots(issuer, classId);
        if (bondedAfter != bonded) ghostBondDrawnOnExpiry++;
    }

    // ---------------------------------------------------------------- outsiders

    function attackerCover(uint256 amountSeed) external {
        vm.prank(attacker);
        try buffer.cover(bound(amountSeed, 1, 1e9)) {
            ghostUnauthorisedSucceeded++;
        } catch {
            ghostRejectedOutsiders++;
        }
    }

    function attackerCreate(uint256 faceSeed) external {
        uint256 face = bound(faceSeed, 1, 1_000);
        usdc.mint(attacker, 1e9);
        uint256 lot = _mintClaims(attacker, classes[0], face, _currentWindow() + 1);
        vm.startPrank(attacker);
        workClaim.setApprovalForAll(address(lab), true);
        try lab.create(lot, face) {
            ghostUnauthorisedSucceeded++;
        } catch {
            ghostRejectedOutsiders++;
        }
        // Pushing the claims in directly is refused too: the reserve accepts only what it pulls.
        try workClaim.safeTransferFrom(attacker, address(lab), lot, face, "") {
            ghostUnauthorisedSucceeded++;
        } catch {
            ghostRejectedOutsiders++;
        }
        vm.stopPrank();
    }

    function attackerRoll() external {
        AguLab.RollOrder memory order;
        order.buyFrom = _windowFrom(_currentWindow() + 1);
        order.buyTo = _windowTo(_currentWindow() + 1);
        RateAttestationVerifier.RateAttestation memory att = _att();
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        vm.prank(attacker);
        try lab.roll(order, att, labSig, claimSig) {
            ghostUnauthorisedSucceeded++;
        } catch {
            ghostRejectedOutsiders++;
        }
    }

    // ================================================================ views for the invariants

    function knownLotCount() external view returns (uint256) {
        return knownLots.length;
    }

    function unitHolders() external view returns (address[4] memory) {
        return [participant, holders[0], holders[1], holders[2]];
    }

    function agentList() external view returns (address[2] memory) {
        return agents;
    }

    // ================================================================ internals

    function _currentWindow() internal view returns (uint256) {
        return (block.timestamp - base) / WINDOW;
    }

    function _windowFrom(uint256 k) internal view returns (uint64) {
        return base + uint64(k) * WINDOW;
    }

    function _windowTo(uint256 k) internal view returns (uint64) {
        return base + uint64(k + 1) * WINDOW;
    }

    function _unitHolder(uint256 seed) internal view returns (address) {
        uint256 i = seed % 4;
        return i == 0 ? participant : holders[i - 1];
    }

    function _unitBalances() internal view returns (uint256[4] memory b) {
        b[0] = lab.balanceOf(participant);
        for (uint256 i = 0; i < 3; i++) {
            b[i + 1] = lab.balanceOf(holders[i]);
        }
    }

    /// Everyone whose USDC a roll must never touch: the participant, the idle agent, the
    /// holders and the attacker (the buyer, the buffer and the income ledger are checked
    /// against the roll's own figures).
    function _outsiders(address idle) internal view returns (address[6] memory) {
        return [participant, idle, holders[0], holders[1], holders[2], attacker];
    }

    function _dollars() internal view returns (uint256, uint256, uint256) {
        return (
            usdc.balanceOf(address(lab)),
            usdc.balanceOf(address(buffer)),
            usdc.balanceOf(incomeLedger)
        );
    }

    function _noDollarMoved(uint256 labUsdc, uint256 bufferUsdc, uint256 incomeUsdc) internal {
        if (usdc.balanceOf(address(lab)) != labUsdc) ghostRedeemMovedUsdc++;
        if (usdc.balanceOf(address(buffer)) != bufferUsdc) ghostBufferMovedOutsideRoll++;
        if (usdc.balanceOf(incomeLedger) < incomeUsdc) ghostIncomeDecreased++;
    }

    function _track(uint256 lot, uint64 windowTo) internal {
        if (!isKnownLot[lot]) {
            isKnownLot[lot] = true;
            knownLots.push(lot);
            ghostLotWindowTo[lot] = windowTo;
        }
    }

    function _amountFor(uint256[] memory ids, uint256[] memory amounts, uint256 lot)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == lot) return amounts[i];
        }
        return 0;
    }

    function _mintClaims(address buyer, bytes32 classId, uint256 q, uint256 k)
        internal
        returns (uint256 lot)
    {
        if (usdc.balanceOf(buyer) < 1e9) usdc.mint(buyer, 1e10);
        RateAttestationVerifier.RateAttestation memory att = _att();
        bytes memory sig = _sign(address(workClaim), att);
        uint64 from = _windowFrom(k);
        uint64 to = _windowTo(k);
        vm.prank(buyer);
        lot = workClaim.mint(classId, att.series, q, from, to, att, sig);
    }

    function _att() internal view returns (RateAttestationVerifier.RateAttestation memory) {
        uint64 nowTs = uint64(block.timestamp);
        return RateAttestationVerifier.RateAttestation({
            printId: "illustrative-cr-commodity",
            series: keccak256("commodity"),
            printDate: nowTs - (nowTs % 1 days),
            nanoUsdPerSiu: rate,
            validUntil: nowTs + 365 days
        });
    }

    function _sign(address verifier, RateAttestationVerifier.RateAttestation memory att)
        internal
        view
        returns (bytes memory)
    {
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
        bytes32 domain = RateAttestationVerifier(verifier).rateAttestationDomainSeparator();
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(publisherPk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _cost(uint256 q) internal view returns (uint256) {
        return (q * rate) / 1_000_000;
    }

    function _salePrice(uint256 q) internal view returns (uint256) {
        return (q * ((rate * (10_000 - lab.discountBps())) / 10_000)) / 1_000_000;
    }

    /// Same plan as AguLabFixture._planRoll: retire every front lot, sell `saleBps` of each,
    /// and buy back the full face when the money is there, otherwise the most it can.
    function _planRoll(address buyer, uint256 saleBps, bytes32 buyClass)
        internal
        view
        returns (AguLab.RollOrder memory order)
    {
        order.frontLots = _frontLots();
        uint256 required;
        uint256 proceeds;
        (order.sales, required, proceeds) = _sales(order.frontLots, buyer, saleBps);

        uint256 avail = usdc.balanceOf(address(lab)) + proceeds + usdc.balanceOf(address(buffer));
        uint256 buyQ = required;
        if (_cost(buyQ) > avail) buyQ = ((avail + 1) * 1_000_000 - 1) / rate;
        if (buyQ > 0) {
            order.buys = new AguLab.Buy[](1);
            order.buys[0] = AguLab.Buy({classId: buyClass, quantityMilli: buyQ});
        }
        uint256 next = _currentWindow() + 1;
        order.buyFrom = _windowFrom(next);
        order.buyTo = _windowTo(next);
    }

    function _frontLots() internal view returns (uint256[] memory front) {
        uint256[] memory ids = lab.lotIds();
        front = new uint256[](ids.length);
        uint256 n;
        for (uint256 i = 0; i < ids.length; i++) {
            (, bool retired, uint64 wFrom, uint64 wTo,) = lab.lots(ids[i]);
            if (!retired && wFrom <= block.timestamp && block.timestamp < wTo) front[n++] = ids[i];
        }
        assembly {
            mstore(front, n)
        }
    }

    function _sales(uint256[] memory front, address buyer, uint256 saleBps)
        internal
        view
        returns (AguLab.Sale[] memory sales, uint256 required, uint256 proceeds)
    {
        sales = new AguLab.Sale[](front.length);
        uint256 n;
        for (uint256 i = 0; i < front.length; i++) {
            uint256 bal = lab.reserveBalance(front[i]);
            required += bal;
            uint256 q = (bal * saleBps) / 10_000;
            if (q > 0 && _salePrice(q) > 0) {
                sales[n++] = AguLab.Sale({buyer: buyer, tokenId: front[i], quantityMilli: q});
                proceeds += _salePrice(q);
            }
        }
        assembly {
            mstore(sales, n)
        }
    }

    function _rolled(Vm.Log[] memory logs) internal view returns (Roll memory r) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(lab) && logs[i].topics[0] == AguLab.Rolled.selector) {
                r = abi.decode(logs[i].data, (Roll));
            }
        }
    }

    function _recordRollClaims(AguLab.RollOrder memory order, Vm.Log[] memory logs) internal {
        for (uint256 i = 0; i < order.frontLots.length; i++) {
            ghostRetired[order.frontLots[i]] = true;
        }
        for (uint256 i = 0; i < order.sales.length; i++) {
            ghostLotBalance[order.sales[i].tokenId] -= order.sales[i].quantityMilli;
        }
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(lab)
                    && logs[i].topics[0] == AguLab.NextClaimBought.selector
            ) {
                uint256 lot = uint256(logs[i].topics[2]);
                (, uint256 q,) = abi.decode(logs[i].data, (bytes32, uint256, uint256));
                _track(lot, order.buyTo);
                ghostLotBalance[lot] += q;
            }
        }
    }
}
