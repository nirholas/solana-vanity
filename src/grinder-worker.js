/**
 * Vanity grinder Web Worker — WASM backend.
 *
 * Loops keypair generation inside a WASM module (Rust + ed25519-dalek)
 * and reports matches + progress back to the host. The hot loop runs
 * entirely inside WASM in fixed-size batches; between batches the worker
 * yields to its event loop so 'stop'/'pause' messages from the host get
 * processed promptly (bounded latency, one batch).
 *
 * Control messages from the host:
 *   - start  : begin a fresh grind (resets the attempt counter)
 *   - pause  : exit the hot loop, freeing the core, but keep the worker and
 *              its accumulated attempt count alive
 *   - resume : re-enter the hot loop, continuing the attempt count
 *   - stop   : exit the hot loop for good (host terminates the worker)
 *
 * Algorithm parity with nirholas/solana-wallet-toolkit
 * (typescript/src/lib/generator.ts). The WASM module is built from
 * `/crates/vanity-grinder` via `npm run build:wasm`.
 */

import init, { grind } from './wasm/vanity_grinder.js';

// Keep batches small enough that one WASM call returns within ~200 ms even
// on slow CPUs — pause/abort latency is bounded by one batch.
const BATCH_SIZE = 5000;
const PROGRESS_INTERVAL_MS = 250;

let running = false;
// Guards against two grindLoop()s racing if 'resume' arrives before the
// previous loop has fully unwound.
let looping = false;
// Survives pause/resume so the host's per-worker totals stay monotonic.
let attempts = 0;
let cfg = { prefix: '', suffix: '', ignoreCase: false };
let wasmReady = null;

function ensureWasm() {
	if (!wasmReady) {
		// No explicit path: the wasm-bindgen glue resolves the binary via
		// `new URL('vanity_grinder_bg.wasm', import.meta.url)`, the asset
		// pattern Vite rewrites in both dev and build. Importing the `.wasm`
		// with `?url` does NOT work here — Vite's built-in wasm handling
		// serves it as `application/wasm`, so a module worker rejects it on
		// the strict MIME check instead of instantiating it.
		wasmReady = init();
	}
	return wasmReady;
}

self.onmessage = (e) => {
	const msg = e.data;
	if (msg?.type === 'start') {
		cfg = { prefix: msg.prefix || '', suffix: msg.suffix || '', ignoreCase: !!msg.ignoreCase };
		attempts = 0;
		running = true;
		kick();
	} else if (msg?.type === 'resume') {
		running = true;
		kick();
	} else if (msg?.type === 'pause' || msg?.type === 'stop') {
		running = false;
	}
};

/** Start the hot loop unless one is already in flight. */
function kick() {
	if (!looping) grindLoop();
}

async function grindLoop() {
	looping = true;
	try {
		await ensureWasm();
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err?.message || err) });
		looping = false;
		return;
	}

	let lastProgress = performance.now();
	let lastProgressAttempts = attempts;
	const seed = new Uint8Array(32);

	while (running) {
		crypto.getRandomValues(seed);
		const hit = grind(cfg.prefix, cfg.suffix, cfg.ignoreCase, BATCH_SIZE, seed);
		attempts += BATCH_SIZE;

		if (hit) {
			self.postMessage({
				type: 'match',
				publicKey: hit.publicKey,
				secretKey: hit.secretKey,
				attempts,
			}, [hit.secretKey.buffer]);
			running = false;
			break;
		}

		const now = performance.now();
		if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
			const elapsed = (now - lastProgress) / 1000;
			const rate = elapsed > 0 ? (attempts - lastProgressAttempts) / elapsed : 0;
			self.postMessage({ type: 'progress', attempts, rate });
			lastProgress = now;
			lastProgressAttempts = attempts;
			// Yield to the event loop so 'pause'/'stop' messages get processed.
			await new Promise((r) => setTimeout(r, 0));
		}
	}

	looping = false;
}
