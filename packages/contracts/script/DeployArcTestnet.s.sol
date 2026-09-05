// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TouchstoneAttestation} from "../src/TouchstoneAttestation.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";

/**
 * Arc Testnet deployment — a new script, not a contract change, per Deploy.s.sol's own doc
 * comment: "adding Arc or Base mainnet later is a new script, never a contract change."
 *
 * Arc Testnet's native gas currency is USDC itself (shown with 18 decimals at the protocol
 * level, distinct from the ERC-20 USDC contract below, which still reports 6 decimals like
 * every other chain's USDC) — the deployer wallet needs Arc Testnet USDC from
 * https://faucet.circle.com before broadcasting, same balance pays both gas and any settlement.
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
 *   TOUCHSTONE_USDC               overrides the Arc Testnet USDC address below
 */
contract DeployArcTestnet is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5042002;

    /// Arc Testnet USDC, verified against two independent Circle documentation pages
    /// (developers.circle.com/stablecoins/usdc-contract-addresses and
    /// developers.circle.com/stablecoins/quickstarts/transfer-usdc-evm) — the same value
    /// packages/sdk/src/money/assets.ts already carries, rather than a second source of truth.
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        require(
            block.chainid == ARC_TESTNET_CHAIN_ID,
            "DeployArcTestnet.s.sol targets Arc Testnet (5042002) only. Write a separate script for another chain."
        );

        address publisher = vm.envAddress("TOUCHSTONE_PUBLISHER_ADDRESS");
        address treasury = vm.envAddress("TOUCHSTONE_TREASURY");
        uint256 feeBps = vm.envUint("TOUCHSTONE_FEE_BPS");
        address usdc = vm.envOr("TOUCHSTONE_USDC", ARC_TESTNET_USDC);

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
