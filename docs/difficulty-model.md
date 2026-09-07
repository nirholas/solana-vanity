# The Base58 difficulty model

> Specification of `base58-exact/v2`, the model every quote, rarity tier and
> certificate in this project names.

## The problem with 58ⁿ

A Solana address is a 32-byte Ed25519 public key rendered in Base58. Almost all
vanity tooling models an *n*-character pattern as 58ⁿ expected attempts, which
silently assumes each character is an independent uniform symbol.

That is true of the trailing characters and false of the leading one, because
Base58 is a **positional encoding of an integer**, not a string of independent
symbols. Encoding length varies with magnitude, and the boundaries land inside
the alphabet.

## The exact model

A 32-byte key, once leading zero bytes are stripped, spans `[2²⁴⁸, 2²⁵⁶)`.
Base58 renders such a value in 44 digits when it is at least 58⁴³ and 43 digits
otherwise. Two ratios carve the alphabet:

```
2²⁵⁶ / 58⁴³ ≈ 17.05   44-digit encodings lead with symbols 1..17
2²⁴⁸ / 58⁴² ≈  3.90   43-digit encodings lead with symbols 3..57
```

which yields six bands:

| Band | Exact probability | Versus 1/58 |
| --- | --- | --- |
| `1` | 3.906e-3 | 4.4x harder (exactly 1/256: a leading zero byte) |
| `2`-`3` | 5.804e-2 | 3.4x easier |
| `4` | 5.814e-2 | 3.4x easier |
| `5`-`H` | 5.904e-2 | 3.4x easier |
| `J` | 1.433e-2 | 1.2x harder |
| `K`-`z` | 1.001e-3 | 17.2x harder |

Forty of the fifty-eight symbols sit in the hard band.

## How it is computed

`prefixProbability` counts, exactly, how many of the 2²⁵⁶ possible keys encode
to a string with the requested prefix. It is BigInt interval arithmetic, not a
fitted table:

1. leading `1`s in the pattern are leading **zero bytes**, not digits, so they
   are handled separately and cap the remaining width;
2. the rest of the pattern is read as a Base58 integer `v`;
3. strings of total length `L` beginning with that pattern occupy the contiguous
   integer range `[v·58^(L-|rest|), (v+1)·58^(L-|rest|))`;
4. those ranges are disjoint across `L`, so the answer is the summed overlap with
   the valid key band `[lo, hi)`;
5. divide by 2²⁵⁶.

Suffixes stay at 58⁻ⁿ. The low-order digits of a uniform 256-bit integer are
equidistributed to within `O(58ⁿ / 2²⁴⁸)`, about 1e-53 at the six-character
ceiling, far below double precision.

Case-insensitive patterns sum the counts of every Base58-valid case spelling.
Because the alphabet omits `0 O I l`, some letters have exactly one spelling: a
case-insensitive `I` can only ever match a literal `i`.

## Versioning

The model id is part of every quote and every certificate:

| Id | Meaning |
| --- | --- |
| `base58-exact/v2` | Current. The exact count described above. |
| `58^effectiveLength` | Superseded. The uniform approximation. |

A certificate issued under an older model still verifies under that model:
`difficultyModel(id)` returns the function the certificate was issued with, so a
correction never invalidates past attestations.

## Reproducing it

```js
import { prefixProbability, LEADING_CHAR_PROBABILITY } from './src/base58-distribution.js';

prefixProbability('K');                 // 1.0006e-3
LEADING_CHAR_PROBABILITY['5'];          // 5.904e-2
Object.values(LEADING_CHAR_PROBABILITY).reduce((a, b) => a + b, 0);  // 1
```

`tests/difficulty.test.js` pins the bands, checks the total is exactly 1, and
samples real Ed25519 keypairs to confirm the exact model predicts reality better
than the naive one.
