// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/**
 * The deploy script is the one place chain-specific values live, so its guard is worth testing:
 * broadcasting against the wrong network would deploy an escrow pointing at an address that is
 * not USDC there, and the mistake would only surface when someone's funds failed to arrive.
 */
contract DeployTest is Test {
    Deploy internal script;

    function setUp() public {
        script = new Deploy();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");
        vm.setEnv("TOUCHSTONE_TREASURY", "0x0000000000000000000000000000000000000B22");
        vm.setEnv("TOUCHSTONE_FEE_BPS", "50");
    }

    function test_run_revertsOnAnyChainOtherThanBaseSepolia() public {
        vm.chainId(8453); // Base mainnet
        vm.expectRevert(
            bytes(
                "Deploy.s.sol targets Base Sepolia (84532) only. Write a separate script for another chain."
            )
        );
        script.run();
    }

    function test_run_revertsOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert();
        script.run();
    }

    function test_run_deploysBothContractsOnBaseSepolia() public {
        vm.chainId(84532);
        script.run();
        // Reaching here means the guard admitted the correct chain and both constructors
        // accepted their arguments; the deployed addresses are logged by the script itself.
    }

    // Deliberately no test here that sets TOUCHSTONE_FEE_BPS above the cap and re-runs the script.
    // `vm.setEnv` mutates the real process environment, which is shared across concurrently
    // executing tests — an earlier revision did exactly that and passed under `forge test` while
    // failing under `forge coverage`, purely because the two schedule tests differently. The fee
    // ceiling is a TouchstoneEscrow constructor property and is covered exhaustively there by
    // `testFuzz_constructor_revertsForAnyFeeAboveMax`; the script only forwards the value.
}
