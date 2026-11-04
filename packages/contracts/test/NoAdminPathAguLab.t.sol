// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {AguLab} from "../src/AguLab.sol";
import {AguBuffer} from "../src/AguBuffer.sol";
import {EligibleClaimRouter} from "../src/EligibleClaimRouter.sol";
import {AguLabFixture} from "./fixtures/AguLabFixture.sol";

/**
 * R2 (docs/part5-build-plan.md §4.3) and CLAUDE.md's second hard invariant, for the three CR
 * economy contracts: AguLab, AguBuffer and EligibleClaimRouter. Same method as NoAdminPath.t.sol,
 * asserted from the compiled ABI and the deployed bytecode rather than from comments:
 *
 *  1. The set of state-mutating functions is exactly the known one. Anything added (a setter, a
 *     sweep, a pause, an owner) fails here until a person edits the allowlist on purpose.
 *  2. Each privileged function refuses everyone but its one immutable role.
 *  3. No receive or fallback, and no DELEGATECALL, CALLCODE or SELFDESTRUCT in the bytecode.
 *
 * Plus two facts about AguLab that only the bytecode can show: it never calls
 * `presentForRedemption` (a front lot it does not sell must expire, never default, so the issuer's
 * bond is never drawn for the reserve) and never calls `setApprovalForAll` (no operator is ever
 * handed power over the reserve's claims). The helpers are copied from NoAdminPath.t.sol rather
 * than inherited, so that file's own tests are not run a second time from this contract.
 */
contract NoAdminPathAguLabTest is AguLabFixture {
    using stdJson for string;

    string internal constant LAB_ABI = "out/AguLab.sol/AguLab.json";
    string internal constant BUFFER_ABI = "out/AguBuffer.sol/AguBuffer.json";
    string internal constant ROUTER_ABI = "out/EligibleClaimRouter.sol/EligibleClaimRouter.json";

    // ------------------------------------------------------------------ helpers

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _abiEntryCount(string memory json) internal view returns (uint256 count) {
        while (vm.keyExistsJson(json, string.concat(".abi[", vm.toString(count), "].type"))) {
            count++;
        }
    }

    function _mutatingFunctions(string memory artifactPath)
        internal
        view
        returns (string[] memory names)
    {
        string memory json = vm.readFile(artifactPath);
        uint256 count = _abiEntryCount(json);
        string[] memory found = new string[](count);
        uint256 n = 0;
        for (uint256 i = 0; i < count; i++) {
            string memory entry = string.concat(".abi[", vm.toString(i), "]");
            if (!_eq(json.readString(string.concat(entry, ".type")), "function")) continue;
            string memory mutability = json.readString(string.concat(entry, ".stateMutability"));
            if (_eq(mutability, "view") || _eq(mutability, "pure")) continue;
            found[n++] = json.readString(string.concat(entry, ".name"));
        }
        names = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            names[i] = found[i];
        }
    }

    function _contains(string[] memory haystack, string memory needle)
        internal
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (_eq(haystack[i], needle)) return true;
        }
        return false;
    }

    function _hasAbiEntryOfType(string memory artifactPath, string memory entryType)
        internal
        view
        returns (bool)
    {
        string memory json = vm.readFile(artifactPath);
        uint256 count = _abiEntryCount(json);
        for (uint256 i = 0; i < count; i++) {
            if (_eq(json.readString(string.concat(".abi[", vm.toString(i), "].type")), entryType)) {
                return true;
            }
        }
        return false;
    }

    function _usesOpcode(bytes memory code, uint8 target) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == target) return true;
            if (op >= 0x60 && op <= 0x7F) i += uint256(op) - 0x5F;
            i++;
        }
        return false;
    }

    /// Opcode-aware: true when `selector` appears as the immediate of a PUSH4, which is how solc
    /// encodes the selector of an external call it makes.
    function _pushesSelector(bytes memory code, bytes4 selector) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0x63 && i + 4 < code.length) {
                bytes4 imm = bytes4(
                    (uint32(uint8(code[i + 1])) << 24) | (uint32(uint8(code[i + 2])) << 16)
                        | (uint32(uint8(code[i + 3])) << 8) | uint32(uint8(code[i + 4]))
                );
                if (imm == selector) return true;
            }
            if (op >= 0x60 && op <= 0x7F) i += uint256(op) - 0x5F;
            i++;
        }
        return false;
    }

    function _assertNoAdminShapedFunction(string memory artifactPath, string memory label)
        internal
        view
    {
        string[] memory names = _mutatingFunctions(artifactPath);
        string[20] memory forbidden = [
            "setOwner",
            "transferOwnership",
            "renounceOwnership",
            "setTarget",
            "setDiscountBps",
            "setParticipant",
            "setIssuer",
            "setPublisher",
            "setIncomeLedger",
            "withdraw",
            "emergencyWithdraw",
            "rescue",
            "rescueTokens",
            "sweep",
            "pause",
            "unpause",
            "upgradeTo",
            "upgradeToAndCall",
            "initialize",
            "mint"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(
                _contains(names, forbidden[i]),
                string.concat("R2: ", label, " must not expose ", forbidden[i])
            );
        }
    }

    function _assertCleanBytecode(address target) internal view {
        bytes memory code = target.code;
        assertGt(code.length, 0, "sanity: deployed");
        assertFalse(_usesOpcode(code, 0xF4), "DELEGATECALL would allow a proxy/upgrade path");
        assertFalse(_usesOpcode(code, 0xF2), "CALLCODE would allow foreign code over this state");
        assertFalse(_usesOpcode(code, 0xFF), "SELFDESTRUCT would be an escape hatch");
    }

    // ------------------------------------------------------------------ AguLab

    /// create (participant), roll (AGU-lab issuer), redeem (any holder, own units), and the
    /// ERC-20 standard's own three. The ERC-1155 receiver hooks are `view`/`pure` (they only
    /// accept what AguLab pulls itself), so they are not in this set at all.
    function test_aguLab_hasExactlySixStateMutatingFunctions() public view {
        string[] memory names = _mutatingFunctions(LAB_ABI);
        assertEq(names.length, 6, "R2: AguLab gained or lost a state-mutating function");
        assertTrue(_contains(names, "create"));
        assertTrue(_contains(names, "redeem"));
        assertTrue(_contains(names, "roll"));
        assertTrue(_contains(names, "transfer"));
        assertTrue(_contains(names, "transferFrom"));
        assertTrue(_contains(names, "approve"));
    }

    function test_aguLab_hasNoAdminShapedFunction() public view {
        _assertNoAdminShapedFunction(LAB_ABI, "AguLab");
    }

    function test_aguLab_privilegedFunctionsRefuseEveryoneButTheirRole() public {
        address[5] memory outsiders = [agent1, holder, publisher, incomeLedger, address(this)];
        AguLab.RollOrder memory order;
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(AguLab.NotParticipant.selector, outsiders[i]));
            vm.prank(outsiders[i]);
            lab.create(1, 1);
            vm.expectRevert(abi.encodeWithSelector(AguLab.NotAguIssuer.selector, outsiders[i]));
            vm.prank(outsiders[i]);
            lab.roll(order, _att(RATE, SERIES_COMMODITY), "", "");
        }
        // And each role has only its own function: the participant cannot roll, the AGU-lab
        // issuer cannot create.
        vm.expectRevert(abi.encodeWithSelector(AguLab.NotAguIssuer.selector, participant));
        vm.prank(participant);
        lab.roll(order, _att(RATE, SERIES_COMMODITY), "", "");
        vm.expectRevert(abi.encodeWithSelector(AguLab.NotParticipant.selector, aguIssuer));
        vm.prank(aguIssuer);
        lab.create(1, 1);
    }

    function test_aguLab_hasNoReceiveOrFallback() public view {
        assertFalse(_hasAbiEntryOfType(LAB_ABI, "receive"), "no receive: ETH must not strand");
        assertFalse(_hasAbiEntryOfType(LAB_ABI, "fallback"), "no fallback");
    }

    function test_aguLab_bytecodeHasNoDelegatecallOrSelfdestruct() public view {
        _assertCleanBytecode(address(lab));
    }

    /// The reserve never presents a claim, so a front lot it does not sell expires (no bond
    /// draw) rather than defaulting; and it never approves an operator over its claims. The
    /// positive control proves the scan finds a selector AguLab really does call.
    function test_aguLab_neverPresentsAClaimNorApprovesAnOperator() public view {
        bytes memory code = address(lab).code;
        assertTrue(
            _pushesSelector(
                code, bytes4(keccak256("safeTransferFrom(address,address,uint256,uint256,bytes)"))
            ),
            "sanity: the scan finds a selector AguLab does call"
        );
        assertFalse(
            _pushesSelector(code, bytes4(keccak256("presentForRedemption(uint256,bytes32)"))),
            "AguLab must never present a claim: unsold front lots expire, never default"
        );
        assertFalse(
            _pushesSelector(code, bytes4(keccak256("setApprovalForAll(address,bool)"))),
            "AguLab must never hand an operator power over the reserve's claims"
        );
        assertFalse(
            _pushesSelector(
                code, bytes4(keccak256("serveRedemption(uint256,address,uint256,bool,bytes32)"))
            ),
            "AguLab has no part in serving a redemption"
        );
    }

    /// Invariant 7 (verified-work proofs feed receipts and reputation, never supply): `create`
    /// takes a claim and a face amount and nothing else, so no gate verdict or proof can be an
    /// input to how much AGU-lab exists.
    function test_aguLab_createTakesNoVerdictOrProof() public view {
        string memory json = vm.readFile(LAB_ABI);
        uint256 count = _abiEntryCount(json);
        bool found;
        for (uint256 i = 0; i < count; i++) {
            string memory entry = string.concat(".abi[", vm.toString(i), "]");
            if (!_eq(json.readString(string.concat(entry, ".type")), "function")) continue;
            if (!_eq(json.readString(string.concat(entry, ".name")), "create")) continue;
            found = true;
            assertFalse(
                vm.keyExistsJson(json, string.concat(entry, ".inputs[2]")),
                "invariant 7: create must take exactly a claim and a face amount"
            );
            assertEq(json.readString(string.concat(entry, ".inputs[0].type")), "uint256");
            assertEq(json.readString(string.concat(entry, ".inputs[1].type")), "uint256");
        }
        assertTrue(found, "create must exist");
    }

    function test_aguLab_immutablesCannotBeChanged() public view {
        assertEq(lab.aguIssuer(), aguIssuer);
        assertEq(lab.participant(), participant);
        assertEq(lab.incomeLedger(), incomeLedger);
        assertEq(address(lab.buffer()), address(buffer));
        assertEq(address(lab.workClaim()), address(workClaim));
        assertEq(lab.discountBps(), DISCOUNT_BPS);
        assertEq(_mutatingFunctions(LAB_ABI).length, 6);
    }

    // ------------------------------------------------------------------ AguBuffer

    /// seed (anyone, their own USDC in) and cover (AguLab only, only inside its roll). Nothing
    /// else can move the buffer's USDC.
    function test_aguBuffer_hasExactlyTwoStateMutatingFunctions() public view {
        string[] memory names = _mutatingFunctions(BUFFER_ABI);
        assertEq(names.length, 2, "R2: AguBuffer gained or lost a state-mutating function");
        assertTrue(_contains(names, "seed"));
        assertTrue(_contains(names, "cover"));
    }

    function test_aguBuffer_hasNoAdminShapedFunction() public view {
        _assertNoAdminShapedFunction(BUFFER_ABI, "AguBuffer");
    }

    function test_aguBuffer_coverRefusesEveryoneButAguLabInsideARoll() public {
        address[6] memory outsiders =
            [agent1, holder, publisher, participant, aguIssuer, incomeLedger];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(AguBuffer.OnlyAguLab.selector, outsiders[i]));
            vm.prank(outsiders[i]);
            buffer.cover(1);
        }
        vm.expectRevert(AguBuffer.NotInsideRoll.selector);
        vm.prank(address(lab));
        buffer.cover(1);
    }

    function test_aguBuffer_hasNoReceiveOrFallback() public view {
        assertFalse(_hasAbiEntryOfType(BUFFER_ABI, "receive"));
        assertFalse(_hasAbiEntryOfType(BUFFER_ABI, "fallback"));
    }

    function test_aguBuffer_bytecodeHasNoDelegatecallOrSelfdestruct() public view {
        _assertCleanBytecode(address(buffer));
    }

    // ------------------------------------------------------------------ EligibleClaimRouter

    /// setSkipped and setProbe (publisher only). `route` is a view; the router holds no funds.
    function test_router_hasExactlyTwoStateMutatingFunctions() public view {
        string[] memory names = _mutatingFunctions(ROUTER_ABI);
        assertEq(names.length, 2, "R11: EligibleClaimRouter gained or lost a mutating function");
        assertTrue(_contains(names, "setSkipped"));
        assertTrue(_contains(names, "setProbe"));
    }

    function test_router_hasNoAdminShapedFunction() public view {
        _assertNoAdminShapedFunction(ROUTER_ABI, "EligibleClaimRouter");
    }

    function test_router_flagsRefuseEveryoneButThePublisher() public {
        address[5] memory outsiders = [agent1, aguIssuer, participant, issuerA, address(lab)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(EligibleClaimRouter.OnlyPublisher.selector, outsiders[i])
            );
            vm.prank(outsiders[i]);
            router.setSkipped(issuerA, true);
            vm.expectRevert(
                abi.encodeWithSelector(EligibleClaimRouter.OnlyPublisher.selector, outsiders[i])
            );
            vm.prank(outsiders[i]);
            router.setProbe(issuerA, false);
        }
    }

    function test_router_hasNoReceiveOrFallback() public view {
        assertFalse(_hasAbiEntryOfType(ROUTER_ABI, "receive"));
        assertFalse(_hasAbiEntryOfType(ROUTER_ABI, "fallback"));
    }

    function test_router_bytecodeHasNoDelegatecallOrSelfdestruct() public view {
        _assertCleanBytecode(address(router));
    }

    function test_router_holdsNoFunds() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }
}
