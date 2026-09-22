// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {
    IERC1155MetadataURI
} from "@openzeppelin/contracts/token/ERC1155/extensions/IERC1155MetadataURI.sol";
import {ERC1155Utils} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Utils.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {IERC165, ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/**
 * @title MinimalERC1155
 * @notice A standards-compliant ERC-1155 base, deliberately not OpenZeppelin's own
 *         `ERC1155.sol` — that file (v5.7.0, this repo's pinned version) imports
 *         `utils/Arrays.sol` for an internal micro-optimisation
 *         (`Arrays.unsafeMemoryAccess`), and that file uses the `mcopy` opcode
 *         unconditionally in unrelated functions the same file also defines. `mcopy` is a
 *         Cancun opcode; this repo pins `evm_version = "shanghai"` deliberately, so Arc stays a
 *         deployment target rather than a rewrite (foundry.toml's own comment). The whole file
 *         fails to compile under Shanghai regardless of which functions are actually called.
 *
 * This is not a new dependency or a fork of OpenZeppelin's logic — every interface, error type,
 * and the receiver-acceptance-check library (`ERC1155Utils`) below are OpenZeppelin's own,
 * imported directly and confirmed not to import `Arrays.sol` themselves. Only the storage,
 * transfer and mint/burn logic is reimplemented here, mirroring `ERC1155.sol`'s own semantics
 * function-for-function, with plain array indexing in place of `Arrays.unsafeMemoryAccess` (a
 * gas micro-optimisation, not a behavioural difference).
 */
abstract contract MinimalERC1155 is Context, ERC165, IERC1155, IERC1155MetadataURI, IERC1155Errors {
    mapping(uint256 id => mapping(address account => uint256)) private _balances;
    mapping(address account => mapping(address operator => bool)) private _operatorApprovals;
    string private _uri;

    constructor(string memory uri_) {
        _uri = uri_;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC165, IERC165)
        returns (bool)
    {
        return interfaceId == type(IERC1155).interfaceId
            || interfaceId == type(IERC1155MetadataURI).interfaceId
            || super.supportsInterface(interfaceId);
    }

    function uri(
        uint256 /* id */
    )
        public
        view
        virtual
        returns (string memory)
    {
        return _uri;
    }

    function balanceOf(address account, uint256 id) public view virtual returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] memory accounts, uint256[] memory ids)
        public
        view
        virtual
        returns (uint256[] memory)
    {
        if (accounts.length != ids.length) {
            revert ERC1155InvalidArrayLength(ids.length, accounts.length);
        }
        uint256[] memory batchBalances = new uint256[](accounts.length);
        for (uint256 i = 0; i < accounts.length; ++i) {
            batchBalances[i] = balanceOf(accounts[i], ids[i]);
        }
        return batchBalances;
    }

    function setApprovalForAll(address operator, bool approved) public virtual {
        _setApprovalForAll(_msgSender(), operator, approved);
    }

    function isApprovedForAll(address account, address operator)
        public
        view
        virtual
        returns (bool)
    {
        return _operatorApprovals[account][operator];
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public virtual {
        _checkAuthorized(_msgSender(), from);
        if (to == address(0)) revert ERC1155InvalidReceiver(address(0));
        if (from == address(0)) revert ERC1155InvalidSender(address(0));
        (uint256[] memory ids, uint256[] memory values) = _asSingletonArrays(id, value);
        _updateWithAcceptanceCheck(from, to, ids, values, data, false);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public virtual {
        _checkAuthorized(_msgSender(), from);
        if (to == address(0)) revert ERC1155InvalidReceiver(address(0));
        if (from == address(0)) revert ERC1155InvalidSender(address(0));
        _updateWithAcceptanceCheck(from, to, ids, values, data, true);
    }

    function _checkAuthorized(address operator, address owner) internal view virtual {
        if (owner != operator && !isApprovedForAll(owner, operator)) {
            revert ERC1155MissingApprovalForAll(operator, owner);
        }
    }

    /// @dev Mirrors ERC1155.sol's own `_update` exactly, plain indexing in place of
    ///      `Arrays.unsafeMemoryAccess`. No acceptance check here — see
    ///      `_updateWithAcceptanceCheck`.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        virtual
    {
        if (ids.length != values.length) {
            revert ERC1155InvalidArrayLength(ids.length, values.length);
        }

        address operator = _msgSender();

        for (uint256 i = 0; i < ids.length; ++i) {
            uint256 id = ids[i];
            uint256 value = values[i];

            if (from != address(0)) {
                uint256 fromBalance = _balances[id][from];
                if (fromBalance < value) {
                    revert ERC1155InsufficientBalance(from, fromBalance, value, id);
                }
                unchecked {
                    _balances[id][from] = fromBalance - value;
                }
            }

            if (to != address(0)) {
                _balances[id][to] += value;
            }
        }

        if (ids.length == 1) {
            emit TransferSingle(operator, from, to, ids[0], values[0]);
        } else {
            emit TransferBatch(operator, from, to, ids, values);
        }
    }

    function _updateWithAcceptanceCheck(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data,
        bool batch
    ) internal virtual {
        _update(from, to, ids, values);
        if (to != address(0)) {
            address operator = _msgSender();
            if (batch) {
                ERC1155Utils.checkOnERC1155BatchReceived(operator, from, to, ids, values, data);
            } else {
                ERC1155Utils.checkOnERC1155Received(operator, from, to, ids[0], values[0], data);
            }
        }
    }

    function _mint(address to, uint256 id, uint256 value, bytes memory data) internal {
        if (to == address(0)) revert ERC1155InvalidReceiver(address(0));
        (uint256[] memory ids, uint256[] memory values) = _asSingletonArrays(id, value);
        _updateWithAcceptanceCheck(address(0), to, ids, values, data, false);
    }

    function _burn(address from, uint256 id, uint256 value) internal {
        if (from == address(0)) revert ERC1155InvalidSender(address(0));
        (uint256[] memory ids, uint256[] memory values) = _asSingletonArrays(id, value);
        _updateWithAcceptanceCheck(from, address(0), ids, values, "", false);
    }

    function _setApprovalForAll(address owner, address operator, bool approved) internal virtual {
        if (owner == address(0)) revert ERC1155InvalidApprover(address(0));
        if (operator == address(0)) revert ERC1155InvalidOperator(address(0));
        _operatorApprovals[owner][operator] = approved;
        emit ApprovalForAll(owner, operator, approved);
    }

    function _asSingletonArrays(uint256 element1, uint256 element2)
        private
        pure
        returns (uint256[] memory array1, uint256[] memory array2)
    {
        array1 = new uint256[](1);
        array1[0] = element1;
        array2 = new uint256[](1);
        array2[0] = element2;
    }
}
