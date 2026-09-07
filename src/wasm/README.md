# Generated WASM grinder

This directory contains the wasm-bindgen output of [`/crates/vanity-grinder`](../../crates/vanity-grinder).

**Do not edit by hand.** Edit the Rust source at `crates/vanity-grinder/src/lib.rs`,
then regenerate with:

```bash
npm run build:wasm
```

The artifacts are checked in so the project builds without a Rust toolchain at
install time: CI only needs `npm install` and `npm run build`. This README and
the `.gitignore` are rewritten by [scripts/build-wasm.mjs](../../scripts/build-wasm.mjs)
after every build, because wasm-pack would otherwise clobber them.

## Files

- `vanity_grinder.js`: wasm-bindgen glue (default export `init`, named exports `grind`, `initSync`)
- `vanity_grinder_bg.wasm`: the compiled WebAssembly module
- `vanity_grinder.d.ts`: TypeScript declarations
- `vanity_grinder_bg.wasm.d.ts`: low-level wasm import declarations

## API

```js
import init, { grind } from './vanity_grinder.js';

await init();

const seed = new Uint8Array(32);
crypto.getRandomValues(seed);
const hit = grind(prefix, suffix, ignoreCase, batchSize, seed);
// null, or { secretKey: Uint8Array(64), publicKey: string }
```

The 64-byte `secretKey` is Solana's standard layout (`[32-byte seed][32-byte
public key]`), compatible with `Keypair.fromSecretKey()` in `@solana/web3.js`.
