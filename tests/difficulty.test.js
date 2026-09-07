/**
 * The difficulty model is the load-bearing claim of this project: every quote,
 * price and rarity tier is derived from it. These tests pin it against first
 * principles (a total probability of exactly 1, the six documented bands) and
 * against reality (direct sampling of real Ed25519 keypairs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import {
	BASE58_ALPHABET, LEADING_CHAR_PROBABILITY, prefixProbability, suffixProbability,
	patternProbability, leadingCharDifficultyRatio, caseVariants,
} from '../src/base58-distribution.js';
import { expectedAttempts, expectedAttemptsUniform, validatePattern, effectiveLength } from '../src/validation.js';

test('leading-character probabilities sum to exactly 1', () => {
	const total = Object.values(LEADING_CHAR_PROBABILITY).reduce((a, b) => a + b, 0);
	assert.ok(Math.abs(total - 1) < 1e-12, `sum was ${total}`);
});

test('the alphabet is the 58 Base58 symbols, with no 0 O I l', () => {
	assert.equal(BASE58_ALPHABET.length, 58);
	for (const ch of '0OIl') assert.ok(!BASE58_ALPHABET.includes(ch), `${ch} must not be in the alphabet`);
});

test('the six documented bands hold', () => {
	// '1' is a leading zero byte: exactly 1/256.
	assert.ok(Math.abs(LEADING_CHAR_PROBABILITY['1'] - 1 / 256) < 1e-9);
	// 'K'-'z' are the hard band, ~17x worse than the naive 1/58.
	assert.ok(leadingCharDifficultyRatio('K') > 17 && leadingCharDifficultyRatio('K') < 17.5);
	assert.ok(leadingCharDifficultyRatio('z') > 17 && leadingCharDifficultyRatio('z') < 17.5);
	// '5'-'H' are the easy band, ~3.4x better.
	assert.ok(leadingCharDifficultyRatio('5') > 0.29 && leadingCharDifficultyRatio('5') < 0.30);
	assert.ok(leadingCharDifficultyRatio('H') > 0.29 && leadingCharDifficultyRatio('H') < 0.30);
	// The naive model treats them as identical; the whole point is that it is wrong.
	assert.notEqual(LEADING_CHAR_PROBABILITY['K'], LEADING_CHAR_PROBABILITY['5']);
});

test('suffix probability is uniform 58^-n', () => {
	assert.ok(Math.abs(suffixProbability('a') - 1 / 58) < 1e-15);
	assert.ok(Math.abs(suffixProbability('ab') - 1 / (58 * 58)) < 1e-15);
	assert.equal(suffixProbability(''), 1);
});

test('a prefix probability matches direct sampling of real keypairs', () => {
	// '5' leads the easy band: the exact model says 5.90e-2 where the naive 1/58
	// model says 1.72e-2, a gap wide enough that a few thousand real keypairs
	// separate them decisively without making the suite slow.
	const SAMPLES = 8000;
	let hits = 0;
	for (let i = 0; i < SAMPLES; i++) {
		const address = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
		if (address[0] === '5') hits++;
	}
	const observed = hits / SAMPLES;
	const exact = prefixProbability('5');
	const naive = 1 / 58;

	assert.ok(
		Math.abs(observed - exact) < Math.abs(observed - naive),
		`exact model (${exact}) should beat the naive one (${naive}) against observed ${observed}`,
	);
	// Within four standard errors of the exact prediction: a real regression in
	// the model fails this, sampling noise does not.
	const stderr = Math.sqrt((exact * (1 - exact)) / SAMPLES);
	assert.ok(
		Math.abs(observed - exact) < 4 * stderr,
		`observed ${observed} is more than 4 standard errors (${(4 * stderr).toFixed(5)}) from ${exact}`,
	);
});

test('combined patterns multiply', () => {
	const p = patternProbability({ prefix: 'A', suffix: 'b' });
	assert.ok(Math.abs(p - prefixProbability('A') * suffixProbability('b')) < 1e-18);
});

test('case-insensitive patterns are cheaper, and impossible spellings are rejected', () => {
	assert.ok(expectedAttempts('ag', '', true) < expectedAttempts('ag', '', false));
	// Base58 has no uppercase I, so a case-insensitive 'i' has only one spelling.
	assert.deepEqual(caseVariants('i'), ['i']);
	// It has no lowercase l either, so 'L' cannot be lowercased.
	assert.deepEqual(caseVariants('L'), ['L']);
});

test('validatePattern rejects the four missing symbols by name', () => {
	for (const [ch, hint] of [['0', 'zero'], ['O', 'uppercase o'], ['I', 'uppercase i'], ['l', 'lowercase L']]) {
		const v = validatePattern(`A${ch}B`);
		assert.equal(v.valid, false, `${ch} should be rejected`);
		assert.ok(v.errors.join(' ').toLowerCase().includes(hint.toLowerCase()), `error should mention ${hint}: ${v.errors}`);
	}
	assert.equal(validatePattern('AGNT').valid, true);
});

test('the exact and naive models disagree in the documented direction', () => {
	// A leading 'K' is harder than the naive model says.
	assert.ok(expectedAttempts('K', '', false) > expectedAttemptsUniform('K', '', false));
	// A leading '5' is easier.
	assert.ok(expectedAttempts('5', '', false) < expectedAttemptsUniform('5', '', false));
});

test('effectiveLength converts attempts back to a comparable character count', () => {
	assert.ok(Math.abs(effectiveLength(58) - 1) < 1e-9);
	assert.ok(Math.abs(effectiveLength(58 * 58) - 2) < 1e-9);
});
