// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TouchstoneEscrow} from "../../src/TouchstoneEscrow.sol";

/**
 * @notice A hostile ERC-20 that re-enters TouchstoneEscrow from inside its own transfer hook.
 *
 * This is the realistic shape of the attack: the escrow's only external calls are token
 * transfers, so a malicious or compromised settlement token is the attacker's foothold.
 *
 * The re-entry is wrapped in try/catch and its outcome recorded rather than allowed to bubble.
 * That matters for the test's rigour: if the re-entry reverted the whole transaction, a test
 * asserting "the transaction reverted" would pass even against a contract with no reentrancy
 * protection at all. Recording the outcome instead lets the test assert the specific fact that
 * matters — the re-entrant call was attempted and was refused.
 */
contract ReentrantToken is ERC20 {
    enum Mode {
        Settle,
        Expire,
        OpenAndFund
    }

    TouchstoneEscrow public escrow;
    bytes32 public targetQuoteHash;
    Mode public mode;
    bool public armed;

    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(TouchstoneEscrow escrow_, bytes32 targetQuoteHash_, Mode mode_) external {
        escrow = escrow_;
        targetQuoteHash = targetQuoteHash_;
        mode = mode_;
        armed = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (!armed || address(escrow) == address(0)) return;

        // Fire once, so the re-entry itself doesn't recurse forever.
        armed = false;
        reentryAttempted = true;

        if (mode == Mode.Settle) {
            try escrow.settle(targetQuoteHash, 1, bytes32(0)) {
                reentrySucceeded = true;
            } catch {}
        } else if (mode == Mode.Expire) {
            try escrow.expire(targetQuoteHash) {
                reentrySucceeded = true;
            } catch {}
        } else {
            try escrow.openAndFund(
                keccak256("reentrant-second-escrow"),
                address(0xBEEF),
                address(0),
                1,
                type(uint64).max
            ) {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
