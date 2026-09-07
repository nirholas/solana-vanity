# Proof-of-grind certificates

> `three-pog/v1`. A signed, offline-verifiable statement about how a vanity
> address was produced.

## What a certificate is

A JSON document, signed with the issuer's long-lived Ed25519 attestation key,
asserting a set of facts about one address. Every fact is recomputable, so a
verifier trusts nothing in the document itself.

```json
{
  "protocol": "three-pog/v1",
  "certType": "proof-of-grind",
  "certId": "<sha256 of address, pattern, format and nonce>",
  "address": "AgNH1vfRutFqwyTVj8JxucoeMdhqDri3YLw1eezyGzk1",
  "pattern": { "prefix": "AGN", "suffix": null, "ignoreCase": true },
  "format": "split-key",
  "scheme": "ed25519-split-key/v1",
  "attempts": 2303,
  "difficulty": { "expectedAttempts": 1207, "model": "base58-exact/v2" },
  "rarity": { "score": 1043, "bits": 10.43, "tier": "rare", "tierLabel": "Rare" },
  "freshness": { "nonce": "<32 bytes hex>", "issuedAt": "2026-09-07T06:00:00.000Z" },
  "nonCustody": { "scheme": "ed25519-split-key/v1", "buyerPublicKey": "…", "serverComponent": "…" },
  "network": "solana",
  "keyId": "sv-2ce3736bb2dae06c",
  "signature": "<128 hex chars>",
  "servicePublicKey": "<Base58>",
  "signatureScheme": "ed25519"
}
```

## Formats

| `format` | Means |
| --- | --- |
| `keypair` | A raw Ed25519 keypair was ground. |
| `mnemonic` | A BIP-39 phrase was ground; the address is its first derived account. |
| `split-key` | Nobody but the requester could ever hold the key. Carries `nonCustody`. |

The format is part of the signed core, so a certificate cannot claim a stronger
provenance than the grind that produced it.

## What verification checks

`verifyProofOfGrind` returns a per-check audit, not a boolean:

| Check | What it recomputes |
| --- | --- |
| `protocol` | The document declares a supported protocol and type. |
| `address` | Base58 decodes to exactly 32 bytes. |
| `certId` | The id is the hash of the immutable facts plus the freshness nonce. |
| `pattern` | The address actually matches the claimed pattern. |
| `difficulty` | The expected attempts equal what the named model produces. |
| `rarity` | The tier and score equal what the rarity function produces. |
| `freshness` | The issue time is not in the future, and is within any window supplied. |
| `nonCustody` | For split-key grinds, `P1 + a2·B == address`. |
| `signature` | Ed25519 over the canonical encoding of the signed core. |
| `serviceKeyPinned` | The signing key appears in the published key ring. |

The last one matters most. Without a pin, a self-signed forgery passes the
signature check: it signed itself. The verifier fetches the key ring from
`/.well-known/solana-vanity.json` and reports `keyringPinned: false` when it
could not, rather than passing quietly.

## Canonical encoding

The signature covers a deterministic serialization of a fixed field list
(`SIGNED_FIELDS`), so key order and whitespace cannot change what was signed. A
field added later is not covered and cannot be smuggled in.

## Freshness and resale

The nonce exists so the same address cannot be sold twice as "freshly ground".
A registry that stores the canonical first certificate for an address can pass
it to the verifier as `opts.canonical`; a second certificate with a different id
or nonce is then flagged.

## Rotation

The key ring is an array. To rotate: publish the new key alongside the old one,
sign new certificates with the new key, and drop the old one once every
certificate signed with it has aged out. Certificates name their `keyId`, so a
verifier resolves the right key without guessing.

## What a certificate cannot prove

That whoever ran the grinder kept no copy. Only grinding it yourself, or
split-key delegation, proves that. The `format` field says which applied, and a
`keypair` certificate from a custodial service is exactly as strong as trusting
that service.
