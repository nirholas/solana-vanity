/**
 * The grinder must return a key that actually controls the address it claims.
 * Everything else this project does is downstream of that being true, so the
 * check is independent: re-derive the public key from the returned seed with a
 * different library (@noble) than the one that produced it (Rust in WASM).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import { grindVanityPool } from '../src/grinder-pool.js';
import { grindVanityNode } from '../src/grinder-node.js';

test('the multi-core pool returns a keypair that matches its address', async () => {
	const result = await grindVanityPool({ prefix: 'a', ignoreCase: true, workers: 2 });

	assert.equal(result.secretKey.length, 64, "Solana's layout is [32-byte seed][32-byte pubkey]");
	assert.ok(result.publicKey.toLowerCase().startsWith('a'));

	// Independently re-derive: seed -> public key, via a different implementation.
	const derived = ed25519.getPublicKey(result.secretKey.slice(0, 32));
	assert.equal(bs58.encode(derived), result.publicKey, 'WASM and @noble must agree bit for bit');
	// The trailing half of the secret key is the public key, as Solana expects.
	assert.deepEqual(Array.from(result.secretKey.slice(32)), Array.from(derived));

	assert.ok(result.attempts > 0);
	assert.ok(result.workers === 2);
});

test('the pool honours a suffix as well as a prefix', async () => {
	const result = await grindVanityPool({ suffix: 'z', ignoreCase: true, workers: 2 });
	assert.ok(result.publicKey.toLowerCase().endsWith('z'));
});

test('an aborted grind rejects promptly and frees its workers', async () => {
	const controller = new AbortController();
	// A six-character case-sensitive pattern will not land inside the timeout, so
	// the only way this test finishes is the abort path working.
	const promise = grindVanityPool({ prefix: 'zzzzzz', workers: 2, signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(promise, (err) => err.name === 'AbortError');
});

test('the pool refuses an invalid pattern before spawning anything', async () => {
	await assert.rejects(grindVanityPool({ prefix: 'AOB' }), /invalid prefix/);
	await assert.rejects(grindVanityPool({}), /prefix or suffix is required/);
});

test('the single-threaded grinder produces a valid keypair too', () => {
	const result = grindVanityNode({ prefix: 'a', ignoreCase: true, timeBudgetMs: 20_000 });
	assert.ok(result.publicKey.toLowerCase().startsWith('a'));
	assert.equal(bs58.encode(ed25519.getPublicKey(result.secretKey.slice(0, 32))), result.publicKey);
});

test('the single-threaded grinder refuses a pattern it cannot finish in budget', () => {
	assert.throws(
		() => grindVanityNode({ prefix: 'zzzzzz', timeBudgetMs: 1000 }),
		(err) => err.code === 'pattern_infeasible' || err.code === 'pattern_too_long',
	);
});
