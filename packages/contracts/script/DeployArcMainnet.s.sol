// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TouchstoneAttestation} from "../src/TouchstoneAttestation.sol";

/**
 * Arc MAINNET deployment — prepared ahead of Arc's 2026-09-16 public mainnet launch, not run.
 * TouchstoneAttestation ONLY: it holds no funds and anchors a hash with no value at risk, so
 * deploying it is near-zero-risk the moment mainnet is genuinely reachable. TouchstoneEscrow
 * stays on Arc Testnet regardless of the date — a Safe treasury, a settled feeBps, an
 * air-gapped publisher key, and external review are all still unmet preconditions (see
 * data/deployments/arc-testnet.json's mainnetRequirements), and a launch date is not a reason to
 * put an unaudited fund-holding contract in front of real USDC.
 *
 * ARC_MAINNET_CHAIN_ID is deliberately NOT a hardcoded constant: Arc's own real mainnet chain id
 * was not publicly documented as of this file's writing (2026-09-05, 11 days before launch).
 * CLAUDE.md's first hard invariant bans invented values — a guessed chain id here would be
 * exactly that, and broadcasting against the wrong chain id entirely defeats the guard's whole
 * purpose. Confirm the real value against Arc's own documentation
 * (https://docs.arc.io/arc/references/connect-to-arc or its mainnet successor) before running
 * this, and pass it explicitly — the script refuses to run without it.
 *
 * Required env:
 *   TOUCHSTONE_PUBLISHER_ADDRESS  the address permitted to call postPrint (the publisher key's address)
 *   ARC_MAINNET_CHAIN_ID          Arc's real mainnet chain id, confirmed at run time — not defaulted
 */
contract DeployArcMainnet is Script {
    function run() external {
        uint256 expectedChainId = vm.envUint("ARC_MAINNET_CHAIN_ID");
        require(
            block.chainid == expectedChainId,
            "DeployArcMainnet.s.sol: block.chainid does not match ARC_MAINNET_CHAIN_ID. Confirm the real value against Arc's own docs before running."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");

        vm.startBroadcast();
        TouchstoneAttestation attestation = new TouchstoneAttestation(publisher);
        vm.stopBroadcast();

        console.log("TouchstoneAttestation:", address(attestation));
        console.log("  publisher:      ", publisher);
        console.log("  chainId:        ", block.chainid);
    }
}
