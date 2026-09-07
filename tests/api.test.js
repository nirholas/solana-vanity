/**
 * API tests drive the Fetch handler directly, with no socket and no port. That
 * is the same function the Node server and the Cloudflare Worker both call, so
 * these tests cover both hosts at once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';

import { handle } from '../server/app.mjs';
import { generateRequesterShare, combineScalars } from '../src/split-key.js';

const BASE = 'https://vanity.test';

/**
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function call(path, body) {
	const req = body === undefined
		? new Request(`${BASE}${path}`)
		: new Request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const res = await handle(req, {});
	assert.ok(res, `no route matched ${path}`);
	return { status: res.status, json: await res.json() };
}

test('health reports the attestation identity', async () => {
	const { status, json } = await call('/api/health');
	assert.equal(status, 200);
	assert.equal(json.ok, true);
	assert.ok(json.attestation.publicKeyBase58);
	assert.equal(json.serverGrind, false, 'custodial grinding must be off unless an operator opts in');
});

test('quote returns the exact model and the naive one side by side', async () => {
	const { status, json } = await call('/api/quote', { prefix: 'AGNT', attemptsPerSecond: 100000 });
	assert.equal(status, 200);
	assert.ok(json.difficulty.expectedAttempts > 0);
	assert.ok(json.difficulty.uniformModel.expectedAttempts > 0);
	assert.notEqual(json.difficulty.expectedAttempts, json.difficulty.uniformModel.expectedAttempts);
	assert.ok(json.eta.seconds > 0);
	assert.ok(json.rarity.tierLabel);
});

test('quote rejects characters Base58 does not have', async () => {
	const { status, json } = await call('/api/quote', { prefix: 'A0B' });
	assert.equal(status, 400);
	assert.match(json.error, /prefix/);
});

test('quote rejects an empty pattern', async () => {
	const { status } = await call('/api/quote', {});
	assert.equal(status, 400);
});

test('appraise refuses anything that is not a 32-byte key', async () => {
	assert.equal((await call('/api/appraise', { address: 'not base58 ~~~' })).status, 400);
	assert.equal((await call('/api/appraise', { address: bs58.encode(new Uint8Array(16)) })).status, 400);

	const address = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
	const { status, json } = await call('/api/appraise', { address });
	assert.equal(status, 200);
	assert.equal(json.appraisal.address, address);
});

test('certify refuses to attest a pattern the address does not match', async () => {
	const address = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
	const wrongPrefix = address[0] === 'z' ? 'a' : 'z';
	const { status, json } = await call('/api/certify', { address, prefix: wrongPrefix });
	assert.equal(status, 400);
	assert.match(json.error, /does not start with/);
});

test('certify then verify round-trips, and tampering breaks it', async () => {
	const address = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
	const prefix = address.slice(0, 2);

	const issued = await call('/api/certify', { address, prefix, attempts: 4242 });
	assert.equal(issued.status, 200);

	const ok = await call('/api/verify', { certificate: issued.json.certificate });
	assert.equal(ok.json.valid, true, JSON.stringify(ok.json.checks?.filter((c) => !c.pass)));

	// Change one attested field: the signature must stop verifying.
	const tampered = { ...issued.json.certificate, attempts: 1 };
	const bad = await call('/api/verify', { certificate: tampered });
	assert.equal(bad.json.valid, false);
	assert.ok(bad.json.checks.some((c) => c.id === 'signature' && !c.pass));
});

test('a split-key certificate cannot be minted without a non-custody assertion', async () => {
	const address = bs58.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
	const { status, json } = await call('/api/certify', { address, prefix: address.slice(0, 2), format: 'split-key' });
	assert.equal(status, 400);
	assert.match(json.error, /nonCustody/);
});

test('the split-key endpoint returns an offset that only the requester can use', async () => {
	const share = generateRequesterShare();
	const { status, json } = await call('/api/splitkey/grind', { p1: share.p1, prefix: 'a', ignoreCase: true, timeBudgetMs: 8000 });
	assert.equal(status, 200);
	assert.equal(json.found, true);

	// The response is checkable without any secret.
	const check = await call('/api/splitkey/verify', { p1: share.p1, offset: json.offset, address: json.address, pattern: { prefix: 'a', ignoreCase: true } });
	assert.equal(check.json.ok, true);

	// And the certificate it issued verifies, non-custody check included.
	const verified = await call('/api/verify', { certificate: json.certificate });
	assert.equal(verified.json.valid, true);
	assert.ok(verified.json.checks.some((c) => c.id === 'nonCustody' && c.pass));

	// Only a1 completes the key.
	assert.equal(combineScalars(share.a1, json.offset).address, json.address);
});

test('the split-key endpoint rejects a P1 that is not on the curve', async () => {
	const { status } = await call('/api/splitkey/grind', { p1: 'zzzz', prefix: 'a' });
	assert.equal(status, 400);
});

test('custodial grinding is refused by default, with a pointer to the safe path', async () => {
	const { status, json } = await call('/api/grind', { prefix: 'a' });
	assert.equal(status, 403);
	assert.match(json.error, /splitkey/);
});

test('discovery documents are served and internally consistent', async () => {
	const card = await call('/.well-known/agents.json');
	assert.equal(card.status, 200);
	assert.ok(card.json.skills.length >= 4);
	for (const skill of card.json.skills) assert.ok(skill.endpoint.url.startsWith(BASE), skill.endpoint.url);

	const wellKnown = await call('/.well-known/solana-vanity.json');
	assert.ok(wellKnown.json.attestationKeys[0].publicKeyBase58);

	const openapi = await call('/openapi.json');
	assert.equal(openapi.json.openapi, '3.1.0');
	assert.ok(openapi.json.paths['/api/splitkey/grind']);

	const mcp = await call('/.well-known/mcp.json');
	assert.equal(mcp.json.tools.length, 6);
});

test('an unknown API path 404s as JSON instead of falling through to the site', async () => {
	const res = await handle(new Request(`${BASE}/api/definitely-not-a-route`), {});
	assert.equal(res.status, 404);
	assert.equal((await res.json()).error.includes('no route'), true);
});

test('a non-API path falls through so a host can serve static assets', async () => {
	assert.equal(await handle(new Request(`${BASE}/some/page.html`), {}), null);
});

test('CORS preflight is answered', async () => {
	const res = await handle(new Request(`${BASE}/api/quote`, { method: 'OPTIONS' }), {});
	assert.equal(res.status, 204);
	assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
