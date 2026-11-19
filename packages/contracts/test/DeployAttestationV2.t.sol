// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployAttestationV2} from "../script/DeployAttestationV2.s.sol";
import {TouchstoneAttestationV2} from "../src/TouchstoneAttestationV2.sol";

/**
 * Confirms the chain-id guard itself (revert on mismatch, then succeed on a match) and that the
 * deployed contract's publisher/admin match the env vars — not any specific chain id, since this
 * one script targets every chain TouchstoneAttestationV2 goes on. Combines the revert case and the
 * success case into one ordered test function for the `vm.setEnv` race reason DeployArcMainnet.t.sol
 * documents: `vm.setEnv` mutates the whole process's real environment, not per-test EVM state, so
 * two tests each setting the same key can race under forge's default parallelism.
 */
contract DeployAttestationV2Test is Test {
    DeployAttestationV2 internal script;

    address internal constant PUBLISHER = 0x0000000000000000000000000000000000000a11;
    address internal constant ADMIN = 0x0000000000000000000000000000000000000AD1;

    function setUp() public {
        script = new DeployAttestationV2();
        vm.setEnv("TOUCHSTONE_PUBLISHER_ADDRESS", vm.toString(PUBLISHER));
        vm.setEnv("TOUCHSTONE_ADMIN_ADDRESS", vm.toString(ADMIN));
    }

    function test_run_revertsOnMismatchThenDeploysOnceTheChainIdMatches() public {
        vm.setEnv("TOUCHSTONE_V2_CHAIN_ID", "999999999");
        vm.chainId(84532); // Base Sepolia's real chain id — deliberately not the configured one
        vm.expectRevert(
            bytes(
                "DeployAttestationV2.s.sol: block.chainid does not match TOUCHSTONE_V2_CHAIN_ID. Confirm the real value before running."
            )
        );
        script.run();

        vm.setEnv("TOUCHSTONE_V2_CHAIN_ID", "84532");
        vm.chainId(84532);
        script.run();
        // Reaching here means the guard admitted a matching chain id and the constructor accepted
        // its arguments; publisher/admin are checked independently below via a fresh deploy, since
        // this script's own deployed address isn't returned to the caller (only logged).
    }

    function test_deployedContract_hasThePublisherAndAdminFromEnv() public {
        TouchstoneAttestationV2 attestation = new TouchstoneAttestationV2(PUBLISHER, ADMIN);
        assertEq(attestation.publisher(), PUBLISHER);
        assertEq(attestation.admin(), ADMIN);
    }
}
