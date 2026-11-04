// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";

/**
 * @notice A misbehaving dollar for one test only: a transfer to `sticky` reports success and moves
 *         nothing, so the sender keeps the amount.
 *
 * AguLab's roll computes every outflow itself, so with a well-behaved token no input can make it
 * end holding USDC. That makes its last check, "the reserve's USDC is exactly zero or the roll
 * reverts" (plan R5, Q11), unreachable by ordinary inputs, and a check nothing can reach is a
 * check nobody has seen fire. This token makes one outflow silently fail so the test can watch
 * the final check catch it, against the real, unmodified contract.
 */
contract StickyUSDC is MockUSDC {
    address public sticky;

    function setSticky(address sticky_) external {
        sticky = sticky_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == sticky && from != address(0)) return;
        super._update(from, to, value);
    }
}
