# Split-key grinding

> `three-split-key/v1`. A protocol for having somebody else grind your vanity
> address without them being able to compute the key.

## The problem

Every paid vanity grinder sees the key it sells you. That is not a trust
preference, it is arithmetic: if a worker generates a keypair, the worker has
the keypair. No amount of policy fixes it.

## The construction

Ed25519, basepoint `B`, prime-order subgroup order `L`.

1. **The requester** picks a secret scalar `a1 ∈ [1, L)` locally and publishes
   only `P1 = a1·B`. `a1` never leaves their machine.
2. **A worker** searches offset scalars `a2`, computing candidate addresses
   `A = P1 + a2·B` and testing each against the pattern. It knows `a2` and `P1`
   but not `a1`, so it cannot compute the final secret.
3. On a hit the worker publishes `(a2, A)`. Anyone verifies, with no secret,
   that `P1 + a2·B == A` and that `A` matches the pattern.
4. **The requester** combines `aFinal = (a1 + a2) mod L` on their own machine.
   Since `aFinal·B = a1·B + a2·B = P1 + a2·B = A`, that scalar controls exactly
   the vanity address, and it only ever exists there.

The offset is **not a secret**. It is useless without `a1`, so it can travel in
the clear and needs no envelope, no escrow and no trusted delivery.

## Why the search is cheap

The worker does not derive a keypair per candidate. It walks the curve: each
step is one point addition (`Q ← Q + B`, `a2 ← a2 + 1`) followed by a Base58
encode. That is why a pure-JavaScript implementation is viable on a server or in
a browser tab without WebAssembly.

## The catch, stated up front

`aFinal` is a raw Ed25519 **scalar**, not a 32-byte seed. Recovering a seed that
expands to a chosen scalar would mean inverting SHA-512, which is preimage-hard.
So a split-key wallet is an *expanded* key:

| Capability | Works |
| --- | --- |
| Signing transactions | yes, via `signWithScalar` / `SplitKeySigner` |
| Being a valid Solana account | yes |
| `libsodium crypto_sign_*` with an external scalar | yes |
| Import into a seed-only wallet (Phantom "import private key") | **no** |

`expandedSecretKey(aFinal)` returns the 64 bytes such a signer expects: the
scalar followed by a domain-separated nonce prefix derived from it, since an
expanded key has no RFC-8032 seed to take a prefix from.

## Wire format

Request:

```json
{ "p1": "<Base58 or hex Ed25519 point>", "prefix": "AGNT", "suffix": "", "ignoreCase": false, "timeBudgetMs": 8000 }
```

Response on a hit:

```json
{
  "found": true,
  "protocol": "three-split-key/v1",
  "address": "<Base58 address>",
  "offset": "<64 hex chars, little-endian scalar>",
  "serverComponent": "<Base58 point a2·B>",
  "attempts": 2303,
  "certificate": { }
}
```

Response on a miss carries `found: false` and the attempts spent; the requester
calls again with the same `p1`. Time-boxing each request keeps a long search as
many short calls rather than one held connection.

## Verification

```js
import { verifySplitKeyClaim, combineScalars } from './src/split-key.js';

// Anyone, with no secret:
verifySplitKeyClaim({ p1, offset, address, pattern });   // { ok, derivationOk, patternOk }

// Only the requester:
const { scalar, address } = combineScalars(a1, offset);
```

A client must **always** verify before accepting: a malicious or broken worker
returning a wrong offset has to fail visibly, not silently hand over a key that
controls nothing.

## The non-custody assertion

A proof-of-grind certificate for a split-key grind carries:

```json
"nonCustody": {
  "scheme": "ed25519-split-key/v1",
  "buyerPublicKey": "<P1>",
  "serverComponent": "<a2·B>"
}
```

The verifier recomputes `P1 + a2·B` and compares it to the certificate address.
The secret offset scalar is never in the certificate: only the public point,
which is what makes the claim provable rather than promised.
