/**
 * Mnemonic derivation must land on the exact address Phantom, Solflare and the
 * Solana CLI import. The vectors below were produced by the previous
 * web3.js 1.x Keypair.fromSeed implementation and are pinned here so the
 * derivation cannot drift when the web3.js major changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import { deriveSolanaKeypair, generateMnemonic } from '../src/mnemonic.js';
import { grindVanityMnemonic } from '../src/mnemonic-grinder.js';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('default path derives the pinned Phantom account 0 address and 64-byte secret key', () => {
	const { publicKey, secretKey, derivationPath } = deriveSolanaKeypair(ABANDON);
	assert.equal(derivationPath, "m/44'/501'/0'/0'");
	assert.equal(publicKey, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
	assert.equal(
		Buffer.from(secretKey).toString('hex'),
		'37df573b3ac4ad5b522e064e25b63ea16bcbe79d449e81a0268d1047948bb445f036276246a75b9de3349ed42b15e232f6518fc20f5fcd4f1d64e81f9bd258f7',
	);
});

test('account and change indices select a different pinned address', () => {
	assert.equal(deriveSolanaKeypair(ABANDON, { account: 1, change: 2 }).publicKey, '7hSUUVngwwrudjkmYMbvsM4u1YkLKGX77ELFVniH4a9p');
});

test('the secret key is seed then public key and signs for the returned address', () => {
	const { publicKey, secretKey } = deriveSolanaKeypair(generateMnemonic());
	assert.equal(secretKey.length, 64);
	assert.deepEqual(bs58.decode(publicKey), secretKey.slice(32));
	const message = new TextEncoder().encode('vanity');
	const signature = ed25519.sign(message, secretKey.slice(0, 32));
	assert.ok(ed25519.verify(signature, message, bs58.decode(publicKey)));
});

test('grindVanityMnemonic returns a mnemonic that re-derives the reported address', () => {
	const hit = grindVanityMnemonic({ prefix: 'a', ignoreCase: true, timeBudgetMs: 20_000 });
	const again = deriveSolanaKeypair(hit.mnemonic);
	assert.equal(again.publicKey, hit.publicKey);
	assert.deepEqual(Array.from(again.secretKey), Array.from(hit.secretKey));
	assert.equal(hit.publicKey[0].toLowerCase(), 'a');
});
