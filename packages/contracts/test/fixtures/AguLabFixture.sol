// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../../src/CapacityBond.sol";
import {ClaimRouter} from "../../src/ClaimRouter.sol";
import {EligibleClaimRouter} from "../../src/EligibleClaimRouter.sol";
import {WorkClaim, ITouchstoneEscrow} from "../../src/WorkClaim.sol";
import {TouchstoneEscrow} from "../../src/TouchstoneEscrow.sol";
import {RateAttestationVerifier} from "../../src/RateAttestationVerifier.sol";
import {AguBuffer} from "../../src/AguBuffer.sol";
import {AguLab} from "../../src/AguLab.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/**
 * The CR economy's contracts wired the way `script/DeployCrEconomy.s.sol` wires them, for the
 * AGU-lab tests (docs/part5-build-plan.md §5). Every party the plan separates (§4.2) has its own
 * address here, so a test can assert that a balance which must never move did not move.
 *
 * Numbers marked _illustrative_ are placeholders for tests, as the plan's §3.5 requires; the real
 * ones live in the committed parameters file, never here. The one exception is `RATE`, which is
 * the real 2026-09-22 Commodity dated_siu ($0.0107/SIU) that WorkClaim.t.sol already uses, chosen
 * for the same reason: a real magnitude exercises the truncation in `floor(q × rate / 1e6)` the
 * way a round number would not.
 */
abstract contract AguLabFixture is Test {
    MockUSDC internal usdc;
    TouchstoneEscrow internal claimEscrow;
    CapacityBond internal bond;
    EligibleClaimRouter internal router;
    WorkClaim internal workClaim;
    AguBuffer internal buffer;
    AguLab internal lab;

    /// The lab key: signs rate attestations and sets the router's flags. Test-only.
    uint256 internal constant PUBLISHER_PK = 0xC0FFEE;
    address internal publisher = vm.addr(PUBLISHER_PK);

    address internal aguIssuer = makeAddr("aguIssuer");
    address internal participant = makeAddr("participant");
    address internal incomeLedger = makeAddr("incomeLedger");
    address internal escrowTreasury = makeAddr("escrowTreasury");
    /// Registered with CapacityBond first, so the unchanged first-fit ClaimRouter picks it first.
    address internal issuerA = makeAddr("issuerA");
    address internal issuerB = makeAddr("issuerB");
    /// Agents: the front-claim buyers in a roll, and holders of AGU-lab.
    address internal agent1 = makeAddr("agent1");
    address internal agent2 = makeAddr("agent2");
    address internal holder = makeAddr("holder");
    address internal stranger = makeAddr("stranger");

    /// Commodity task classes. Both fixture issuers are Commodity issuers with lots in these
    /// classes only, as in the CR deployment, where the Frontier issuer holds CR-VS lots only:
    /// WorkClaim routes by class and takes the series from the minter, so that separation is
    /// what keeps a "commodity" claim off a Frontier issuer (AguLab's note on grade labels).
    bytes32 internal constant CLASS_SM = keccak256("CR-SM");
    bytes32 internal constant CLASS_PL = keccak256("CR-PL");
    /// Cached as constants rather than read from `workClaim.SERIES_*()` between a `vm.prank` and
    /// the pranked call: an external call there consumes the prank (WorkClaim.t.sol's
    /// `fixtureSeries` note records the same trap).
    bytes32 internal constant SERIES_COMMODITY = keccak256("commodity");
    bytes32 internal constant SERIES_FRONTIER = keccak256("frontier");

    uint256 internal constant RATE = 10_700_000; // nano-USD per SIU (see the contract note above)
    uint16 internal constant DISCOUNT_BPS = 500; // illustrative
    uint64 internal constant MIN_TENOR = 6 hours; // illustrative
    uint256 internal constant BUFFER_TARGET = 50_000; // illustrative, USDC base units
    uint256 internal constant BUFFER_SEED = 20_000; // illustrative, USDC base units
    uint64 internal constant WINDOW = 1 days; // illustrative

    /// 00:00 UTC on a day in the trial's calendar; window k is [BASE + k days, BASE + (k+1) days).
    uint64 internal constant BASE = 1_793_059_200;

    uint16 internal discountBps;

    /// Mirrors `AguLab.Rolled`'s data fields in order, so a recorded log decodes straight into it.
    struct RollSummary {
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

    function setUp() public virtual {
        vm.warp(BASE);
        _deploy(new MockUSDC(), DISCOUNT_BPS, BUFFER_TARGET);
        _fund();
    }

    // ------------------------------------------------------------------ deployment

    function _deploy(MockUSDC token, uint16 discountBps_, uint256 target) internal {
        usdc = token;
        discountBps = discountBps_;
        claimEscrow = new TouchstoneEscrow(IERC20(address(usdc)), escrowTreasury, 0);

        // WorkClaim's and AguLab's addresses are predicted from this deployer's nonce, so the
        // contracts that must name them immutably (CapacityBond, AguBuffer) can do so without a
        // setter: the same pattern as DeployGateMarket.s.sol.
        uint64 nonce = vm.getNonce(address(this));
        address predictedClaim = vm.computeCreateAddress(address(this), nonce + 2);
        bond = new CapacityBond(IERC20(address(usdc)), predictedClaim);
        router = new EligibleClaimRouter(bond, publisher);
        workClaim = new WorkClaim(
            IERC20(address(usdc)),
            bond,
            ClaimRouter(address(router)),
            publisher,
            ITouchstoneEscrow(address(claimEscrow))
        );
        require(address(workClaim) == predictedClaim, "sanity: WorkClaim address prediction");

        address predictedLab =
            vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        buffer = new AguBuffer(IERC20(address(usdc)), predictedLab, target);
        lab = new AguLab(
            workClaim,
            buffer,
            aguIssuer,
            participant,
            incomeLedger,
            SERIES_COMMODITY,
            MIN_TENOR,
            discountBps_
        );
        require(address(lab) == predictedLab, "sanity: AguLab address prediction");
    }

    function _fund() internal {
        address[2] memory issuers = [issuerA, issuerB];
        for (uint256 i = 0; i < issuers.length; i++) {
            usdc.mint(issuers[i], 1e12);
            vm.startPrank(issuers[i]);
            usdc.approve(address(bond), type(uint256).max);
            // 10,000 h × 1,000 mSIU/h × 0.5 = 5,000,000 mSIU of headroom per class (illustrative).
            bond.createLot(CLASS_SM, 10_000, 1_000, 1e9);
            bond.createLot(CLASS_PL, 10_000, 1_000, 1e9);
            vm.stopPrank();
        }

        usdc.mint(participant, 1e12);
        vm.startPrank(participant);
        usdc.approve(address(workClaim), type(uint256).max);
        workClaim.setApprovalForAll(address(lab), true);
        vm.stopPrank();

        address[3] memory buyers = [agent1, agent2, holder];
        for (uint256 i = 0; i < buyers.length; i++) {
            usdc.mint(buyers[i], 1e12);
            vm.startPrank(buyers[i]);
            usdc.approve(address(lab), type(uint256).max);
            usdc.approve(address(workClaim), type(uint256).max);
            vm.stopPrank();
        }

        _seedBuffer(BUFFER_SEED);
    }

    function _seedBuffer(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(buffer), amount);
        buffer.seed(amount);
    }

    // ------------------------------------------------------------------ windows and rates

    function _windowFrom(uint256 k) internal pure returns (uint64) {
        return BASE + uint64(k) * WINDOW;
    }

    function _windowTo(uint256 k) internal pure returns (uint64) {
        return BASE + uint64(k + 1) * WINDOW;
    }

    function _att(uint256 rate, bytes32 series)
        internal
        view
        returns (RateAttestationVerifier.RateAttestation memory)
    {
        uint64 nowTs = uint64(block.timestamp);
        return RateAttestationVerifier.RateAttestation({
            printId: "illustrative-cr-commodity",
            series: series,
            printDate: nowTs - (nowTs % 1 days),
            nanoUsdPerSiu: rate,
            validUntil: nowTs + 365 days
        });
    }

    /// Signs `att` for one verifying contract. AguLab and WorkClaim each verify against their own
    /// EIP-712 domain (RateAttestationVerifier binds `verifyingContract`), so a roll carries the
    /// same attestation signed twice. The domain is read from the contract itself, never
    /// recomputed here, so this cannot drift from what the contract checks.
    function _sign(address verifier, RateAttestationVerifier.RateAttestation memory att)
        internal
        view
        returns (bytes memory)
    {
        return _signAs(PUBLISHER_PK, verifier, att);
    }

    function _signAs(
        uint256 pk,
        address verifier,
        RateAttestationVerifier.RateAttestation memory att
    ) internal view returns (bytes memory) {
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
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// WorkClaim's own price for `q` mSIU: `floor(q × rate / 1e6)` USDC base units.
    function _cost(uint256 q) internal pure returns (uint256) {
        return (q * RATE) / 1_000_000;
    }

    /// The roll's posted price for `q` mSIU of a front claim, computed the way AguLab does.
    function _salePrice(uint256 q) internal view returns (uint256) {
        uint256 price = (RATE * (10_000 - discountBps)) / 10_000;
        return (q * price) / 1_000_000;
    }

    // ------------------------------------------------------------------ claims and creation

    /// `buyer` mints `q` mSIU of a Commodity claim in `classId` for window `k`, routed by the
    /// eligibility router, paying the issuer at RATE.
    function _buyClaims(address buyer, bytes32 classId, uint256 q, uint256 k)
        internal
        returns (uint256 tokenId)
    {
        return _buyClaimsOfSeries(buyer, classId, SERIES_COMMODITY, q, k);
    }

    function _buyClaimsOfSeries(
        address buyer,
        bytes32 classId,
        bytes32 series,
        uint256 q,
        uint256 k
    ) internal returns (uint256 tokenId) {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, series);
        bytes memory sig = _sign(address(workClaim), att);
        uint64 from = _windowFrom(k);
        uint64 to = _windowTo(k);
        vm.prank(buyer);
        tokenId = workClaim.mint(classId, series, q, from, to, att, sig);
    }

    function _create(uint256 tokenId, uint256 face) internal returns (uint256 units) {
        vm.prank(participant);
        units = lab.create(tokenId, face);
    }

    /// The participant buys `face` mSIU of window `k` in `classId` and delivers all of it.
    function _createFresh(bytes32 classId, uint256 face, uint256 k)
        internal
        returns (uint256 tokenId, uint256 units)
    {
        tokenId = _buyClaims(participant, classId, face, k);
        units = _create(tokenId, face);
    }

    function _giveUnits(address to, uint256 units) internal {
        vm.prank(participant);
        lab.transfer(to, units);
    }

    // ------------------------------------------------------------------ the roll

    function _order(
        uint256[] memory front,
        AguLab.Sale[] memory sales,
        AguLab.Buy[] memory buys,
        uint256 k
    ) internal pure returns (AguLab.RollOrder memory order) {
        order.frontLots = front;
        order.sales = sales;
        order.buys = buys;
        order.buyFrom = _windowFrom(k);
        order.buyTo = _windowTo(k);
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }

    function _noIds() internal pure returns (uint256[] memory) {
        return new uint256[](0);
    }

    function _sale(address buyer, uint256 tokenId, uint256 q)
        internal
        pure
        returns (AguLab.Sale[] memory sales)
    {
        sales = new AguLab.Sale[](1);
        sales[0] = AguLab.Sale({buyer: buyer, tokenId: tokenId, quantityMilli: q});
    }

    function _noSales() internal pure returns (AguLab.Sale[] memory) {
        return new AguLab.Sale[](0);
    }

    function _buy(bytes32 classId, uint256 q) internal pure returns (AguLab.Buy[] memory buys) {
        buys = new AguLab.Buy[](1);
        buys[0] = AguLab.Buy({classId: classId, quantityMilli: q});
    }

    function _noBuys() internal pure returns (AguLab.Buy[] memory) {
        return new AguLab.Buy[](0);
    }

    /// Runs `order` as the AGU-lab issuer with a Commodity attestation at RATE, and returns the
    /// `Rolled` summary the contract emitted.
    function _roll(AguLab.RollOrder memory order) internal returns (RollSummary memory summary) {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        vm.recordLogs();
        vm.prank(aguIssuer);
        lab.roll(order, att, labSig, claimSig);
        summary = _rolledFrom(vm.getRecordedLogs());
    }

    /// Expects `order` to revert with exactly `err` when the AGU-lab issuer sends it.
    function _rollExpectRevert(AguLab.RollOrder memory order, bytes memory err) internal {
        RateAttestationVerifier.RateAttestation memory att = _att(RATE, SERIES_COMMODITY);
        bytes memory labSig = _sign(address(lab), att);
        bytes memory claimSig = _sign(address(workClaim), att);
        vm.expectRevert(err);
        vm.prank(aguIssuer);
        lab.roll(order, att, labSig, claimSig);
    }

    function _rolledFrom(Vm.Log[] memory logs) internal view returns (RollSummary memory s) {
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(lab) && logs[i].topics[0] == AguLab.Rolled.selector) {
                s = abi.decode(logs[i].data, (RollSummary));
                found = true;
            }
        }
        require(found, "no Rolled event in the recorded logs");
    }

    /// The order the AGU-lab issuer's harness would send: retire every front lot the reserve
    /// holds, sell `saleBps` of each to `buyer`, and buy the replacement face in `buyClass` for
    /// window `k`: all of it when the proceeds, stray USDC and the buffer can pay, otherwise the
    /// most face they can (R6).
    function _planRoll(address buyer, uint256 saleBps, bytes32 buyClass, uint256 k)
        internal
        view
        returns (AguLab.RollOrder memory order)
    {
        uint256[] memory front = _frontLots();
        AguLab.Sale[] memory sales = new AguLab.Sale[](front.length);
        uint256 required;
        uint256 proceeds;
        uint256 nSales;
        for (uint256 i = 0; i < front.length; i++) {
            uint256 bal = lab.reserveBalance(front[i]);
            required += bal;
            uint256 q = (bal * saleBps) / 10_000;
            if (q > 0 && _salePrice(q) > 0) {
                sales[nSales++] = AguLab.Sale({buyer: buyer, tokenId: front[i], quantityMilli: q});
                proceeds += _salePrice(q);
            }
        }
        assembly {
            mstore(sales, nSales)
        }

        uint256 avail = usdc.balanceOf(address(lab)) + proceeds + usdc.balanceOf(address(buffer));
        uint256 buyQ = required;
        if (_cost(buyQ) > avail) buyQ = ((avail + 1) * 1_000_000 - 1) / RATE;
        order = _order(front, sales, buyQ > 0 ? _buy(buyClass, buyQ) : _noBuys(), k);
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

    // ------------------------------------------------------------------ value per unit

    /// True when `face1 / supply1 >= face0 / supply0`, by cross-multiplication (no division,
    /// so no rounding enters the comparison itself).
    function _perUnitNotBelow(uint256 face1, uint256 supply1, uint256 face0, uint256 supply0)
        internal
        pure
        returns (bool)
    {
        return face1 * supply0 >= face0 * supply1;
    }
}
