// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {EligibleClaimRouter} from "../src/EligibleClaimRouter.sol";
import {WorkClaim, ITouchstoneEscrow} from "../src/WorkClaim.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {AguBuffer} from "../src/AguBuffer.sol";
import {AguLab} from "../src/AguLab.sol";
import {CrLabTestDollar} from "../test/mocks/CrLabTestDollar.sol";

/**
 * The CR economy's contracts (docs/part5-build-plan.md WP2): an internal, testnet-only agent
 * economy, deployed whole and wired once, with nothing to configure afterwards because nothing
 * can be configured afterwards (every role and parameter is immutable).
 *
 * Deploys, in this order (the order matters: two addresses are predicted from the broadcaster's
 * nonce so two contracts can name them immutably, the same pattern as DeployGateMarket.s.sol):
 *
 *   n    CrLabTestDollar        the labelled test dollar (worthless, symbol CRLAB-TUSD, not USDC)
 *   n+1  TouchstoneEscrow       over the test dollar, fee 0: WorkClaim reads it for reservations
 *   n+2  CapacityBond           names WorkClaim (n+4) as the only contract that may move headroom
 *   n+3  EligibleClaimRouter    R11's router; the lab key may set its skipped/probe flags
 *   n+4  WorkClaim              built with the eligibility router for ALL its mints
 *   n+5  AguBuffer              names AguLab (n+6) as the only contract that may draw cover
 *   n+6  AguLab                 the reserve, Commodity claims only
 *   n+7  TouchstoneEscrow       over AGU-lab, fee 0: agents pay each other through it
 *
 * Both escrows are the existing contract, unchanged, at a zero fee: the plan's only dollar costs
 * inside the market are data, sweeps and the roll's front-claim purchases (§4.2), and a fee would
 * be another. Their treasury therefore only has to be non-zero.
 *
 * The publisher is the CR lab key and never the print's: the script reads the print publisher
 * from this repository's own deployment records and refuses it. The lab key signs the Commodity
 * CR rate attestations both WorkClaim and AguLab verify, and sets the router's flags.
 *
 * Chain guard: a local anvil devnet (31337) or Base Sepolia (84532), the plan's two ledgers on
 * chain (§3.2). Every other chain id reverts, mainnets included. No deployment record is written
 * by this script, and none exists yet.
 *
 * Required env (`CR_` names only, D72's key isolation):
 *   CR_LAB_PUBLISHER_ADDRESS      the lab key's address (rate attestations, router flags)
 *   CR_AGU_ISSUER_ADDRESS         the AGU-lab issuer role: the only caller of `roll`
 *   CR_AGU_PARTICIPANT_ADDRESS    the authorised participant: the only caller of `create`
 *   CR_AGU_INCOME_LEDGER_ADDRESS  the issuer's income ledger: receives carry above the target
 *   CR_AGU_BUFFER_TARGET          the buffer's target, in test-dollar base units
 *   CR_AGU_MIN_TENOR_SECONDS      the minimum tenor a created or bought lot must have left
 *   CR_AGU_ROLL_DISCOUNT_BPS      the roll's discount on the print for front-claim sales
 * Optional:
 *   CR_ESCROW_TREASURY_ADDRESS    both escrows' fee treasury (receives nothing at fee 0);
 *                                 defaults to the broadcaster
 *
 * The numbers have no defaults on purpose: they belong to the committed parameters file
 * (§3.5), and a script default would be a number invented in a second place.
 */
contract DeployCrEconomy is Script {
    using stdJson for string;

    uint256 internal constant ANVIL_CHAIN_ID = 31337;
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;
    bytes32 internal constant SERIES_COMMODITY = keccak256("commodity");

    struct Config {
        address publisher;
        address aguIssuer;
        address participant;
        address incomeLedger;
        address escrowTreasury;
        uint256 bufferTarget;
        uint64 minTenor;
        uint16 discountBps;
    }

    struct Deployment {
        CrLabTestDollar dollar;
        TouchstoneEscrow claimEscrow;
        CapacityBond bond;
        EligibleClaimRouter router;
        WorkClaim workClaim;
        AguBuffer buffer;
        AguLab aguLab;
        TouchstoneEscrow aguEscrow;
    }

    function run() external returns (Deployment memory) {
        return deployWith(_config());
    }

    /// @notice The deployment for an explicit configuration: what `run` does after reading the
    ///         environment. Public so a test can check the guards without changing process-wide
    ///         environment variables, which other tests read concurrently.
    function deployWith(Config memory c) public returns (Deployment memory d) {
        require(
            block.chainid == ANVIL_CHAIN_ID || block.chainid == BASE_SEPOLIA_CHAIN_ID,
            "DeployCrEconomy.s.sol targets anvil (31337) or Base Sepolia (84532) only: the CR economy is testnet-only."
        );
        require(
            !_isPrintPublisher(c.publisher),
            "CR_LAB_PUBLISHER_ADDRESS is the print's publisher: the CR economy must use the lab key."
        );

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (c.escrowTreasury == address(0)) c.escrowTreasury = deployer;
        d = _deploy(c, deployer);
        vm.stopBroadcast();

        _log(d);
    }

    function _config() internal view returns (Config memory c) {
        c.publisher = vm.envAddress("CR_LAB_PUBLISHER_ADDRESS");
        c.aguIssuer = vm.envAddress("CR_AGU_ISSUER_ADDRESS");
        c.participant = vm.envAddress("CR_AGU_PARTICIPANT_ADDRESS");
        c.incomeLedger = vm.envAddress("CR_AGU_INCOME_LEDGER_ADDRESS");
        c.escrowTreasury = vm.envOr("CR_ESCROW_TREASURY_ADDRESS", address(0));
        c.bufferTarget = vm.envUint("CR_AGU_BUFFER_TARGET");
        uint256 tenor = vm.envUint("CR_AGU_MIN_TENOR_SECONDS");
        uint256 discount = vm.envUint("CR_AGU_ROLL_DISCOUNT_BPS");
        require(tenor <= type(uint64).max, "CR_AGU_MIN_TENOR_SECONDS does not fit uint64");
        require(discount < 10_000, "CR_AGU_ROLL_DISCOUNT_BPS must be below 10000");
        c.minTenor = uint64(tenor);
        c.discountBps = uint16(discount);
    }

    /// The print's publisher, as this repository recorded it on both chains it has anchored to.
    /// Read from the records rather than restated, so the two cannot drift apart.
    function _isPrintPublisher(address candidate) internal view returns (bool) {
        string[2] memory records = ["base-sepolia.json", "arc-testnet.json"];
        for (uint256 i = 0; i < records.length; i++) {
            string memory json = vm.readFile(
                string.concat(vm.projectRoot(), "/../../data/deployments/", records[i])
            );
            address printPublisher =
                json.readAddress(".contracts.TouchstoneAttestation.constructorArgs.publisher_");
            if (candidate == printPublisher) return true;
        }
        return false;
    }

    function _deploy(Config memory c, address deployer) internal returns (Deployment memory d) {
        uint64 nonce = vm.getNonce(deployer);
        address predictedWorkClaim = vm.computeCreateAddress(deployer, nonce + 4);
        address predictedAguLab = vm.computeCreateAddress(deployer, nonce + 6);

        d.dollar = new CrLabTestDollar();
        d.claimEscrow = new TouchstoneEscrow(IERC20(address(d.dollar)), c.escrowTreasury, 0);
        d.bond = new CapacityBond(IERC20(address(d.dollar)), predictedWorkClaim);
        d.router = new EligibleClaimRouter(d.bond, c.publisher);
        // WorkClaim takes a ClaimRouter; EligibleClaimRouter has the same `route` signature, and
        // WorkClaim calls nothing else on its router.
        d.workClaim = new WorkClaim(
            IERC20(address(d.dollar)),
            d.bond,
            ClaimRouter(address(d.router)),
            c.publisher,
            ITouchstoneEscrow(address(d.claimEscrow))
        );
        require(address(d.workClaim) == predictedWorkClaim, "WorkClaim address prediction mismatch");

        d.buffer = new AguBuffer(IERC20(address(d.dollar)), predictedAguLab, c.bufferTarget);
        d.aguLab = new AguLab(
            d.workClaim,
            d.buffer,
            c.aguIssuer,
            c.participant,
            c.incomeLedger,
            SERIES_COMMODITY,
            c.minTenor,
            c.discountBps
        );
        require(address(d.aguLab) == predictedAguLab, "AguLab address prediction mismatch");

        d.aguEscrow = new TouchstoneEscrow(IERC20(address(d.aguLab)), c.escrowTreasury, 0);
    }

    function _log(Deployment memory d) internal pure {
        console.log("CrLabTestDollar:     ", address(d.dollar));
        console.log("TouchstoneEscrow (test dollar):", address(d.claimEscrow));
        console.log("CapacityBond:        ", address(d.bond));
        console.log("EligibleClaimRouter: ", address(d.router));
        console.log("WorkClaim:           ", address(d.workClaim));
        console.log("AguBuffer:           ", address(d.buffer));
        console.log("AguLab:              ", address(d.aguLab));
        console.log("TouchstoneEscrow (AGU-lab):   ", address(d.aguEscrow));
    }
}
