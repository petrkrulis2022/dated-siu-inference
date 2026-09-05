// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployArcMainnet} from "../script/DeployArcMainnet.s.sol";

/**
 * Unlike Deploy.s.sol/DeployArcTestnet.s.sol, this script's chain-id guard is env-var-driven,
 * not a hardcoded constant — Arc's real mainnet chain id wasn't publicly documented when this
 * was written. These tests confirm the guard mechanism itself (revert on mismatch, succeed on a
 * match, whatever the confirmed value turns out to be), not any specific chain id number.
 */
contract DeployArcMainnetTest is Test {
    DeployArcMainnet internal script;

    function setUp() public {
        script = new DeployArcMainnet();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");
    }

    function test_run_revertsWhenChainDoesNotMatchTheConfirmedMainnetChainId() public {
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "999999999");
        vm.chainId(5042002); // Arc Testnet's real chain id — deliberately not mainnet's
        vm.expectRevert(
            bytes(
                "DeployArcMainnet.s.sol: block.chainid does not match ARC_MAINNET_CHAIN_ID. Confirm the real value against Arc's own docs before running."
            )
        );
        script.run();
    }

    function test_run_succeedsOnceTheRealChainIdIsConfirmedAndMatches() public {
        // Stands in for whatever Arc's real mainnet chain id turns out to be — the guard checks
        // agreement with ARC_MAINNET_CHAIN_ID, not any number baked into the script itself.
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "424242");
        vm.chainId(424242);
        script.run();
        // Reaching here means the guard admitted a chain id matching the confirmed env var and
        // the constructor accepted its argument; the deployed address is logged by the script.
    }
}
