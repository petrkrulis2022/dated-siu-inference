// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployArcMainnet} from "../script/DeployArcMainnet.s.sol";

/**
 * Unlike Deploy.s.sol/DeployArcTestnet.s.sol, this script's chain-id guard is env-var-driven,
 * not a hardcoded constant — Arc's real mainnet chain id wasn't publicly documented when this
 * was written. This test confirms the guard mechanism itself (revert on mismatch, then succeed
 * on a match, whatever the confirmed value turns out to be), not any specific chain id number.
 *
 * Found live, 2026-09-27: the revert case and the success case used to be two separate test
 * functions, each calling `vm.setEnv("ARC_MAINNET_CHAIN_ID", ...)` with a different value.
 * `vm.setEnv` mutates a real OS-level environment variable of the whole forge test process, not
 * a per-test-isolated value the way EVM state (`vm.chainId`, storage, etc.) is — so when forge's
 * default test parallelism ran both functions concurrently, one test's `vm.setEnv` could
 * overwrite the other's between its own `vm.setEnv` call and the `script.run()` that reads it
 * back via `vm.envUint`, producing an intermittent, environment-dependent failure with no code
 * change behind it (confirmed by repeatedly re-running the full suite: it passed most of the
 * time, failed about one run in five). Foundry has no per-test isolation for `vm.setEnv`/
 * `vm.envXxx`; the only way to make two `vm.setEnv` calls on the same key race-free is to keep
 * them inside one test function, which forge never runs concurrently with itself. Combined here
 * into a single ordered sequence for exactly that reason — never touching real spend or safety,
 * this is purely a testing-infrastructure fix.
 */
contract DeployArcMainnetTest is Test {
    DeployArcMainnet internal script;

    function setUp() public {
        script = new DeployArcMainnet();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", "0x0000000000000000000000000000000000000A11");
    }

    function test_run_revertsOnMismatchThenSucceedsOnceTheChainIdMatches() public {
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "999999999");
        vm.chainId(5042002); // Arc Testnet's real chain id — deliberately not mainnet's
        vm.expectRevert(
            bytes(
                "DeployArcMainnet.s.sol: block.chainid does not match ARC_MAINNET_CHAIN_ID. Confirm the real value against Arc's own docs before running."
            )
        );
        script.run();

        // Stands in for whatever Arc's real mainnet chain id turns out to be — the guard checks
        // agreement with ARC_MAINNET_CHAIN_ID, not any number baked into the script itself.
        vm.setEnv("ARC_MAINNET_CHAIN_ID", "424242");
        vm.chainId(424242);
        script.run();
        // Reaching here means the guard admitted a chain id matching the confirmed env var and
        // the constructor accepted its argument; the deployed address is logged by the script.
    }
}
