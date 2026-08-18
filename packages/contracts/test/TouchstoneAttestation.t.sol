// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TouchstoneAttestation} from "../src/TouchstoneAttestation.sol";

contract TouchstoneAttestationTest is Test {
    TouchstoneAttestation internal attestation;

    address internal publisher = makeAddr("publisher");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BODY_HASH = keccak256("print-body");
    string internal constant VERSION = "SIU-2026a";

    function setUp() public {
        attestation = new TouchstoneAttestation(publisher);
    }

    function test_constructor_setsPublisher() public view {
        assertEq(attestation.publisher(), publisher);
    }

    function test_constructor_revertsOnZeroPublisher() public {
        vm.expectRevert(TouchstoneAttestation.PublisherZero.selector);
        new TouchstoneAttestation(address(0));
    }

    function test_postPrint_recordsTimestamp() public {
        vm.warp(1_700_000_000);
        vm.prank(publisher);
        attestation.postPrint(BODY_HASH, VERSION);

        assertEq(attestation.postedAt(BODY_HASH), 1_700_000_000);
        assertTrue(attestation.isPosted(BODY_HASH));
    }

    function test_postPrint_emitsPrintPosted() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, true, true, address(attestation));
        emit TouchstoneAttestation.PrintPosted(BODY_HASH, VERSION, 1_700_000_000);
        vm.prank(publisher);
        attestation.postPrint(BODY_HASH, VERSION);
    }

    function test_postPrint_revertsForNonPublisher() public {
        vm.prank(stranger);
        vm.expectRevert(TouchstoneAttestation.NotPublisher.selector);
        attestation.postPrint(BODY_HASH, VERSION);
    }

    function testFuzz_postPrint_revertsForEveryNonPublisher(address caller) public {
        vm.assume(caller != publisher);
        vm.prank(caller);
        vm.expectRevert(TouchstoneAttestation.NotPublisher.selector);
        attestation.postPrint(BODY_HASH, VERSION);
    }

    function test_postPrint_revertsOnZeroBodyHash() public {
        vm.prank(publisher);
        vm.expectRevert(TouchstoneAttestation.BodyHashZero.selector);
        attestation.postPrint(bytes32(0), VERSION);
    }

    function test_postPrint_revertsOnEmptyVersion() public {
        vm.prank(publisher);
        vm.expectRevert(TouchstoneAttestation.VersionEmpty.selector);
        attestation.postPrint(BODY_HASH, "");
    }

    /// The recorded timestamp is the fact this contract exists to establish. Overwriting it
    /// would destroy evidence rather than add to it.
    function test_postPrint_revertsOnReAnchoringTheSameHash() public {
        vm.startPrank(publisher);
        attestation.postPrint(BODY_HASH, VERSION);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(TouchstoneAttestation.AlreadyPosted.selector);
        attestation.postPrint(BODY_HASH, VERSION);
        vm.stopPrank();
    }

    function test_postPrint_originalTimestampSurvivesAReAnchorAttempt() public {
        vm.warp(1_700_000_000);
        vm.prank(publisher);
        attestation.postPrint(BODY_HASH, VERSION);

        vm.warp(1_800_000_000);
        vm.prank(publisher);
        vm.expectRevert(TouchstoneAttestation.AlreadyPosted.selector);
        attestation.postPrint(BODY_HASH, VERSION);

        assertEq(attestation.postedAt(BODY_HASH), 1_700_000_000, "first anchor time is preserved");
    }

    function test_postPrint_acceptsDistinctHashes() public {
        vm.startPrank(publisher);
        attestation.postPrint(keccak256("a"), VERSION);
        attestation.postPrint(keccak256("b"), "SIU-2027a");
        vm.stopPrank();

        assertTrue(attestation.isPosted(keccak256("a")));
        assertTrue(attestation.isPosted(keccak256("b")));
    }

    function test_unpostedHashReadsAsZero() public view {
        assertEq(attestation.postedAt(keccak256("never")), 0);
        assertFalse(attestation.isPosted(keccak256("never")));
    }
}
