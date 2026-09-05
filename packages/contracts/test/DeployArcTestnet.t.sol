// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployArcTestnet} from "../script/DeployArcTestnet.s.sol";

/**
 * The deploy script is the one place chain-specific values live, so its guard is worth testing:
 * broadcasting against the wrong network would deploy an escrow pointing at an address that is
 * not USDC there, and the mistake would only surface when someone's funds failed to arrive.
 */
contract DeployArcTestnetTest is Test {
    DeployArcTestnet internal script;

    function setUp() public {
        script = new DeployArcTestnet();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");
        vm.setEnv("TOUCHSTONE_TREASURY", "0x0000000000000000000000000000000000000B22");
        vm.setEnv("TOUCHSTONE_FEE_BPS", "50");
    }

    function test_run_revertsOnBaseSepolia() public {
        vm.chainId(84532);
        vm.expectRevert(
            bytes(
                "DeployArcTestnet.s.sol targets Arc Testnet (5042002) only. Write a separate script for another chain."
            )
        );
        script.run();
    }

    function test_run_revertsOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert();
        script.run();
    }

    function test_run_deploysBothContractsOnArcTestnet() public {
        vm.chainId(5042002);
        script.run();
        // Reaching here means the guard admitted the correct chain and both constructors
        // accepted their arguments; the deployed addresses are logged by the script itself.
    }

    // Deliberately no fee-ceiling-violation test here — see Deploy.t.sol's own comment on why
    // vm.setEnv mutation makes that test order-sensitive across forge test vs forge coverage.
    // The ceiling is TouchstoneEscrow's own invariant, covered exhaustively there.
}
