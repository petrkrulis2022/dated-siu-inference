// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {AguLab} from "../../src/AguLab.sol";
import {RateAttestationVerifier} from "../../src/RateAttestationVerifier.sol";

/**
 * @notice A hostile claims receiver: when AguLab hands it work claims (a roll's front-claim sale,
 *         or an in-kind redemption), it calls back into AguLab from inside the ERC-1155 receiver
 *         hook, which is the one point where AguLab's own calls give control to someone else.
 *
 * Same discipline as ReentrantToken.sol: the re-entry is wrapped in try/catch and its outcome
 * recorded rather than bubbled, so the test can assert the specific fact that matters (the
 * re-entrant call was attempted and refused) instead of "the transaction reverted", which would
 * also pass against a contract with no guard at all if the hook simply broke the transfer.
 */
contract ReentrantClaimReceiver is IERC1155Receiver {
    enum Mode {
        None,
        Redeem,
        Create,
        Roll
    }

    AguLab public immutable lab;
    Mode public mode;
    bool public attempted;
    bool public succeeded;
    bytes public lastError;

    constructor(AguLab lab_) {
        lab = lab_;
    }

    function arm(Mode mode_) external {
        mode = mode_;
    }

    function approve(IERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }

    function redeem(uint256 units) external {
        lab.redeem(units);
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (mode != Mode.None && !attempted) {
            attempted = true;
            _reenter(id);
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function _reenter(uint256 id) internal {
        if (mode == Mode.Redeem) {
            try lab.redeem(1) {
                succeeded = true;
            } catch (bytes memory err) {
                lastError = err;
            }
        } else if (mode == Mode.Create) {
            try lab.create(id, 1) returns (uint256) {
                succeeded = true;
            } catch (bytes memory err) {
                lastError = err;
            }
        } else if (mode == Mode.Roll) {
            AguLab.RollOrder memory order;
            RateAttestationVerifier.RateAttestation memory att;
            try lab.roll(order, att, "", "") {
                succeeded = true;
            } catch (bytes memory err) {
                lastError = err;
            }
        }
    }
}
