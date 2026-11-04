// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The one fact the buffer reads from AguLab: whether AguLab is inside its roll right now.
interface IAguLabRollState {
    function rollInProgress() external view returns (bool);
}

/**
 * @title AguBuffer
 * @notice AGU-lab's first-loss buffer: a separate wallet of USDC that pays a roll's shortfall
 *         before NAV falls (docs/part5-build-plan.md §4.2, rules R6, R7 and R10).
 *
 * The buffer is its own contract, so its own address and its own ledger, never mixed with the
 * reserve: the reserve holds claims only and no USDC at rest, and the buffer holds USDC only.
 *
 * Money comes in two ways: `seed`, which pulls USDC from whoever calls it (the owner seeds it
 * once), and positive carry, which AguLab's roll sends as a plain transfer up to `target`. Money
 * goes out one way: `cover`, callable only by AguLab and only while AguLab's roll is in progress,
 * to AguLab itself. There is no owner, no withdrawal, no sweep and no setter; `target` is
 * immutable. So the buffer can never be paid out on a redemption (redemption has no path to it),
 * never be touched by the participant, and never be emptied by anyone but a roll's shortfall.
 *
 * `target` bounds only what carry tops it up to. A seed above the target is accepted; carry then
 * goes to the issuer's income ledger until a shortfall brings the buffer back below the target.
 */
contract AguBuffer {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    /// @notice The only contract that may draw cover. Immutable, set to AguLab's predicted
    ///         address at construction (AguLab checks it points back at itself).
    address public immutable aguLab;

    /// @notice The level positive carry tops the buffer up to, in USDC base units.
    uint256 public immutable target;

    event Seeded(address indexed from, uint256 amount);
    event Covered(address indexed aguLab, uint256 amount);

    error UsdcZero();
    error AguLabZero();
    error ZeroAmount();
    error OnlyAguLab(address caller);
    /// @notice Cover is roll cost, paid inside the roll step and nowhere else.
    error NotInsideRoll();

    constructor(IERC20 usdc_, address aguLab_, uint256 target_) {
        if (address(usdc_) == address(0)) revert UsdcZero();
        if (aguLab_ == address(0)) revert AguLabZero();
        usdc = usdc_;
        aguLab = aguLab_;
        target = target_;
    }

    /// @notice Adds `amount` of the caller's own USDC to the buffer.
    function seed(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        emit Seeded(msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /**
     * @notice Pays `amount` to AguLab to cover a roll's shortfall.
     * @dev Two checks, both required: the caller is AguLab, and AguLab reports its roll in
     *      progress. AguLab calls this from inside `roll` only, so the second check is defence in
     *      depth: it holds even if a later AguLab gained another path to this call.
     */
    function cover(uint256 amount) external {
        if (msg.sender != aguLab) revert OnlyAguLab(msg.sender);
        if (!IAguLabRollState(aguLab).rollInProgress()) revert NotInsideRoll();
        if (amount == 0) revert ZeroAmount();
        emit Covered(aguLab, amount);
        usdc.safeTransfer(aguLab, amount);
    }
}
