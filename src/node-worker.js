/**
 * worker_threads entry for the multi-core grinder.
 *
 * One WASM instance per worker, one fresh CSPRNG seed per batch. Batches are
 * small enough that the message loop stays responsive, so `terminate()` from the
 * pool takes effect within one batch rather than after a multi-second block.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { initSync, grind } from './wasm/vanity_grinder.js';

const BATCH_SIZE = 5000;
const PROGRESS_INTERVAL_MS = 250;

initSync({ module: readFileSync(fileURLToPath(new URL('./wasm/vanity_grinder_bg.wasm', import.meta.url))) });

const { prefix, suffix, ignoreCase } = workerData;
const seed = new Uint8Array(32);
let attempts = 0;
let lastProgress = 0;

for (;;) {
	crypto.getRandomValues(seed);
	const hit = grind(prefix, suffix, ignoreCase, BATCH_SIZE, seed);
	attempts += BATCH_SIZE;

	if (hit) {
		parentPort.postMessage({
			type: 'hit',
			publicKey: hit.publicKey,
			secretKey: Array.from(hit.secretKey),
			attempts,
		});
		break;
	}

	const now = Date.now();
	if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
		lastProgress = now;
		parentPort.postMessage({ type: 'progress', attempts });
	}
}
