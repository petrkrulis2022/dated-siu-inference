// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice The CR lab's test dollar: a worthless, freely mintable 6-decimal ERC-20 that stands in
 *         for USDC inside the CR economy on a test chain, and nowhere else.
 *
 * Named and labelled so it can never be mistaken for USDC: its symbol is not "USDC", its name
 * says what it is, and `isTestDollar()` lets any tool that reads it refuse to treat it as money.
 * Anyone may mint any amount, which is exactly why it is worth nothing (plan risk 3: on a test
 * chain the dollar is minted, never fetched from a faucet). Same shape as MockUSDC, which the
 * Gate Market's local deployment uses; kept separate so the CR economy's dollar carries its own
 * label on every explorer and log line.
 */
contract CrLabTestDollar is ERC20 {
    constructor() ERC20("Touchstone CR lab test dollar (worthless, not USDC)", "CRLAB-TUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function isTestDollar() external pure returns (bool) {
        return true;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
