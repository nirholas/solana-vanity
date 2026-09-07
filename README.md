# solana-vanity

**Grind a Solana address that starts or ends with characters you choose, in your
browser, across every core, with the honest maths.**

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-43%20passing-brightgreen.svg)](./tests)
[![No custody](https://img.shields.io/badge/keys-never%20leave%20your%20machine-ffd54f.svg)](#security-model)

A complete, production-grade vanity wallet stack: the WebAssembly grinder, the
site, the HTTP API, a CLI, an MCP server for AI assistants, signed provenance
certificates, and a delegation protocol that lets somebody else do the work
without ever being able to compute your key.

```bash
npx solana-vanity grind --prefix AGNT --out wallet.json
```

---

## Why another vanity generator

Three things here that the others do not have.

### 1. The difficulty numbers are exact, not folklore

Every vanity tool quotes an *n*-character Solana pattern as 58ⁿ attempts. That is
right for the tail and wrong for the head, because Base58 encodes a 256-bit
integer: the encoding is 44 digits above 58⁴³ and 43 digits below it, which
carves the alphabet into six bands spanning **58x in difficulty**.

| Leading character | Exact probability | Versus the 1/58 folklore |
| --- | --- | --- |
| `1` | 3.906e-3 | 4.4x harder |
| `2`-`3` | 5.804e-2 | 3.4x easier |
| `4` | 5.814e-2 | 3.4x easier |
| `5`-`H` | 5.904e-2 | 3.4x easier |
| `J` | 1.433e-2 | 1.2x harder |
| `K`-`z` | 1.001e-3 | **17.2x harder** |

Forty of the fifty-eight symbols are seventeen times more expensive than every
other tool will tell you. `src/base58-distribution.js` counts the matching key
space exactly, with BigInt interval arithmetic over all 2²⁵⁶ keys, and the test
suite pins it against direct sampling of real Ed25519 keypairs.

### 2. Provenance you can check, not a promise

Any ground address can carry a **proof-of-grind certificate**: an Ed25519-signed
statement of the pattern, the difficulty under a named model, the rarity, and a
freshness nonce that makes reselling the same address as "freshly ground"
detectable. Verification recomputes every claim and checks the signature against
the issuer's published key ring, not the key the certificate names for itself.

```bash
npx solana-vanity verify certificate.json
```

### 3. Delegation that is mathematically non-custodial

Hard patterns need more compute than a browser tab has. Handing the job to
someone else normally means handing over the key. **Split-key grinding** removes
that trade:

1. you pick a secret scalar `a1` locally and publish only `P1 = a1·B`;
2. the grinder searches offsets `a2` where `P1 + a2·B` matches your pattern;
3. it returns `a2`, which is useless without `a1`;
4. you combine `aFinal = (a1 + a2) mod L` on your own machine.

The grinder never sees `a1`, so it cannot derive the key. The certificate
publishes `a2·B`, so anyone can verify `P1 + a2·B == address` and confirm
non-custody from public values alone.

```bash
npx solana-vanity delegate --prefix AGNT
```

**The honest catch:** `aFinal` is a raw Ed25519 scalar, not a 32-byte seed. It
signs perfectly and is a valid Solana account, but seed-only wallet imports
(Phantom's "import private key") will reject it. Use it with an SDK signer, or
grind a seed-based key yourself when import matters.

---

## Install and run

```bash
git clone https://github.com/nirholas/solana-vanity
cd solana-vanity
npm install
npm run dev            # site on http://localhost:5180, API on http://localhost:8787
npm test               # 43 tests, no network needed
```

Production:

```bash
npm run build
ATTESTATION_SEED=<32-byte hex> npm start      # one process serves site + API
```

Cloudflare Workers:

```bash
npm run build
npx wrangler secret put ATTESTATION_SEED
npx wrangler deploy
```

Docker / Cloud Run:

```bash
docker build -t solana-vanity .
docker run -p 8787:8787 -e ATTESTATION_SEED=<hex> solana-vanity
```

---

## The pieces

| Surface | Where | What it is |
| --- | --- | --- |
| Browser grinder | [`index.html`](index.html), [`src/ui/app.js`](src/ui/app.js) | One Web Worker per core driving the WASM grinder. Live rate, pause/resume, exportable keypair. |
| Rarity appraiser | [`rarity.html`](rarity.html) | Score any address, and the exact leading-character table rendered live. |
| Delegation | [`delegate.html`](delegate.html) | The split-key protocol, end to end, in the tab. |
| Verifier | [`verify.html`](verify.html) | Certificate verification, entirely client-side. |
| Grind loop | [`crates/vanity-grinder`](crates/vanity-grinder) | Rust + curve25519-dalek, compiled to WebAssembly. |
| Difficulty model | [`src/base58-distribution.js`](src/base58-distribution.js) | The exact key-space count. |
| Certificates | [`src/proof-of-grind.js`](src/proof-of-grind.js) | Issue and verify signed provenance. |
| Split-key | [`src/split-key.js`](src/split-key.js) | The non-custodial delegation protocol. |
| HTTP API | [`server/`](server) | One Fetch handler, hosted on Node or Cloudflare. |
| CLI | [`cli/solana-vanity.js`](cli/solana-vanity.js) | `grind`, `delegate`, `quote`, `appraise`, `verify`, `serve`, `mcp`. |
| MCP server | [`mcp/index.js`](mcp/index.js) | Six tools for AI assistants. |

---

## CLI

```bash
solana-vanity grind --prefix AGNT --suffix pump --out wallet.json
solana-vanity grind --mnemonic --prefix ag        # a 12-word seed phrase
solana-vanity delegate --prefix AGNT              # split-key, nothing leaks
solana-vanity quote --prefix AGNT --rate 120000
solana-vanity appraise <address> --suffix-len 4
solana-vanity verify certificate.json
solana-vanity serve --port 8787
solana-vanity mcp
```

Add `--json` to anything for machine-readable output.

## MCP

```json
{
  "mcpServers": {
    "solana-vanity": { "command": "npx", "args": ["-y", "solana-vanity", "mcp"] }
  }
}
```

| Tool | Does |
| --- | --- |
| `vanity_quote` | Exact difficulty, rarity and ETA for a pattern. |
| `vanity_appraise` | Rarity of an address that already exists. |
| `vanity_grind` | Grind a real keypair locally, across every core. |
| `vanity_split_key_grind` | Delegate a hard pattern without exposing a key. |
| `vanity_verify_certificate` | Verify a certificate offline. |
| `vanity_leading_characters` | The exact Base58 probability table. |

## HTTP API

Full schema at `/openapi.json`; agent card at `/.well-known/agents.json`.

```bash
curl -s http://localhost:8787/api/quote \
  -H 'content-type: application/json' \
  -d '{"prefix":"AGNT","attemptsPerSecond":120000}'
```

| Endpoint | Does |
| --- | --- |
| `POST /api/quote` | Difficulty, rarity, ETA, and the naive figure for comparison. |
| `POST /api/appraise` | Rarity of an existing address. |
| `GET /api/difficulty/leading-characters` | The exact Base58 table. |
| `POST /api/certify` | Sign a proof-of-grind certificate. |
| `POST /api/verify` | Verify one. |
| `POST /api/splitkey/grind` | Non-custodial delegated grinding. |
| `POST /api/splitkey/verify` | Check a split-key claim. |
| `POST /api/grind` | Custodial server-side grind. **Disabled by default.** |

---

## Documentation

| Document | Covers |
| --- | --- |
| [docs/difficulty-model.md](docs/difficulty-model.md) | The exact Base58 model, how it is computed, and how it is versioned. |
| [docs/protocol-split-key.md](docs/protocol-split-key.md) | The non-custodial delegation protocol, its wire format, and its one real limitation. |
| [docs/protocol-proof-of-grind.md](docs/protocol-proof-of-grind.md) | The certificate format and every check a verifier runs. |
| [docs/deploy.md](docs/deploy.md) | Node, Docker, Cloud Run, Cloudflare Workers, and static-only. |
| [SECURITY.md](SECURITY.md) | What this project promises, and what it does not. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Running it, the quality bar, rebuilding the WASM. |

The site also ships its own documentation page at `/docs.html`.

---

## Security model

| Path | Who can see the key |
| --- | --- |
| Browser grinder | Only your browser. No request carries key material. |
| CLI `grind` | Only your machine. |
| CLI / API `delegate` | Only you. The remote side holds an offset that is useless without your `a1`. |
| `POST /api/grind` | The server process and every hop in between. Off unless an operator sets `ALLOW_SERVER_GRIND=1`. |

Each candidate is derived from a fresh 32-byte CSPRNG seed, incrementing only
the low four bytes as a batch counter, so keys are unpredictable as long as the
seed source is. The returned 64-byte secret key uses Solana's standard
`[seed][pubkey]` layout and imports directly into `Keypair.fromSecretKey()`.

Report vulnerabilities through [GitHub security advisories](https://github.com/nirholas/solana-vanity/security/advisories/new). See [SECURITY.md](./SECURITY.md).

---

## Environment

| Variable | Meaning |
| --- | --- |
| `ATTESTATION_SEED` | 32-byte Ed25519 seed (hex or Base58) for signing certificates. Unset means an ephemeral per-process key, reported in every response. Mint one with `npm run keygen`. |
| `ALLOW_SERVER_GRIND` | `1` enables the custodial grind endpoint. Off by default. |
| `PORT` | Node listen port. Default 8787. |
| `SOLANA_VANITY_API` | Default remote API for `delegate` and `verify`. |

---

## Provenance

The grinder, the difficulty model, the certificate format and the Ed25519
split-key protocol were first built inside [three.ws](https://github.com/nirholas/three.ws)
and are re-licensed here under Apache-2.0. The certificate protocol identifiers
(`three-pog/v1`, `three-vanity/v1`) are kept unchanged on purpose: this verifier
accepts certificates issued by that deployment, and vice versa.

## Licence

[Apache-2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.
