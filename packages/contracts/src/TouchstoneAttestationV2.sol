// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title TouchstoneAttestationV2
 * @notice Hash-anchors published Dated SIU prints — build1-spec.md §10, mainnet-switch brief §8.
 *
 * Difference from TouchstoneAttestation.sol (which stays deployed and unmodified on Base Sepolia /
 * Arc Testnet — nothing here replaces or touches that contract or its existing anchors): `postPrint`
 * no longer gates on `msg.sender`. Daily unattended prints mean the publisher key stays online in
 * CI either way — an air-gapped signer that also signs every day isn't realistic — so the useful
 * property to buy is not "only the publisher's wallet calls this function", it's "only the
 * publisher's key decides what content gets anchored, and gas can come from anyone". `postPrint`
 * instead verifies an EIP-712 signature from `publisher` over the exact content being posted; any
 * funded relayer may then submit the already-signed call, holding no secret key of consequence
 * beyond gas money.
 *
 * Adds the one thing V1 deliberately lacked: publisher rotation, behind a SEPARATE, immutable
 * `admin` address (meant for a hardware wallet, used only for rotation, never for daily signing). A
 * stolen publisher key under V1 could post fake prints forever, with no recourse short of a full
 * redeploy and re-pointing every integrator at a new address. Under V2, `admin` replaces the
 * compromised publisher and every signature the old key ever produced stops verifying immediately —
 * `postPrint` reads `publisher` live from storage, never a value cached at signing time — with no
 * redeploy. `admin` itself has no rotation path: that key is meant to live somewhere with nothing
 * faster-moving to protect it from, so there is deliberately nothing here that can move it.
 *
 * EIP-712 domain separator and typed-data hashing are hand-rolled, not OpenZeppelin's `EIP712` base
 * contract, for the same reason RateAttestationVerifier.sol gives: OZ's `EIP712` pulls in `MCOPY`
 * (a Cancun opcode) through its ShortStrings/Strings/Bytes dependency chain, and foundry.toml pins
 * `evm_version = "shanghai"` so Arc (and now Kite, pending its own checks) stay deployment targets
 * rather than a rewrite. `ECDSA.sol` has no such dependency, so it is still used for recovery.
 *
 * No nonce or expiry on the signed attestation: `postedAt[bodyHash]` already makes a successful
 * post one-shot (`AlreadyPosted` guards a replay of the very same signature for the very same
 * print), and a rotation already invalidates every signature the old key ever produced, since the
 * signer check reads `publisher` live. Neither mechanism needs a third guard stacked on top.
 *
 * The domain separator is per-chain and per-deployment by construction (`block.chainid` and
 * `address(this)` at construction time), so the SAME print needs a DISTINCT signature for each
 * chain it is anchored on — the publishing pipeline signs once per target chain, not once overall.
 *
 * No upgradeability, no pause, no fee, no token — this contract anchors a hash and nothing else.
 */
contract TouchstoneAttestationV2 {
    /// @notice The address whose EIP-712 signature this contract trusts to authorise a print.
    ///         Mutable only through `rotatePublisher`, which only `admin` may call.
    address public publisher;

    /// @notice The only address that may call `rotatePublisher`. Immutable: meant for a hardware
    ///         wallet used for nothing else, so there is nothing faster-moving that could change it.
    address public immutable admin;

    /// @notice Print body hash => unix timestamp of the block in which it was first anchored.
    ///         Zero means never anchored.
    mapping(bytes32 => uint64) public postedAt;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Computed once at construction — see this file's top-level doc comment for why this is
    ///      hand-rolled rather than OZ's `EIP712`. A redeploy, not recomputation, is this project's
    ///      answer to a real chain reorg/fork event, matching TouchstoneAttestation.sol's own stance
    ///      on why the deployment itself is never mutated in place.
    bytes32 private immutable DOMAIN_SEPARATOR;

    bytes32 private constant PRINT_ATTESTATION_TYPEHASH = keccak256(
        "PrintAttestation(bytes32 bodyHash,string version,string printDate,string methodologyVersion)"
    );

    event PrintPosted(
        bytes32 indexed bodyHash,
        string version,
        string printDate,
        string methodologyVersion,
        uint64 timestamp
    );
    event PublisherRotated(address indexed oldPublisher, address indexed newPublisher);

    error PublisherZero();
    error AdminZero();
    error NotAdmin();
    error BodyHashZero();
    error VersionEmpty();
    error PrintDateEmpty();
    error MethodologyVersionEmpty();
    error AlreadyPosted();
    error InvalidPublisherSignature(address recovered, address expected);

    constructor(address publisher_, address admin_) {
        if (publisher_ == address(0)) revert PublisherZero();
        if (admin_ == address(0)) revert AdminZero();
        publisher = publisher_;
        admin = admin_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("TouchstoneAttestationV2")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 domain separator this contract signs against — published so an
    ///         off-chain signer can construct the exact same typed-data hash without guessing at
    ///         name/version/chainId/verifyingContract. Per-chain and per-deployment by design.
    function printAttestationDomainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    /**
     * @notice Anchors a print, authorised by `publisher`'s EIP-712 signature rather than by
     *         `msg.sender` — any funded relayer may call this, once it holds a signature
     *         `publisher` produced for THIS contract's own domain (chainId + this address).
     * @param bodyHash keccak256 of the JCS-canonicalised print body, excluding the signature
     *        fields — the same value `printBodyHashHex` in packages/print produces.
     * @param version The basket version the print was computed against, e.g. "SIU-2026a" — the
     *        print record's own `version` field.
     * @param printDate The print's own calendar date, e.g. "2026-10-24" — the print record's own
     *        `date` field, verbatim.
     * @param methodologyVersion The print record's own `methodology_version` field — distinct from
     *        `methodology_revision` (docs/methodology.md's dated correction log), which is not part
     *        of this signed payload.
     * @param signature `publisher`'s EIP-712 signature over (bodyHash, version, printDate,
     *        methodologyVersion) for this contract's own domain. Every field that is stored or
     *        emitted is part of the signed struct — a relayer can submit the signed call as-is, but
     *        cannot alter, drop or add any of these four values and still have it verify.
     */
    function postPrint(
        bytes32 bodyHash,
        string calldata version,
        string calldata printDate,
        string calldata methodologyVersion,
        bytes calldata signature
    ) external {
        if (bodyHash == bytes32(0)) revert BodyHashZero();
        if (postedAt[bodyHash] != 0) revert AlreadyPosted();
        if (bytes(version).length == 0) revert VersionEmpty();
        if (bytes(printDate).length == 0) revert PrintDateEmpty();
        if (bytes(methodologyVersion).length == 0) revert MethodologyVersionEmpty();

        bytes32 structHash = keccak256(
            abi.encode(
                PRINT_ATTESTATION_TYPEHASH,
                bodyHash,
                keccak256(bytes(version)),
                keccak256(bytes(printDate)),
                keccak256(bytes(methodologyVersion))
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ECDSA.recoverCalldata(digest, signature);
        if (recovered != publisher) revert InvalidPublisherSignature(recovered, publisher);

        uint64 timestamp = uint64(block.timestamp);
        postedAt[bodyHash] = timestamp;

        emit PrintPosted(bodyHash, version, printDate, methodologyVersion, timestamp);
    }

    /// @notice Replaces the publisher address. Only `admin` may call this. Every signature the old
    ///         publisher ever produced stops verifying immediately — `postPrint` reads `publisher`
    ///         live from storage, not a value cached at signing time.
    function rotatePublisher(address newPublisher) external {
        if (msg.sender != admin) revert NotAdmin();
        if (newPublisher == address(0)) revert PublisherZero();
        address old = publisher;
        publisher = newPublisher;
        emit PublisherRotated(old, newPublisher);
    }

    /// @notice Convenience view for verifiers that only need existence, not the timestamp.
    function isPosted(bytes32 bodyHash) external view returns (bool) {
        return postedAt[bodyHash] != 0;
    }
}
