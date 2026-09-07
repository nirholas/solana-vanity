# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/nirholas/solana-vanity/security/advisories/new).
Do not open a public issue for anything that could expose a user's key.

Expect an acknowledgement within 72 hours.

## What this project promises

| Claim | Enforced by |
| --- | --- |
| The browser grinder never transmits key material. | No `fetch` in the grind path. Check the network tab, or read `src/ui/app.js`. |
| A delegated grind cannot expose your key. | Split-key arithmetic: the remote side holds `a2` and never sees `a1`. Verified locally before any result is shown. |
| A certificate cannot be forged. | Ed25519 signature over a canonical encoding, checked against the issuer's published key ring rather than the key in the document. |
| A certificate cannot attest a lie. | `/api/certify` refuses an address that does not match the claimed pattern, and refuses a split-key certificate whose non-custody equation does not hold. |

## What it does not promise

- **`POST /api/grind` is custodial.** It returns a secret key over the network
  and is disabled unless an operator sets `ALLOW_SERVER_GRIND=1`. Treat any key
  it produces as compromised for anything of value.
- **A certificate is not proof that no copy was kept.** It proves the issuer
  signed a set of facts. Only grinding it yourself, or split-key delegation,
  proves nobody else could hold the key. The certificate names which of those
  applied.
- **An ephemeral attestation key is not an identity.** When `ATTESTATION_SEED`
  is unset the service mints a per-process key, says so in every response, and
  its certificates stop verifying on restart.

## Cryptographic dependencies

Ed25519 point arithmetic, SHA-512, HKDF and PBKDF2 come from
[@noble/curves](https://github.com/paulmillr/noble-curves) and
[@noble/hashes](https://github.com/paulmillr/noble-hashes). The WebAssembly
grind loop uses [curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek).
Nothing in this repository implements a cryptographic primitive itself.
