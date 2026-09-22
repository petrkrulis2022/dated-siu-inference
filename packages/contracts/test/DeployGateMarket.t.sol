// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployGateMarket} from "../script/DeployGateMarket.s.sol";

/**
 * Same reasoning as Deploy.t.sol: the chain-id guard is the one thing worth testing directly,
 * plus — specific to this script — that the WorkClaim address prediction actually holds when run
 * for real (not just asserted in the script's own require, which this test would also fail if
 * that assertion ever fired).
 */
contract DeployGateMarketTest is Test {
    DeployGateMarket internal script;

    function setUp() public {
        script = new DeployGateMarket();
    }

    function test_run_revertsOnAnyChainOtherThanBaseSepolia() public {
        vm.chainId(8453); // Base mainnet
        vm.expectRevert(
            bytes(
                "DeployGateMarket.s.sol targets Base Sepolia (84532) only. Write a separate script for another chain."
            )
        );
        script.run();
    }

    function test_run_revertsOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert();
        script.run();
    }

    function test_run_deploysAllThreeOnBaseSepoliaWithCorrectCrossReferences() public {
        vm.chainId(84532);
        script.run();
        // Reaching here means: the guard admitted the correct chain, all three constructors
        // accepted their arguments, and the script's own require(address(workClaim) ==
        // predictedWorkClaim) held — the circular-reference address prediction actually worked
        // against a real broadcaster/nonce sequence, not just in the invariant suite's own setUp.
    }
}
