// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice A token that burns 1% on every transfer, so the recipient receives less than was sent.
 *
 * DatumEscrow must reject this at funding time. If it did not, the contract would record an
 * escrow of `maxAmount` while holding less than that, and the shortfall would silently be paid
 * out of some other buyer's escrow at settlement.
 */
contract FeeOnTransferToken is ERC20 {
    uint256 private constant BURN_BPS = 100;

    constructor() ERC20("Fee On Transfer", "FOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 burned = (value * BURN_BPS) / 10_000;
            super._update(from, address(0), burned);
            super._update(from, to, value - burned);
        } else {
            super._update(from, to, value);
        }
    }
}
