// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TouchstoneEscrow} from "../src/TouchstoneEscrow.sol";
import {TouchstoneAttestation} from "../src/TouchstoneAttestation.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * CLAUDE.md's second hard invariant: "No admin path to user money exists in any code path."
 *
 * A test that merely calls `owner()` and sees it revert proves very little — it only shows that
 * one guessed name is absent. These tests instead assert the property structurally, from the
 * compiled artifact and the deployed bytecode:
 *
 *  1. The set of state-mutating functions in the ABI is *exactly* the three known-safe ones.
 *     Any future fee setter, treasury setter, settler mutator, pause, sweep or withdraw fails
 *     this test until a human consciously edits the allowlist below — which is the point.
 *  2. There is no `receive` or `fallback`, so ETH cannot enter and cannot become stranded.
 *  3. The deployed bytecode contains no DELEGATECALL, CALLCODE or SELFDESTRUCT, scanned
 *     opcode-aware so PUSH immediates can't produce a false match. That rules out a proxy or
 *     upgrade path and any self-destruct escape hatch — neither of which is visible in an ABI.
 *
 * Note this file deliberately reads `out/`, so it is asserting against what the compiler
 * actually produced rather than against the source it was written alongside.
 */
contract NoAdminPathTest is Test {
    using stdJson for string;

    TouchstoneEscrow internal escrow;
    TouchstoneAttestation internal attestation;
    MockUSDC internal usdc;

    address internal treasury = makeAddr("treasury");
    address internal publisher = makeAddr("publisher");

    function setUp() public {
        usdc = new MockUSDC();
        escrow = new TouchstoneEscrow(IERC20(address(usdc)), treasury, 50);
        attestation = new TouchstoneAttestation(publisher);
    }

    // ------------------------------------------------------------------ helpers

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    /// forge-std's JSON cheatcodes reject `[*]` wildcards and `[?(...)]` filters ("must return
    /// exactly one JSON value"), so the ABI array is walked by index instead.
    function _abiEntryCount(string memory json) internal view returns (uint256 count) {
        while (vm.keyExistsJson(json, string.concat(".abi[", vm.toString(count), "].type"))) {
            count++;
        }
    }

    /// Every function in the ABI whose stateMutability is neither `view` nor `pure` — i.e. every
    /// function that can change state or move value.
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
            string memory base = string.concat(".abi[", vm.toString(i), "]");
            if (!_eq(json.readString(string.concat(base, ".type")), "function")) continue;

            string memory mutability = json.readString(string.concat(base, ".stateMutability"));
            if (_eq(mutability, "view") || _eq(mutability, "pure")) continue;

            found[n++] = json.readString(string.concat(base, ".name"));
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
            string memory t = json.readString(string.concat(".abi[", vm.toString(i), "].type"));
            if (_eq(t, entryType)) return true;
        }
        return false;
    }

    /// Opcode-aware scan: PUSH1..PUSH32 immediates are skipped so a 0xF4 or 0xFF byte sitting
    /// inside push data is never mistaken for an instruction.
    function _usesOpcode(bytes memory code, uint8 target) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == target) return true;
            if (op >= 0x60 && op <= 0x7F) {
                i += uint256(op) - 0x5F; // skip the immediate
            }
            i++;
        }
        return false;
    }

    // ------------------------------------------------------------------ TouchstoneEscrow

    function test_escrow_hasExactlyThreeStateMutatingFunctions() public view {
        string[] memory names = _mutatingFunctions("out/TouchstoneEscrow.sol/TouchstoneEscrow.json");

        assertEq(
            names.length,
            3,
            "TouchstoneEscrow gained or lost a state-mutating function. If this is intentional, it "
            "must be reviewed against CLAUDE.md's no-admin-path invariant before the allowlist "
            "below is changed."
        );
        assertTrue(_contains(names, "openAndFund"), "openAndFund must exist");
        assertTrue(_contains(names, "settle"), "settle must exist");
        assertTrue(_contains(names, "expire"), "expire must exist");
    }

    /// Belt and braces alongside the exact-count assertion above: the specific shapes an admin
    /// backdoor usually takes are named and asserted absent, so a reviewer reading only this
    /// test still sees what is being ruled out.
    function test_escrow_hasNoAdminShapedFunction() public view {
        string[] memory names = _mutatingFunctions("out/TouchstoneEscrow.sol/TouchstoneEscrow.json");

        string[18] memory forbidden = [
            "setFeeBps",
            "setTreasury",
            "setSettler",
            "setToken",
            "setOwner",
            "transferOwnership",
            "renounceOwnership",
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
            "migrate"
        ];

        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(
                _contains(names, forbidden[i]),
                string.concat("TouchstoneEscrow must not expose ", forbidden[i])
            );
        }
    }

    function test_escrow_hasNoReceiveOrFallback() public view {
        assertFalse(
            _hasAbiEntryOfType("out/TouchstoneEscrow.sol/TouchstoneEscrow.json", "receive"),
            "no receive: ETH must not be able to enter and become stranded"
        );
        assertFalse(
            _hasAbiEntryOfType("out/TouchstoneEscrow.sol/TouchstoneEscrow.json", "fallback"), "no fallback"
        );
    }

    function test_escrow_bytecodeHasNoDelegatecallOrSelfdestruct() public view {
        bytes memory code = address(escrow).code;
        assertGt(code.length, 0, "sanity: contract is deployed");
        assertFalse(_usesOpcode(code, 0xF4), "DELEGATECALL would allow a proxy/upgrade path");
        assertFalse(_usesOpcode(code, 0xF2), "CALLCODE would allow foreign code over this state");
        assertFalse(_usesOpcode(code, 0xFF), "SELFDESTRUCT would be an escape hatch");
    }

    /// The immutables that define where money can go are readable, stable, and have no setter.
    function test_escrow_immutablesCannotBeChanged() public view {
        assertEq(escrow.treasury(), treasury);
        assertEq(escrow.feeBps(), 50);
        assertEq(address(escrow.token()), address(usdc));

        // Proven structurally above by the exact-three-mutating-functions assertion: there is no
        // function that could write any of these, so re-reading them can only ever agree.
        string[] memory names = _mutatingFunctions("out/TouchstoneEscrow.sol/TouchstoneEscrow.json");
        assertEq(names.length, 3);
    }

    // ------------------------------------------------------------------ TouchstoneAttestation

    function test_attestation_hasExactlyOneStateMutatingFunction() public view {
        string[] memory names = _mutatingFunctions("out/TouchstoneAttestation.sol/TouchstoneAttestation.json");
        assertEq(names.length, 1, "TouchstoneAttestation must expose only postPrint");
        assertTrue(_contains(names, "postPrint"));
    }

    function test_attestation_hasNoPublisherRotationOrAdmin() public view {
        string[] memory names = _mutatingFunctions("out/TouchstoneAttestation.sol/TouchstoneAttestation.json");
        string[6] memory forbidden = [
            "setPublisher",
            "transferOwnership",
            "renounceOwnership",
            "pause",
            "initialize",
            "upgradeTo"
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            assertFalse(_contains(names, forbidden[i]));
        }
    }

    function test_attestation_bytecodeHasNoDelegatecallOrSelfdestruct() public view {
        bytes memory code = address(attestation).code;
        assertGt(code.length, 0);
        assertFalse(_usesOpcode(code, 0xF4), "DELEGATECALL would allow a proxy/upgrade path");
        assertFalse(_usesOpcode(code, 0xF2));
        assertFalse(_usesOpcode(code, 0xFF));
    }
}
