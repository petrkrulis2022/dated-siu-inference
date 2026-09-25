// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CapacityBond} from "../src/CapacityBond.sol";
import {ClaimRouter} from "../src/ClaimRouter.sol";
import {WorkClaim} from "../src/WorkClaim.sol";

/**
 * Base Sepolia deployment for the Gate Market testbed's contracts — docs/gate-market-spec.md
 * §5.3, WP-2. Base Sepolia first, deliberately: the spec states Base Sepolia is primary because
 * the escrow/attestation deploy path is already proven there, with Arc as the byte-identical
 * mirror once it's warranted — same discipline as Deploy.s.sol / DeployArcTestnet.s.sol.
 *
 * `CapacityBond` and `WorkClaim` reference each other's addresses immutably (CapacityBond
 * restricts headroom/bond mutation to WorkClaim alone; WorkClaim calls CapacityBond and
 * ClaimRouter). Rather than a setter for either — which would be exactly the kind of admin path
 * this project's own no-admin-path invariant exists to rule out — WorkClaim's future address is
 * computed from the broadcaster's own nonce sequence before anything is deployed, matching
 * test/WorkClaim.invariant.t.sol's setUp() exactly: usdc-independent deploys, then
 * CapacityBond (nonce N), ClaimRouter (nonce N+1), WorkClaim (nonce N+2), with CapacityBond's
 * constructor already holding WorkClaim's real, correct address despite WorkClaim not existing
 * yet at that point in the sequence.
 *
 * Required env:
 *   TOUCHSTONE_GATE_MARKET_USDC   optional override; defaults to Base Sepolia USDC below
 *   TOUCHSTONE_PUBLISHER_ADDRESS  the address permitted to sign settlement rate attestations —
 *                                 same env var Deploy.s.sol already reads for
 *                                 TouchstoneAttestation's own publisher, and the same real key
 *                                 (packages/print/src/sign/sign.ts's TOUCHSTONE_PUBLISHER_KEY) —
 *                                 see WorkClaim.sol's "Settlement-rate binding" doc comment for
 *                                 why reusing the one key to sign both message types is safe.
 */
contract DeployGateMarket is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// Same address Deploy.s.sol uses — Base Sepolia USDC, from Circle's own documentation.
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        require(
            block.chainid == BASE_SEPOLIA_CHAIN_ID,
            "DeployGateMarket.s.sol targets Base Sepolia (84532) only. Write a separate script for another chain."
        );

        address usdc = vm.envOr("TOUCHSTONE_GATE_MARKET_USDC", BASE_SEPOLIA_USDC);
        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        uint64 nonce = vm.getNonce(deployer);
        address predictedWorkClaim = vm.computeCreateAddress(deployer, nonce + 2);

        CapacityBond bond = new CapacityBond(IERC20(usdc), predictedWorkClaim);
        ClaimRouter router = new ClaimRouter(bond);
        WorkClaim workClaim = new WorkClaim(IERC20(usdc), bond, router, publisher);
        vm.stopBroadcast();

        require(address(workClaim) == predictedWorkClaim, "WorkClaim address prediction mismatch");

        console.log("CapacityBond:", address(bond));
        console.log("  usdc:            ", usdc);
        console.log("  workClaim:       ", address(workClaim));
        console.log("ClaimRouter: ", address(router));
        console.log("  bond:            ", address(bond));
        console.log("WorkClaim:   ", address(workClaim));
        console.log("  usdc:            ", usdc);
        console.log("  bond:            ", address(bond));
        console.log("  router:          ", address(router));
        console.log("  publisher:       ", publisher);
    }
}
