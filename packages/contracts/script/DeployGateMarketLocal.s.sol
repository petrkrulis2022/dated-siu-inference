// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim, ITouchstoneEscrow} from "../src/WorkClaim.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/**
 * Local-devnet-only deployment for the Gate Market testbed — WP-5 (docs/gate-market-spec.md
 * §10), the "dry loop, no models" package. NOT `DeployGateMarket.s.sol`: that script targets
 * real Base Sepolia and a real USDC address; this one is chain-id-guarded to anvil's own default
 * (31337) and deploys a fresh `MockUSDC` — there is no real USDC on an ephemeral local chain, and
 * conflating the two scripts would risk a real-chain deploy picking up test-only assumptions.
 *
 * Deploys the five contracts only — no bonded lots, no funded agents. TouchstoneEscrow is
 * deployed here rather than supplied as an existing address (as DeployGateMarket.s.sol does on
 * Base Sepolia) because an ephemeral local chain has no prior deployment to point at, and
 * `WorkClaim.reserveForWork` reads real escrow state — a devnet without one could not exercise
 * the USDC-side capacity path at all. Per-agent identity
 * (fresh keys, funding, `createLot` calls) is provisioned from the TypeScript side
 * (`packages/gate-market-agents/src/devnet/deploy.ts`), since those identities are generated
 * per test run and this script has no way to know them in advance. The rate-attestation
 * publisher key is one of those TS-generated identities too, for the same reason — its address
 * is passed in here via TOUCHSTONE_PUBLISHER_ADDRESS, same as DeployGateMarket.s.sol's real
 * deploy, rather than a fixed local constant, so dry-loop scenarios can actually sign valid
 * attestations with the matching private key `deploy.ts` alone holds.
 *
 * Required env:
 *   TOUCHSTONE_PUBLISHER_ADDRESS  the address permitted to sign settlement rate attestations —
 *                                 see WorkClaim.sol's "Settlement-rate binding" doc comment.
 */
contract DeployGateMarketLocal is Script {
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    /// Matches the live Base Sepolia TouchstoneEscrow's own `feeBps` (50 = 0.5%).
    uint16 internal constant FEE_BPS = 50;

    function run() external {
        require(
            block.chainid == ANVIL_CHAIN_ID,
            "DeployGateMarketLocal.s.sol targets a local anvil devnet (chainid 31337) only."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");
        // Same fee treasury/rate the real Base Sepolia escrow carries, so a devnet escrow behaves
        // identically to the one the agents actually pay through; overridable for scenarios that
        // want to watch the fee leg specifically.
        address treasury = vm.envOr("TOUCHSTONE_TREASURY_ADDRESS", publisher);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint64 nonce = vm.getNonce(deployer);
        // usdc (nonce), escrow (nonce+1), bond (nonce+2), router (nonce+3), workClaim (nonce+4) —
        // two more deploys ahead of DeployGateMarket.s.sol's own sequence, since both USDC and the
        // escrow are deployed here rather than supplied as existing addresses.
        address predictedWorkClaim = vm.computeCreateAddress(deployer, nonce + 4);

        MockUSDC usdc = new MockUSDC();
        TouchstoneEscrow escrow = new TouchstoneEscrow(IERC20(address(usdc)), treasury, FEE_BPS);
        CapacityBond bond = new CapacityBond(IERC20(address(usdc)), predictedWorkClaim);
        ClaimRouter router = new ClaimRouter(bond);
        WorkClaim workClaim = new WorkClaim(
            IERC20(address(usdc)), bond, router, publisher, ITouchstoneEscrow(address(escrow))
        );
        vm.stopBroadcast();

        require(address(workClaim) == predictedWorkClaim, "WorkClaim address prediction mismatch");

        console.log("MockUSDC:    ", address(usdc));
        console.log("TouchstoneEscrow:", address(escrow));
        console.log("CapacityBond:", address(bond));
        console.log("ClaimRouter: ", address(router));
        console.log("WorkClaim:   ", address(workClaim));
    }
}
