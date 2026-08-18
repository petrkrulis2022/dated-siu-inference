// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TouchstoneAttestation} from "../src/TouchstoneAttestation.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";

/**
 * Base Sepolia deployment — build1-spec.md §10 ("Deploy scripts for Base Sepolia").
 *
 * Chain-specificity belongs here, not in the contracts: `TouchstoneEscrow` and `TouchstoneAttestation`
 * take the token and every other environment-dependent value as constructor parameters, so
 * adding Arc or Base mainnet later is a new script, never a contract change.
 *
 * The chain-id guard is the point of this file being testnet-only: broadcasting it against any
 * other network would otherwise deploy an escrow pointing at an address that is not USDC there,
 * and the mistake would only surface when someone's funds failed to arrive.
 *
 * Required env:
 *   TOUCHSTONE_PUBLISHER_ADDRESS  the address permitted to call postPrint (the publisher key's address)
 *   TOUCHSTONE_TREASURY           fee destination — should be a Safe/multisig, since it is immutable
 *   TOUCHSTONE_FEE_BPS            fee in basis points, must be <= TouchstoneEscrow.MAX_FEE_BPS (100)
 * Optional:
 *   TOUCHSTONE_USDC               overrides the Base Sepolia USDC address below
 */
contract Deploy is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// Base Sepolia USDC, from Circle's own documentation
    /// (https://developers.circle.com/stablecoins/usdc-contract-addresses) — the same value
    /// packages/sdk/src/money/assets.ts already carries, rather than a second source of truth.
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        require(
            block.chainid == BASE_SEPOLIA_CHAIN_ID,
            "Deploy.s.sol targets Base Sepolia (84532) only. Write a separate script for another chain."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");
        address treasury = vm.envAddress("TOUCHSTONE_TREASURY");
        uint256 feeBps = vm.envUint("TOUCHSTONE_FEE_BPS");
        address usdc = vm.envOr("TOUCHSTONE_USDC", BASE_SEPOLIA_USDC);

        require(feeBps <= type(uint16).max, "TOUCHSTONE_FEE_BPS out of range");

        vm.startBroadcast();
        TouchstoneAttestation attestation = new TouchstoneAttestation(publisher);
        TouchstoneEscrow escrow = new TouchstoneEscrow(IERC20(usdc), treasury, uint16(feeBps));
        vm.stopBroadcast();

        console.log("TouchstoneAttestation:", address(attestation));
        console.log("  publisher:      ", publisher);
        console.log("TouchstoneEscrow:     ", address(escrow));
        console.log("  token (USDC):   ", usdc);
        console.log("  treasury:       ", treasury);
        console.log("  feeBps:         ", feeBps);
    }
}
