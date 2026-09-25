// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title RateAttestationVerifier
 * @notice Binds a USD-per-SIU settlement rate to the real, registered print publisher — closes
 *         the gap disclosed (and, found live 2026-09-25, actually exploitable) in
 *         WorkClaim.sol/CapacityBond.sol: `mint`/`settleWindowClose` previously took a rate as a
 *         bare, unverified `uint256`. `settleWindowClose` is deliberately permissionless (any
 *         caller may trigger it, for any holder, for liveness) and `_usdcAmount`'s only other
 *         check is that the bond has the funds — so an unverified rate meant any caller could
 *         drain a lot's entire bonded USDC by settling even a trivial defaulted claim at an
 *         arbitrarily inflated rate. Symmetrically, an unverified rate at mint let a buyer
 *         consume real issuer headroom while paying an arbitrarily low price.
 *
 * @dev Does NOT verify a print's full body against `TouchstoneAttestation`'s anchored hash —
 *      that requires reproducing the print's exact JCS canonicalisation on-chain, real,
 *      non-trivial work this pass still doesn't attempt (CapacityBond.sol's own prior "Known
 *      limitation" note). Instead: the print publisher signs a small, separate EIP-712 message
 *      attesting to one number for one print — `(printId, nanoUsdPerSiu, validUntil)` — using the
 *      exact same key already registered as `TouchstoneAttestation.publisher`. EIP-712's domain
 *      separator makes this signature structurally unconfusable with the print's own raw-hash
 *      signature scheme (`packages/print/src/sign/sign.ts`), so reusing the one key to sign both
 *      message types is safe. `printId` is accepted opaquely here — this contract does not
 *      interpret it or check it against the claim's own window; that a caller supplied the rate
 *      attestation for the *right* print remains an off-chain/caller concern, exactly like
 *      `windowFrom`/`windowTo` matching already is today. The guarantee this contract adds is
 *      narrower and sufficient: whatever rate is used was genuinely attested by the real
 *      publisher, for a real print, before some deadline — not invented by whoever is calling.
 *
 *      Rate scale: nano-USD per SIU (1e-9 USD), not the 1e-6 ("micro") scale the old bare
 *      parameter used. `WorkClaim.sol`'s old "two full digits of headroom over dated_siu's
 *      published precision" claim is now false — dated_siu rounds to 4 significant figures, not
 *      a fixed decimal-place count (docs/methodology.md's Rounding section), so a real Commodity
 *      SIU value already needs all 6 decimal places the old 1e6 scale offered, zero headroom to
 *      spare. 1e9 gives 3 more digits of headroom than dated_siu needs at any price level this
 *      index has reached or is likely to reach soon, without repeating the same mistake.
 *
 *      EIP-712 domain separator and typed-data hashing are hand-rolled here rather than built on
 *      OpenZeppelin's `EIP712` base contract — found live: that contract's dependency chain
 *      (`EIP712` -> `ShortStrings` -> ... -> `Strings` -> `Bytes.sol`) emits `MCOPY` unconditionally,
 *      a Cancun opcode, and `foundry.toml` deliberately pins `evm_version = "shanghai"` so Arc
 *      stays a deployment target rather than a rewrite (that file's own comment). `ECDSA.sol` has
 *      no such dependency (confirmed: it imports nothing), so it's still used for recovery;
 *      the domain separator itself is the same few lines EIP-712 defines directly, computed once
 *      as an immutable at construction — no fork-protection recomputation, since a redeploy is
 *      already how this project's own no-admin/no-upgradeability contracts handle a real chain
 *      reorg-class event (`TouchstoneAttestation.sol`'s own "no publisher rotation" doc comment).
 */
abstract contract RateAttestationVerifier {
    /// @notice The only address whose signature this contract trusts — the same publisher key
    ///         already registered as `TouchstoneAttestation.publisher`, read once at construction
    ///         (that address is itself immutable there, so there is nothing to keep in sync).
    address public immutable publisher;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Computed once at construction from this contract's own `name`/`version`/`chainid`/
    ///      address — see this file's top-level doc comment for why not OZ's `EIP712`.
    bytes32 private immutable DOMAIN_SEPARATOR;

    struct RateAttestation {
        /// @dev The real, published print id this rate was attested for, e.g. "2026-09-25" or
        ///      "2026-09-25-commodity" — opaque to this contract, see this file's own top-level
        ///      doc comment for what "opaque" does and doesn't guarantee.
        string printId;
        /// @dev USD per SIU, scaled by 1e9 (nano-USD per SIU) — see this file's top-level doc
        ///      comment for why this scale, not the old 1e6 one.
        uint256 nanoUsdPerSiu;
        /// @dev Unix timestamp after which this attestation can no longer be used — bounds how
        ///      long a genuine but stale rate stays valid, the standard EIP-712 replay guard.
        uint64 validUntil;
    }

    bytes32 private constant RATE_ATTESTATION_TYPEHASH =
        keccak256("RateAttestation(string printId,uint256 nanoUsdPerSiu,uint64 validUntil)");

    error PublisherZero();
    error RateAttestationExpired(uint64 validUntil, uint64 currentTimestamp);
    error InvalidRateAttestation(address recovered, address expected);

    constructor(address publisher_, string memory eip712Name, string memory eip712Version) {
        if (publisher_ == address(0)) revert PublisherZero();
        publisher = publisher_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(eip712Name)),
                keccak256(bytes(eip712Version)),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 domain separator this contract signs against — published so an
    ///         off-chain signer can construct the exact same typed-data hash without guessing at
    ///         `name`/`version`/`chainId`/`verifyingContract`.
    function rateAttestationDomainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }

    /// @dev The standard EIP-712 "\x19\x01" typed-data digest — see this file's top-level doc
    ///      comment for why this is hand-rolled rather than OZ's `EIP712._hashTypedDataV4`.
    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @dev Reverts on an expired attestation or a signature that doesn't recover to `publisher`.
    ///      Returns the verified rate only — never the whole struct — so a call site can't
    ///      accidentally use an unverified field from `att` after calling this.
    function _verifyRateAttestation(RateAttestation calldata att, bytes calldata signature)
        internal
        view
        returns (uint256 nanoUsdPerSiu)
    {
        if (block.timestamp > att.validUntil) {
            revert RateAttestationExpired(att.validUntil, uint64(block.timestamp));
        }

        bytes32 structHash = keccak256(
            abi.encode(
                RATE_ATTESTATION_TYPEHASH,
                keccak256(bytes(att.printId)),
                att.nanoUsdPerSiu,
                att.validUntil
            )
        );
        address recovered = ECDSA.recoverCalldata(_hashTypedData(structHash), signature);
        if (recovered != publisher) revert InvalidRateAttestation(recovered, publisher);

        return att.nanoUsdPerSiu;
    }
}
