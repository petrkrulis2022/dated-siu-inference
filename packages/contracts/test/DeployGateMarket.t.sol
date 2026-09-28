// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployGateMarket} from "../script/DeployGateMarket.s.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * Same reasoning as Deploy.t.sol: the chain-id guard is the one thing worth testing directly,
 * plus — specific to this script — that the WorkClaim address prediction actually holds when run
 * for real (not just asserted in the script's own require, which this test would also fail if
 * that assertion ever fired).
 */
contract DeployGateMarketTest is Test {
    using stdJson for string;

    DeployGateMarket internal script;

    function setUp() public {
        script = new DeployGateMarket();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");

        // WorkClaim now takes the escrow it reads reservations against, and the script requires
        // real code at that address — correctly, since an escrow-less WorkClaim would accept every
        // reserveForWork call's escrow lookup as a revert rather than a check. A local simulation
        // has no Base Sepolia state, so put a genuine TouchstoneEscrow's runtime code at the
        // script's own default address. That exercises the default path rather than an env
        // override, which is what a real deploy will use.
        MockUSDC usdc = new MockUSDC();
        TouchstoneEscrow escrow =
            new TouchstoneEscrow(IERC20(address(usdc)), makeAddr("treasury"), 50);
        vm.etch(script.BASE_SEPOLIA_ESCROW(), address(escrow).code);
    }

    /// The script's hardcoded default must be the escrow this repo actually has deployed on Base
    /// Sepolia, not a plausible-looking address — read from the deployment record itself rather
    /// than restated here, so the two cannot drift apart silently.
    function test_defaultEscrowMatchesTheRecordedBaseSepoliaDeployment() public view {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../../data/deployments/base-sepolia.json")
        );
        assertEq(
            json.readAddress(".contracts.TouchstoneEscrow.address"), script.BASE_SEPOLIA_ESCROW()
        );
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
