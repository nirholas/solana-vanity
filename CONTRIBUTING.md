# Contributing

## Running it

```bash
npm install
npm run dev     # site on :5180, API on :8787
npm test        # 43 tests, no network required
npm run build   # static site into dist/
```

## The bar

- **No mocks, no placeholder data, no TODO comments.** If a path exists it works.
- **Every number is reproducible.** A difficulty, rarity or ETA claim must come
  from `src/base58-distribution.js` or a test can prove it wrong.
- **Every state is designed.** Loading, empty, error and success. A grind that
  fails must say what happened and what to do next.
- **Tests come with the change.** New protocol behaviour needs a negative test:
  not just that the happy path works, but that tampering is rejected.

## Rebuilding the WebAssembly grinder

```bash
cargo install wasm-pack
npm run build:wasm
```

The release profile pins `lto = "fat"`, one codegen unit, and `wasm-opt -O3`
with SIMD. Keep them: throughput is the point of the crate.

## Where things live

| Layer | Directory |
| --- | --- |
| Grind loop (Rust) | `crates/vanity-grinder` |
| Maths and protocols | `src/*.js` |
| Browser UI | `index.html`, `*.html`, `src/ui/` |
| HTTP API | `server/` (Node) and `worker/` (Cloudflare) |
| CLI | `cli/` |
| MCP server | `mcp/` |
| Tests | `tests/` |

## Licence

Contributions are accepted under the Apache License 2.0.
