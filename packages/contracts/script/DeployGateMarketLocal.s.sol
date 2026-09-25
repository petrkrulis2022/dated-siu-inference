// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/**
 * Local-devnet-only deployment for the Gate Market testbed — WP-5 (docs/gate-market-spec.md
 * §10), the "dry loop, no models" package. NOT `DeployGateMarket.s.sol`: that script targets
 * real Base Sepolia and a real USDC address; this one is chain-id-guarded to anvil's own default
 * (31337) and deploys a fresh `MockUSDC` — there is no real USDC on an ephemeral local chain, and
 * conflating the two scripts would risk a real-chain deploy picking up test-only assumptions.
 *
 * Deploys the four contracts only — no bonded lots, no funded agents. Per-agent identity
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

    function run() external {
        require(
            block.chainid == ANVIL_CHAIN_ID,
            "DeployGateMarketLocal.s.sol targets a local anvil devnet (chainid 31337) only."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint64 nonce = vm.getNonce(deployer);
        // usdc (nonce), then bond (nonce+1), router (nonce+2), workClaim (nonce+3) — one more
        // deploy ahead of DeployGateMarket.s.sol's own sequence since usdc is deployed here too,
        // not supplied as an existing address.
        address predictedWorkClaim = vm.computeCreateAddress(deployer, nonce + 3);

        MockUSDC usdc = new MockUSDC();
        CapacityBond bond = new CapacityBond(IERC20(address(usdc)), predictedWorkClaim);
        ClaimRouter router = new ClaimRouter(bond);
        WorkClaim workClaim = new WorkClaim(IERC20(address(usdc)), bond, router, publisher);
        vm.stopBroadcast();

        require(address(workClaim) == predictedWorkClaim, "WorkClaim address prediction mismatch");

        console.log("MockUSDC:    ", address(usdc));
        console.log("CapacityBond:", address(bond));
        console.log("ClaimRouter: ", address(router));
        console.log("WorkClaim:   ", address(workClaim));
    }
}
