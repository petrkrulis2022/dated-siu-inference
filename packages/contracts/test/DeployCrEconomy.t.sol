// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {DeployCrEconomy} from "../script/DeployCrEconomy.s.sol";
import {AguLab} from "../src/AguLab.sol";
import {RateAttestationVerifier} from "../src/RateAttestationVerifier.sol";

/**
 * The CR economy's deployment (docs/part5-build-plan.md §5, "DeployCrEconomy.t.sol"): the chain
 * guard, the refusal of the print's publisher, every cross-reference the script wires, and the
 * plan's local smoke run. A Frontier issuer bonds CR-VS only and a Commodity issuer bonds CR-PL
 * (the class split that keeps Commodity claims off the Frontier issuer, since WorkClaim takes a
 * claim's series from its minter); the participant buys Commodity claims and creates AGU-lab, an
 * agent pays through the AGU-lab escrow and the gate-runner settles it, a holder redeems in kind,
 * and a roll runs, all against the script's own deployment.
 *
 * Every number here is illustrative except RATE, the real 2026-09-22 Commodity dated_siu the
 * other claims tests use.
 */
contract DeployCrEconomyTest is Test {
    using stdJson for string;

    DeployCrEconomy internal script;

    uint256 internal constant LAB_PK = 0x1AB;
    address internal labKey = vm.addr(LAB_PK);
    address internal aguIssuer = makeAddr("aguIssuer");
    address internal participant = makeAddr("participant");
    address internal incomeLedger = makeAddr("incomeLedger");

    /// The CR deployment's class split: the Frontier issuer bonds CR-VS only; the Commodity
    /// issuers bond CR-PL (and CR-SM, CR-UO). See AguLab.sol's note on grade labels.
    bytes32 internal constant CLASS_VS = keccak256("CR-VS");
    bytes32 internal constant CLASS_PL = keccak256("CR-PL");
    bytes32 internal constant SERIES_COMMODITY = keccak256("commodity");
    uint256 internal constant RATE = 10_700_000;
    uint64 internal constant BASE = 1_793_059_200;

    function setUp() public {
        script = new DeployCrEconomy();
        vm.setEnv("CR_LAB_PUBLISHER_ADDRESS", vm.toString(labKey));
        vm.setEnv("CR_AGU_ISSUER_ADDRESS", vm.toString(aguIssuer));
        vm.setEnv("CR_AGU_PARTICIPANT_ADDRESS", vm.toString(participant));
        vm.setEnv("CR_AGU_INCOME_LEDGER_ADDRESS", vm.toString(incomeLedger));
        vm.setEnv("CR_AGU_BUFFER_TARGET", "50000"); // illustrative
        vm.setEnv("CR_AGU_MIN_TENOR_SECONDS", "21600"); // illustrative
        vm.setEnv("CR_AGU_ROLL_DISCOUNT_BPS", "500"); // illustrative
        vm.warp(BASE);
    }

    // ------------------------------------------------------------------ guards

    function test_run_revertsOnEveryOtherChain() public {
        uint256[3] memory chains = [uint256(1), 8453, 5042002]; // Ethereum, Base, Arc Testnet
        for (uint256 i = 0; i < chains.length; i++) {
            vm.chainId(chains[i]);
            vm.expectRevert(
                bytes(
                    "DeployCrEconomy.s.sol targets anvil (31337) or Base Sepolia (84532) only: the CR economy is testnet-only."
                )
            );
            script.run();
        }
    }

    /// The lab key, never the print's: the print publisher recorded in data/deployments is
    /// refused outright. Through `deployWith`, not the environment: `vm.setEnv` is process-wide
    /// and the other tests in this file read the same variables concurrently.
    function test_run_refusesThePrintPublisher() public {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../../data/deployments/base-sepolia.json")
        );
        address printPublisher =
            json.readAddress(".contracts.TouchstoneAttestation.constructorArgs.publisher_");
        DeployCrEconomy.Config memory c = DeployCrEconomy.Config({
            publisher: printPublisher,
            aguIssuer: aguIssuer,
            participant: participant,
            incomeLedger: incomeLedger,
            escrowTreasury: address(0),
            bufferTarget: 50_000,
            minTenor: 21_600,
            discountBps: 500
        });
        vm.chainId(31337);
        vm.expectRevert(
            bytes(
                "CR_LAB_PUBLISHER_ADDRESS is the print's publisher: the CR economy must use the lab key."
            )
        );
        script.deployWith(c);
        // The same configuration with the lab key goes through.
        c.publisher = labKey;
        assertEq(script.deployWith(c).aguLab.publisher(), labKey);
    }

    function test_run_acceptsBaseSepolia() public {
        vm.chainId(84532);
        DeployCrEconomy.Deployment memory d = script.run();
        assertGt(address(d.aguLab).code.length, 0);
    }

    // ------------------------------------------------------------------ wiring

    function test_run_wiresEveryCrossReference() public {
        vm.chainId(31337);
        DeployCrEconomy.Deployment memory d = script.run();

        assertEq(d.dollar.symbol(), "CRLAB-TUSD", "the test dollar is labelled, never USDC");
        assertTrue(d.dollar.isTestDollar());
        assertEq(d.dollar.decimals(), 6);

        assertEq(address(d.claimEscrow.token()), address(d.dollar));
        assertEq(d.claimEscrow.feeBps(), 0);
        assertEq(d.bond.workClaim(), address(d.workClaim));
        assertEq(address(d.bond.usdc()), address(d.dollar));
        assertEq(address(d.router.bond()), address(d.bond));
        assertEq(address(d.workClaim.router()), address(d.router), "ALL mints use R11's router");
        assertEq(address(d.workClaim.escrow()), address(d.claimEscrow));
        assertEq(address(d.workClaim.usdc()), address(d.dollar));

        assertEq(d.router.publisher(), labKey, "the router's flags are the lab key's");
        assertEq(d.workClaim.publisher(), labKey, "WorkClaim trusts the lab key");
        assertEq(d.aguLab.publisher(), labKey, "AguLab trusts the same lab key");

        assertEq(d.buffer.aguLab(), address(d.aguLab));
        assertEq(address(d.buffer.usdc()), address(d.dollar));
        assertEq(d.buffer.target(), 50_000);
        assertEq(address(d.aguLab.workClaim()), address(d.workClaim));
        assertEq(address(d.aguLab.buffer()), address(d.buffer));
        assertEq(d.aguLab.aguIssuer(), aguIssuer);
        assertEq(d.aguLab.participant(), participant);
        assertEq(d.aguLab.incomeLedger(), incomeLedger);
        assertEq(d.aguLab.reserveSeries(), SERIES_COMMODITY, "AGU-lab is Commodity-only");
        assertEq(d.aguLab.minTenor(), 21_600);
        assertEq(d.aguLab.discountBps(), 500);

        assertEq(address(d.aguEscrow.token()), address(d.aguLab));
        assertEq(d.aguEscrow.feeBps(), 0);
    }

    // ------------------------------------------------------------------ the smoke run

    address internal frontierIssuer = makeAddr("frontierIssuer");
    address internal commodityIssuer = makeAddr("commodityIssuer");

    function test_smoke_issuerParticipantEscrowRedemptionAndRoll() public {
        vm.chainId(31337);
        DeployCrEconomy.Deployment memory d = script.run();
        _issuersOpenLots(d);
        uint256 lot = _participantCreates(d);
        _agentPaysAndSellerRedeems(d, lot);
        _rollRuns(d, lot);
    }

    /// The Frontier issuer registers first, with a CR-VS lot only; then a Commodity issuer
    /// opens a CR-PL lot. First-fit would pick the Frontier issuer for any class it bonds.
    function _issuersOpenLots(DeployCrEconomy.Deployment memory d) internal {
        _openLot(d, frontierIssuer, CLASS_VS);
        _openLot(d, commodityIssuer, CLASS_PL);
        assertEq(
            d.bond.issuersForClass(CLASS_PL).length, 1, "only the Commodity issuer bonds CR-PL"
        );
        assertEq(
            d.router.route(CLASS_PL, 1000),
            commodityIssuer,
            "a Commodity CR-PL mint must never route to the Frontier issuer"
        );
        // The limitation this split exists for: WorkClaim takes the series from the minter, so
        // a claim labelled Commodity in CR-VS would go to the Frontier issuer.
        assertEq(d.router.route(CLASS_VS, 1000), frontierIssuer, "CR-VS is the Frontier issuer's");
    }

    /// The participant buys Commodity CR-PL claims and creates AGU-lab against them.
    function _participantCreates(DeployCrEconomy.Deployment memory d)
        internal
        returns (uint256 lot)
    {
        d.dollar.mint(participant, 1e12);
        vm.startPrank(participant);
        d.dollar.approve(address(d.workClaim), type(uint256).max);
        d.workClaim.setApprovalForAll(address(d.aguLab), true);
        vm.stopPrank();
        lot = _mint(d, participant, 1000, BASE + 1 days, BASE + 2 days);
        (address lotIssuer,,,,,,) = d.workClaim.claimTypes(lot);
        assertEq(lotIssuer, commodityIssuer, "the Commodity CR-PL claim is the Commodity issuer's");
        vm.prank(participant);
        assertEq(d.aguLab.create(lot, 1000), 1_000_000);
    }

    /// An agent pays another through the AGU-lab escrow, the gate-runner settles on a pass, and
    /// the seller redeems what it was paid, in kind.
    function _agentPaysAndSellerRedeems(DeployCrEconomy.Deployment memory d, uint256 lot) internal {
        address buyer = makeAddr("researchAgent");
        address seller = makeAddr("dataAgent");
        address gateRunner = makeAddr("gateRunner");
        vm.prank(participant);
        d.aguLab.transfer(buyer, 100_000);
        vm.startPrank(buyer);
        d.aguLab.approve(address(d.aguEscrow), type(uint256).max);
        d.aguEscrow.openAndFund(keccak256("brief"), seller, gateRunner, 50_000, BASE + 1 days);
        vm.stopPrank();
        vm.prank(gateRunner);
        d.aguEscrow.settle(keccak256("brief"), 50_000, keccak256("receipt"));
        assertEq(d.aguLab.balanceOf(seller), 50_000);

        vm.prank(seller);
        d.aguLab.redeem(50_000);
        assertEq(d.workClaim.balanceOf(seller, lot), 50);
    }

    /// A roll: the buffer is seeded, the front lot is retired and partly sold, and next window's
    /// claims are bought through the eligibility router, ending at zero dollars.
    function _rollRuns(DeployCrEconomy.Deployment memory d, uint256 lot) internal {
        address seeder = makeAddr("bufferSeeder");
        d.dollar.mint(seeder, 50_000);
        vm.startPrank(seeder);
        d.dollar.approve(address(d.buffer), 50_000);
        d.buffer.seed(50_000);
        vm.stopPrank();
        address frontBuyer = makeAddr("frontBuyer");
        d.dollar.mint(frontBuyer, 1e9);
        vm.prank(frontBuyer);
        d.dollar.approve(address(d.aguLab), type(uint256).max);

        vm.warp(BASE + 1 days + 1 hours);
        _sendRoll(d, _rollOrder(lot, frontBuyer));

        assertEq(d.dollar.balanceOf(address(d.aguLab)), 0, "the roll ends at zero dollars");
        assertEq(d.workClaim.balanceOf(frontBuyer, lot), 500, "the front buyer got its claims");
        assertEq(d.aguLab.liveFaceMilli(), 950, "the face retired was restored");
        assertEq(d.aguLab.navWad(), 1e18);
        uint256 bought = d.workClaim
            .tokenIdFor(commodityIssuer, CLASS_PL, SERIES_COMMODITY, BASE + 2 days, BASE + 3 days);
        assertEq(d.aguLab.reserveBalance(bought), 950, "the roll bought from the Commodity issuer");
        (,,, uint256 frontierOutstanding,) = d.bond.lots(frontierIssuer, CLASS_VS);
        assertEq(frontierOutstanding, 0, "nothing in the reserve came from the Frontier issuer");
    }

    function _rollOrder(uint256 lot, address frontBuyer)
        internal
        pure
        returns (AguLab.RollOrder memory order)
    {
        order.frontLots = new uint256[](1);
        order.frontLots[0] = lot;
        order.sales = new AguLab.Sale[](1);
        order.sales[0] = AguLab.Sale({buyer: frontBuyer, tokenId: lot, quantityMilli: 500});
        order.buys = new AguLab.Buy[](1);
        order.buys[0] = AguLab.Buy({classId: CLASS_PL, quantityMilli: 950});
        order.buyFrom = BASE + 2 days;
        order.buyTo = BASE + 3 days;
    }

    function _sendRoll(DeployCrEconomy.Deployment memory d, AguLab.RollOrder memory order)
        internal
    {
        RateAttestationVerifier.RateAttestation memory att = _att();
        bytes memory labSig = _sign(address(d.aguLab), att);
        bytes memory claimSig = _sign(address(d.workClaim), att);
        vm.prank(aguIssuer);
        d.aguLab.roll(order, att, labSig, claimSig);
    }

    function _openLot(DeployCrEconomy.Deployment memory d, address who, bytes32 classId) internal {
        d.dollar.mint(who, 1e12);
        vm.startPrank(who);
        d.dollar.approve(address(d.bond), type(uint256).max);
        d.bond.createLot(classId, 10_000, 1_000, 1e9);
        vm.stopPrank();
    }

    function _mint(
        DeployCrEconomy.Deployment memory d,
        address buyer,
        uint256 q,
        uint64 from,
        uint64 to
    ) internal returns (uint256 lot) {
        RateAttestationVerifier.RateAttestation memory att = _att();
        bytes memory sig = _sign(address(d.workClaim), att);
        vm.prank(buyer);
        lot = d.workClaim.mint(CLASS_PL, SERIES_COMMODITY, q, from, to, att, sig);
    }

    function _att() internal view returns (RateAttestationVerifier.RateAttestation memory) {
        uint64 nowTs = uint64(block.timestamp);
        return RateAttestationVerifier.RateAttestation({
            printId: "illustrative-cr-commodity",
            series: SERIES_COMMODITY,
            printDate: nowTs - (nowTs % 1 days),
            nanoUsdPerSiu: RATE,
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
            vm.sign(LAB_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
