# Methodology — v0-draft

_This is the published methodology, versioned. `methodology_version` on every print refers to a
section heading in this file; `methodology_url` links here. This document is the authority once
it is filled in — until then, `docs/build1-spec.md` states the normative rules (basket
composition, gates, cache/batch/subsidy policy, rounding) that this file will restate in public,
versioned form as each is implemented._

**Status:** stub. No print has been marked `final` yet, so no methodology version here has been
used to produce a published number.

---

## v0-draft

Placeholder for the first public methodology version. Sections to fill in as each part of the
pipeline is built and exercised against a real print:

- Basket composition (`SIU-2026a`) and quality gates
- Cache policy (T2 requires caching explicitly disabled)
- Batch-discount policy
- Host-weighting policy
- Subsidised-supply policy (flagged, excluded from the headline reference set)
- Rounding rules (decimal places and mode, per field)
- Seed publication and reproduction instructions

---

## Publisher signing key

Every print is signed with a secp256k1 key (`DATUM_PUBLISHER_KEY`, never committed) and carries
its own `public_key` field, so a single print verifies against itself. What that print's
`public_key` does _not_ prove on its own is that it's _Datum's_ key rather than an
impersonator's — that requires an independent, out-of-band record of the real fingerprint, kept
stable across every print rather than regenerated per print.

**Fingerprint:** not yet published. No `DATUM_PUBLISHER_KEY` has been generated for a real print
yet — every print signed so far has used a disposable test key in unit tests only.

Once a real publisher key exists, its public key fingerprint goes here verbatim, so anyone
verifying a print can check `print.public_key` against this document independently of the site
or repo that's serving the print.
