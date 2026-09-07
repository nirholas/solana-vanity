/**
 * Multi-core grinder for Node.
 *
 * `grinder-node.js` runs the WebAssembly loop on the calling thread, which is
 * right for a request handler and wrong for a CLI: a laptop has eight cores and
 * a vanity grind is embarrassingly parallel. This module spawns one
 * `worker_threads` worker per requested core, each driving its own instance of
 * the same WASM module from its own CSPRNG seed, and resolves on the first hit.
 *
 * Workers are always torn down: on a hit, on an abort, and on a throw. A grind
 * that leaves eight threads pinned after the process thinks it finished is the
 * kind of bug that only shows up on someone else's machine.
 */

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { validatePattern, expectedAttempts } from './validation.js';

/**
 * @typedef {object} PoolResult
 * @property {string} publicKey
 * @property {Uint8Array} secretKey  64 bytes, `[seed][pubkey]`
 * @property {number} attempts       across every worker
 * @property {number} durationMs
 * @property {number} workers
 */

/**
 * @param {object} opts
 * @param {string} [opts.prefix]
 * @param {string} [opts.suffix]
 * @param {boolean} [opts.ignoreCase=false]
 * @param {number} [opts.workers] defaults to every available core
 * @param {AbortSignal} [opts.signal]
 * @param {(p: { attempts: number, rate: number, workers: number }) => void} [opts.onProgress]
 * @returns {Promise<PoolResult>}
 */
export function grindVanityPool(opts = {}) {
	const prefix = opts.prefix || '';
	const suffix = opts.suffix || '';
	const ignoreCase = !!opts.ignoreCase;

	if (!prefix && !suffix) return Promise.reject(new Error('prefix or suffix is required'));
	for (const [label, pattern] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!pattern) continue;
		const v = validatePattern(pattern);
		if (!v.valid) return Promise.reject(new Error(`invalid ${label}: ${v.errors.join('; ')}`));
	}

	const cores = Math.max(1, Math.min(opts.workers || availableParallelism(), 64));
	const workerPath = fileURLToPath(new URL('./node-worker.js', import.meta.url));
	const started = Date.now();

	return new Promise((resolve, reject) => {
		/** @type {Worker[]} */
		const pool = [];
		/** @type {number[]} */
		const attemptsPer = new Array(cores).fill(0);
		let settled = false;
		let progressTimer = null;

		const total = () => attemptsPer.reduce((a, b) => a + b, 0);

		function cleanup() {
			if (progressTimer) clearInterval(progressTimer);
			progressTimer = null;
			for (const w of pool) w.terminate();
			pool.length = 0;
			opts.signal?.removeEventListener('abort', onAbort);
		}

		function finish(fn, value) {
			if (settled) return;
			settled = true;
			cleanup();
			fn(value);
		}

		function onAbort() {
			finish(reject, Object.assign(new Error('grind aborted'), { name: 'AbortError' }));
		}

		if (opts.signal) {
			if (opts.signal.aborted) return onAbort();
			opts.signal.addEventListener('abort', onAbort, { once: true });
		}

		for (let i = 0; i < cores; i++) {
			const worker = new Worker(workerPath, { workerData: { prefix, suffix, ignoreCase } });
			pool.push(worker);
			worker.on('message', (msg) => {
				if (msg.type === 'progress') {
					attemptsPer[i] = msg.attempts;
					return;
				}
				if (msg.type === 'hit') {
					attemptsPer[i] = msg.attempts;
					const durationMs = Date.now() - started;
					finish(resolve, {
						publicKey: msg.publicKey,
						secretKey: new Uint8Array(msg.secretKey),
						attempts: total(),
						durationMs,
						workers: cores,
					});
				}
			});
			worker.on('error', (err) => finish(reject, err));
		}

		if (opts.onProgress) {
			progressTimer = setInterval(() => {
				const attempts = total();
				const seconds = (Date.now() - started) / 1000;
				opts.onProgress({ attempts, rate: seconds > 0 ? attempts / seconds : 0, workers: cores });
			}, 250);
			// A progress timer must never be the reason the process refuses to exit.
			progressTimer.unref?.();
		}
	});
}

/**
 * Expected attempts for a pattern under the exact Base58 model. Re-exported here
 * so a caller driving the pool does not need a second import for the ETA.
 * @param {string} prefix
 * @param {string} suffix
 * @param {boolean} [ignoreCase]
 * @returns {number}
 */
export function poolExpectedAttempts(prefix, suffix, ignoreCase = false) {
	return expectedAttempts(prefix || '', suffix || '', ignoreCase);
}
