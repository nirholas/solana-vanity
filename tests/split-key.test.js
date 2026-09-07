/**
 * Split-key grinding is the security claim that a delegated grind cannot expose
 * a key. These tests exercise the whole loop and, more importantly, the ways it
 * must fail: a tampered offset, a tampered address, and a pattern the returned
 * address does not actually match.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import {
	generateRequesterShare, grindSplitKeyOffset, verifySplitKeyClaim, combineScalars,
	offsetPoint, expandedSecretKey, signWithScalar, verifySignature, isValidP1, p1Fingerprint,
} from '../src/split-key.js';

test('a delegated grind produces a key only the requester can compute', () => {
	const share = generateRequesterShare();
	assert.ok(isValidP1(share.p1));

	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', ignoreCase: true, timeBudgetMs: 10_000 });
	assert.equal(hit.found, true, 'a one-character pattern must be found inside the budget');
	assert.ok(hit.address.toLowerCase().startsWith('a'));

	// The verifier needs no secret at all.
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: hit.offset, address: hit.address, pattern: { prefix: 'a', ignoreCase: true } });
	assert.equal(claim.ok, true, claim.reason);

	// Only the requester, holding a1, can produce the final scalar.
	const combined = combineScalars(share.a1, hit.offset);
	assert.equal(combined.address, hit.address);

	// And the published non-custody equation holds: P1 + a2*B == address.
	const serverComponent = offsetPoint(hit.offset);
	const sum = ed25519.Point.fromBytes(bs58.decode(share.p1)).add(ed25519.Point.fromBytes(bs58.decode(serverComponent)));
	assert.equal(bs58.encode(sum.toBytes()), hit.address);
});

test('the combined scalar actually signs for the address', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', ignoreCase: true, timeBudgetMs: 10_000 });
	const combined = combineScalars(share.a1, hit.offset);

	const message = new TextEncoder().encode('solana-vanity split-key test vector');
	const signature = signWithScalar(message, combined.scalar);
	assert.equal(verifySignature(message, signature, bs58.decode(combined.address)), true);

	// Tampering with the message must break verification.
	const other = new TextEncoder().encode('a different message');
	assert.equal(verifySignature(other, signature, bs58.decode(combined.address)), false);

	// The expanded key is the documented 64 bytes.
	assert.equal(expandedSecretKey(combined.scalar).length, 64);
});

test('a tampered offset is rejected', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', ignoreCase: true, timeBudgetMs: 10_000 });

	// Flip one byte of the offset: the derived address no longer matches.
	const bad = hit.offset.slice(0, -2) + (hit.offset.endsWith('00') ? '01' : '00');
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: bad, address: hit.address });
	assert.equal(claim.ok, false);
	assert.equal(claim.derivationOk, false);
});

test('an address that does not match the pattern is rejected even when the derivation is right', () => {
	const share = generateRequesterShare();
	const hit = grindSplitKeyOffset({ p1: share.p1, prefix: 'a', ignoreCase: true, timeBudgetMs: 10_000 });
	// Same valid derivation, but claim a pattern the address does not satisfy.
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: hit.offset, address: hit.address, pattern: { prefix: 'zzz' } });
	assert.equal(claim.ok, false);
	assert.equal(claim.derivationOk, true);
	assert.equal(claim.patternOk, false);
});

test('a P1 that is not a curve point is refused', () => {
	assert.equal(isValidP1('not-base58-at-all!!'), false);
	assert.equal(isValidP1(''), false);
	// A valid Base58 string of the wrong length is not a point either.
	assert.equal(isValidP1(bs58.encode(new Uint8Array(31))), false);
});

test('the P1 fingerprint is stable and short', () => {
	const share = generateRequesterShare();
	const a = p1Fingerprint(share.p1);
	const b = p1Fingerprint(share.p1);
	assert.equal(a, b);
	assert.equal(a.length, 16);
});

test('two requesters grinding the same pattern get different keys', () => {
	const one = generateRequesterShare();
	const two = generateRequesterShare();
	assert.notEqual(one.a1, two.a1);
	assert.notEqual(one.p1, two.p1);
});
