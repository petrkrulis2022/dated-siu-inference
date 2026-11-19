// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TouchstoneAttestationV2} from "../src/TouchstoneAttestationV2.sol";

contract TouchstoneAttestationV2Test is Test {
    TouchstoneAttestationV2 internal attestation;

    /// A real secp256k1 key/signature pair via vm.sign, not a stub — same discipline as
    /// WorkClaim.t.sol's rate-attestation signing and packages/print/src/sign/sign.test.ts.
    uint256 internal constant PUBLISHER_PK = 0xA11CE;
    address internal publisher = vm.addr(PUBLISHER_PK);

    uint256 internal constant OTHER_PK = 0xB0B;
    address internal otherSigner = vm.addr(OTHER_PK);

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant BODY_HASH = keccak256("print-body");
    string internal constant VERSION = "SIU-2026a";
    string internal constant PRINT_DATE = "2026-10-24";
    string internal constant METHODOLOGY_VERSION = "v0-draft";

    function setUp() public {
        attestation = new TouchstoneAttestationV2(publisher, admin);
    }

    // ---- signing helper: recomputes the struct hash independently and reads the domain
    // separator live from the deployed contract, so this test can't silently drift from what the
    // contract actually verifies (same discipline as WorkClaim.t.sol's _signRate). ----

    function _sign(
        uint256 signerPk,
        bytes32 bodyHash,
        string memory version,
        string memory printDate,
        string memory methodologyVersion
    ) internal view returns (bytes memory signature) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PrintAttestation(bytes32 bodyHash,string version,string printDate,string methodologyVersion)"
                ),
                bodyHash,
                keccak256(bytes(version)),
                keccak256(bytes(printDate)),
                keccak256(bytes(methodologyVersion))
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", attestation.printAttestationDomainSeparator(), structHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _realSignature() internal view returns (bytes memory) {
        return _sign(PUBLISHER_PK, BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION);
    }

    // ---- constructor ----

    function test_constructor_setsPublisherAndAdmin() public view {
        assertEq(attestation.publisher(), publisher);
        assertEq(attestation.admin(), admin);
    }

    function test_constructor_revertsOnZeroPublisher() public {
        vm.expectRevert(TouchstoneAttestationV2.PublisherZero.selector);
        new TouchstoneAttestationV2(address(0), admin);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(TouchstoneAttestationV2.AdminZero.selector);
        new TouchstoneAttestationV2(publisher, address(0));
    }

    /// Two deployments with the same publisher but different addresses (hence different
    /// `verifyingContract`) must sign against different domains — otherwise a signature meant for
    /// one deployment would verify on another.
    function test_domainSeparator_differsAcrossDeployments() public {
        TouchstoneAttestationV2 other = new TouchstoneAttestationV2(publisher, admin);
        assertTrue(
            attestation.printAttestationDomainSeparator() != other.printAttestationDomainSeparator()
        );
    }

    /// Cross-checks the getter against an independently-computed value in the test, so a future
    /// accidental change to the EIP712Domain name/version string is caught even though nothing
    /// else in this file hand-duplicates the domain (the signing helper above reads it live).
    function test_domainSeparator_matchesIndependentComputation() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("TouchstoneAttestationV2")),
                keccak256(bytes("1")),
                block.chainid,
                address(attestation)
            )
        );
        assertEq(attestation.printAttestationDomainSeparator(), expected);
    }

    // ---- postPrint: anyone may relay a validly-signed print ----

    function test_postPrint_recordsTimestampWhenCalledByTheRelayer() public {
        vm.warp(1_700_000_000);
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, _realSignature());

        assertEq(attestation.postedAt(BODY_HASH), 1_700_000_000);
        assertTrue(attestation.isPosted(BODY_HASH));
    }

    function test_postPrint_worksForAnyCallerGivenAValidSignature() public {
        bytes memory sig = _realSignature();
        vm.prank(stranger);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
        assertTrue(attestation.isPosted(BODY_HASH));
    }

    function testFuzz_postPrint_worksForEveryCaller(address caller) public {
        bytes memory sig = _realSignature();
        vm.prank(caller);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
        assertTrue(attestation.isPosted(BODY_HASH));
    }

    function test_postPrint_emitsPrintPostedWithEveryField() public {
        vm.warp(1_700_000_000);
        vm.expectEmit(true, true, true, true, address(attestation));
        emit TouchstoneAttestationV2.PrintPosted(
            BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, 1_700_000_000
        );
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, _realSignature());
    }

    // ---- postPrint: the signature genuinely binds every field, not just bodyHash ----

    function test_postPrint_revertsOnSignatureFromANonPublisherKey() public {
        bytes memory sig = _sign(OTHER_PK, BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION);
        vm.expectRevert(
            abi.encodeWithSelector(
                TouchstoneAttestationV2.InvalidPublisherSignature.selector, otherSigner, publisher
            )
        );
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_revertsWhenBodyHashDoesNotMatchTheSignature() public {
        bytes memory sig = _realSignature();
        vm.expectRevert(); // recovers to an attacker-uncontrolled address, not `publisher`
        vm.prank(relayer);
        attestation.postPrint(
            keccak256("different-body"), VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig
        );
    }

    function test_postPrint_revertsWhenVersionDoesNotMatchTheSignature() public {
        bytes memory sig = _realSignature();
        vm.expectRevert();
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, "SIU-2027a", PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_revertsWhenPrintDateDoesNotMatchTheSignature() public {
        bytes memory sig = _realSignature();
        vm.expectRevert();
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, "2026-10-25", METHODOLOGY_VERSION, sig);
    }

    /// The field most likely to be forgotten by accident — this proves `methodologyVersion` is
    /// really inside the signed struct, not a trailing parameter the signature happens to ignore.
    function test_postPrint_revertsWhenMethodologyVersionDoesNotMatchTheSignature() public {
        bytes memory sig = _realSignature();
        vm.expectRevert();
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, "v1-draft", sig);
    }

    function test_postPrint_revertsOnASignatureFromTheWrongDomain() public {
        // Signs over the REAL fields but under a hand-built digest for a different chainId —
        // simulates a signature lifted from another deployment or another chain.
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "PrintAttestation(bytes32 bodyHash,string version,string printDate,string methodologyVersion)"
                ),
                BODY_HASH,
                keccak256(bytes(VERSION)),
                keccak256(bytes(PRINT_DATE)),
                keccak256(bytes(METHODOLOGY_VERSION))
            )
        );
        bytes32 wrongDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("TouchstoneAttestationV2")),
                keccak256(bytes("1")),
                block.chainid + 1, // wrong chain
                address(attestation)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wrongDomain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PUBLISHER_PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(); // recovers to an attacker-uncontrolled address under the REAL domain
        vm.prank(relayer);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    // ---- postPrint: the existing V1 field/replay guards, carried over ----

    function test_postPrint_revertsOnZeroBodyHash() public {
        // Signature computed BEFORE arming expectRevert: `_realSignature()` calls the `vm.sign`
        // cheatcode internally, an external call frame of its own — evaluating it inline as an
        // argument after expectRevert is armed lets that call, not the real postPrint call, be the
        // "next call" expectRevert checks (the same evaluation-order gotcha WorkClaim.t.sol's
        // `fixtureSeries` comment documents for vm.prank).
        bytes memory sig = _realSignature();
        vm.expectRevert(TouchstoneAttestationV2.BodyHashZero.selector);
        attestation.postPrint(bytes32(0), VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_revertsOnEmptyVersion() public {
        bytes memory sig = _sign(PUBLISHER_PK, BODY_HASH, "", PRINT_DATE, METHODOLOGY_VERSION);
        vm.expectRevert(TouchstoneAttestationV2.VersionEmpty.selector);
        attestation.postPrint(BODY_HASH, "", PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_revertsOnEmptyPrintDate() public {
        bytes memory sig = _sign(PUBLISHER_PK, BODY_HASH, VERSION, "", METHODOLOGY_VERSION);
        vm.expectRevert(TouchstoneAttestationV2.PrintDateEmpty.selector);
        attestation.postPrint(BODY_HASH, VERSION, "", METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_revertsOnEmptyMethodologyVersion() public {
        bytes memory sig = _sign(PUBLISHER_PK, BODY_HASH, VERSION, PRINT_DATE, "");
        vm.expectRevert(TouchstoneAttestationV2.MethodologyVersionEmpty.selector);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, "", sig);
    }

    function test_postPrint_revertsOnReAnchoringTheSameHash() public {
        bytes memory sig = _realSignature();
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(TouchstoneAttestationV2.AlreadyPosted.selector);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
    }

    function test_postPrint_originalTimestampSurvivesAReAnchorAttempt() public {
        vm.warp(1_700_000_000);
        bytes memory sig = _realSignature();
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);

        vm.warp(1_800_000_000);
        vm.expectRevert(TouchstoneAttestationV2.AlreadyPosted.selector);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);

        assertEq(attestation.postedAt(BODY_HASH), 1_700_000_000, "first anchor time is preserved");
    }

    function test_postPrint_acceptsDistinctHashes() public {
        attestation.postPrint(
            keccak256("a"),
            VERSION,
            PRINT_DATE,
            METHODOLOGY_VERSION,
            _sign(PUBLISHER_PK, keccak256("a"), VERSION, PRINT_DATE, METHODOLOGY_VERSION)
        );
        attestation.postPrint(
            keccak256("b"),
            "SIU-2027a",
            PRINT_DATE,
            METHODOLOGY_VERSION,
            _sign(PUBLISHER_PK, keccak256("b"), "SIU-2027a", PRINT_DATE, METHODOLOGY_VERSION)
        );

        assertTrue(attestation.isPosted(keccak256("a")));
        assertTrue(attestation.isPosted(keccak256("b")));
    }

    function test_unpostedHashReadsAsZero() public view {
        assertEq(attestation.postedAt(keccak256("never")), 0);
        assertFalse(attestation.isPosted(keccak256("never")));
    }

    // ---- rotatePublisher ----

    function test_rotatePublisher_onlyAdminMayCall() public {
        address newPublisher = makeAddr("newPublisher");
        vm.prank(admin);
        attestation.rotatePublisher(newPublisher);
        assertEq(attestation.publisher(), newPublisher);
    }

    function test_rotatePublisher_revertsForTheOldPublisherItself() public {
        vm.prank(publisher);
        vm.expectRevert(TouchstoneAttestationV2.NotAdmin.selector);
        attestation.rotatePublisher(makeAddr("newPublisher"));
    }

    function testFuzz_rotatePublisher_revertsForEveryNonAdmin(address caller) public {
        vm.assume(caller != admin);
        vm.prank(caller);
        vm.expectRevert(TouchstoneAttestationV2.NotAdmin.selector);
        attestation.rotatePublisher(makeAddr("newPublisher"));
    }

    function test_rotatePublisher_revertsOnZeroNewPublisher() public {
        vm.prank(admin);
        vm.expectRevert(TouchstoneAttestationV2.PublisherZero.selector);
        attestation.rotatePublisher(address(0));
    }

    function test_rotatePublisher_emitsPublisherRotated() public {
        address newPublisher = makeAddr("newPublisher");
        vm.expectEmit(true, true, true, true, address(attestation));
        emit TouchstoneAttestationV2.PublisherRotated(publisher, newPublisher);
        vm.prank(admin);
        attestation.rotatePublisher(newPublisher);
    }

    /// The entire point of rotation: a signature from the NEW key starts working, and a
    /// not-yet-posted signature from the OLD key stops working — both checked in one test so
    /// neither half can silently regress without the other.
    function test_rotatePublisher_oldSignatureStopsVerifyingAndNewSignatureStartsVerifying()
        public
    {
        bytes memory oldSig = _realSignature();

        vm.prank(admin);
        attestation.rotatePublisher(otherSigner);

        vm.expectRevert(
            abi.encodeWithSelector(
                TouchstoneAttestationV2.InvalidPublisherSignature.selector, publisher, otherSigner
            )
        );
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, oldSig);

        bytes memory newSig = _sign(OTHER_PK, BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION);
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, newSig);
        assertTrue(attestation.isPosted(BODY_HASH));
    }

    /// A print already anchored under the old publisher stays anchored — rotation protects what
    /// gets posted in the future, it is not a way to erase or re-attribute the past.
    function test_rotatePublisher_doesNotAffectAlreadyPostedPrints() public {
        bytes memory sig = _realSignature();
        attestation.postPrint(BODY_HASH, VERSION, PRINT_DATE, METHODOLOGY_VERSION, sig);
        uint64 postedAt = attestation.postedAt(BODY_HASH);

        vm.prank(admin);
        attestation.rotatePublisher(otherSigner);

        assertEq(attestation.postedAt(BODY_HASH), postedAt);
        assertTrue(attestation.isPosted(BODY_HASH));
    }
}
