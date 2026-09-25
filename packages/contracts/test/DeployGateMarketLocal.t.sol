// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployGateMarketLocal} from "../script/DeployGateMarketLocal.s.sol";

/// Same reasoning as DeployGateMarket.t.sol: the chain-id guard and the address-prediction
/// sequence are the two things worth testing directly, one more deploy ahead here since this
/// script also deploys its own MockUSDC rather than taking an existing address.
contract DeployGateMarketLocalTest is Test {
    DeployGateMarketLocal internal script;

    function setUp() public {
        script = new DeployGateMarketLocal();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");
    }

    function test_run_revertsOnAnyChainOtherThanAnvilDefault() public {
        vm.chainId(84532); // Base Sepolia — the real chain, not this script's target
        vm.expectRevert(
            bytes("DeployGateMarketLocal.s.sol targets a local anvil devnet (chainid 31337) only.")
        );
        script.run();
    }

    function test_run_revertsOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert();
        script.run();
    }

    function test_run_deploysAllFourOnAnvilChainIdWithCorrectCrossReferences() public {
        vm.chainId(31337);
        script.run();
        // Reaching here means: the guard admitted chainid 31337, all four constructors accepted
        // their arguments (MockUSDC, then the three real Gate Market contracts wired to it), and
        // the script's own require(address(workClaim) == predictedWorkClaim) held.
    }
}
