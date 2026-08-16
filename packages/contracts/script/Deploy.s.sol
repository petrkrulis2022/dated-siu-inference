// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DatumAttestation} from "../src/DatumAttestation.sol";
import {DatumEscrow} from "../src/DatumEscrow.sol";

/**
 * Base Sepolia deployment — build1-spec.md §10 ("Deploy scripts for Base Sepolia").
 *
 * Chain-specificity belongs here, not in the contracts: `DatumEscrow` and `DatumAttestation`
 * take the token and every other environment-dependent value as constructor parameters, so
 * adding Arc or Base mainnet later is a new script, never a contract change.
 *
 * The chain-id guard is the point of this file being testnet-only: broadcasting it against any
 * other network would otherwise deploy an escrow pointing at an address that is not USDC there,
 * and the mistake would only surface when someone's funds failed to arrive.
 *
 * Required env:
 *   DATUM_PUBLISHER_ADDRESS  the address permitted to call postPrint (the publisher key's address)
 *   DATUM_TREASURY           fee destination — should be a Safe/multisig, since it is immutable
 *   DATUM_FEE_BPS            fee in basis points, must be <= DatumEscrow.MAX_FEE_BPS (100)
 * Optional:
 *   DATUM_USDC               overrides the Base Sepolia USDC address below
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

        address publisher = vm.envAddress("DATUM_PUBLISHER_ADDRESS");
        address treasury = vm.envAddress("DATUM_TREASURY");
        uint256 feeBps = vm.envUint("DATUM_FEE_BPS");
        address usdc = vm.envOr("DATUM_USDC", BASE_SEPOLIA_USDC);

        require(feeBps <= type(uint16).max, "DATUM_FEE_BPS out of range");

        vm.startBroadcast();
        DatumAttestation attestation = new DatumAttestation(publisher);
        DatumEscrow escrow = new DatumEscrow(IERC20(usdc), treasury, uint16(feeBps));
        vm.stopBroadcast();

        console.log("DatumAttestation:", address(attestation));
        console.log("  publisher:      ", publisher);
        console.log("DatumEscrow:     ", address(escrow));
        console.log("  token (USDC):   ", usdc);
        console.log("  treasury:       ", treasury);
        console.log("  feeBps:         ", feeBps);
    }
}
