// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title DatumAttestation
 * @notice Hash-anchors published Dated SIU prints — build1-spec.md §10.
 *
 * A print is a signed JSON document published in a public git repo; this contract records the
 * time at which its body hash was first anchored on-chain. That is integrity of publication —
 * evidence that a given print existed in a given form at a given time — and nothing more. The
 * contract never computes, validates or opines on a print's contents.
 *
 * No upgradeability. No admin. No pause. No publisher rotation: the publisher key is immutable,
 * so rotating it means deploying a new instance and stating the new address in the published
 * methodology. That is deliberate — a mutable publisher would let whoever controls the mutation
 * retroactively change who is trusted to have anchored past prints.
 */
contract DatumAttestation {
    /// @notice The only address permitted to post prints. Immutable by design.
    address public immutable publisher;

    /// @notice Print body hash => unix timestamp of the block in which it was first anchored.
    ///         Zero means never anchored.
    mapping(bytes32 => uint64) public postedAt;

    event PrintPosted(bytes32 indexed bodyHash, string version, uint64 timestamp);

    error PublisherZero();
    error NotPublisher();
    error BodyHashZero();
    error VersionEmpty();
    error AlreadyPosted();

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert PublisherZero();
        publisher = publisher_;
    }

    /**
     * @notice Anchors a print body hash, recording the current block timestamp against it.
     * @param bodyHash keccak256 of the JCS-canonicalised print body, excluding the signature
     *        fields — the same value `printBodyHashHex` in packages/print produces.
     * @param version The basket version the print was computed against, e.g. "SIU-2026a".
     *
     * Re-anchoring an already-anchored hash reverts rather than overwriting. The recorded
     * timestamp is the entire fact this contract exists to establish; letting a later call
     * replace it would destroy the evidence instead of adding to it.
     */
    function postPrint(bytes32 bodyHash, string calldata version) external {
        if (msg.sender != publisher) revert NotPublisher();
        if (bodyHash == bytes32(0)) revert BodyHashZero();
        if (bytes(version).length == 0) revert VersionEmpty();
        if (postedAt[bodyHash] != 0) revert AlreadyPosted();

        uint64 timestamp = uint64(block.timestamp);
        postedAt[bodyHash] = timestamp;

        emit PrintPosted(bodyHash, version, timestamp);
    }

    /// @notice Convenience view for verifiers that only need existence, not the timestamp.
    function isPosted(bytes32 bodyHash) external view returns (bool) {
        return postedAt[bodyHash] != 0;
    }
}
