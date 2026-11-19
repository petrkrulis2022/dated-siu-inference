// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TouchstoneAttestationV2} from "../src/TouchstoneAttestationV2.sol";

/**
 * Deploys TouchstoneAttestationV2 — mainnet-switch brief §8, not a replacement for
 * TouchstoneAttestation.sol, which stays deployed and unmodified wherever it already is.
 *
 * One script for every chain this contract goes on (Base Sepolia, Arc Testnet first for
 * validation; Base mainnet, Arc mainnet and — only once its own checks pass — Kite mainnet
 * later), rather than a near-duplicate script per chain: V2 is deployed with identical
 * constructor logic everywhere, and what must never be guessed is the chain itself. The chain-id
 * guard is therefore an explicit required env var, not a hardcoded constant — broadcasting
 * against the wrong network would otherwise deploy a contract whose domain separator silently
 * encodes the wrong chainId, and every signature the publisher later produces for the INTENDED
 * chain would simply fail to verify there, with no on-chain signal pointing at why.
 *
 * Required env:
 *   TOUCHSTONE_V2_CHAIN_ID        the chain this broadcast must land on — confirmed, never
 *                                 defaulted or guessed (same discipline as DeployArcMainnet.s.sol)
 *   TOUCHSTONE_PUBLISHER_ADDRESS  the address whose EIP-712 signature postPrint will trust
 *   TOUCHSTONE_ADMIN_ADDRESS      the address that may call rotatePublisher — on a testnet
 *                                 validation run this may be a well-known public test address
 *                                 (e.g. Anvil's default account 0); it must be a real,
 *                                 owner-controlled hardware-wallet address before any mainnet use
 */
contract DeployAttestationV2 is Script {
    function run() external {
        uint256 expectedChainId = vm.envUint("TOUCHSTONE_V2_CHAIN_ID");
        require(
            block.chainid == expectedChainId,
            "DeployAttestationV2.s.sol: block.chainid does not match TOUCHSTONE_V2_CHAIN_ID. Confirm the real value before running."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");
        address admin = vm.envAddress("TOUCHSTONE_ADMIN_ADDRESS");

        vm.startBroadcast();
        TouchstoneAttestationV2 attestation = new TouchstoneAttestationV2(publisher, admin);
        vm.stopBroadcast();

        console.log("TouchstoneAttestationV2:", address(attestation));
        console.log("  publisher:      ", publisher);
        console.log("  admin:          ", admin);
        console.log("  chainId:        ", block.chainid);
        console.logBytes32(attestation.printAttestationDomainSeparator());
    }
}
