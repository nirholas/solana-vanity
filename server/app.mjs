/**
 * The solana-vanity HTTP API.
 *
 * One Fetch handler, two hosts (Node and Cloudflare Workers). Every route is
 * either pure maths (quote, appraise, difficulty table) or pure verification
 * (certify, verify, split-key), with exactly one exception: `/api/grind`, which
 * is the only endpoint that can ever hold a secret key and is therefore off by
 * default and shouted about in the docs.
 *
 * Design rule for this file: the server must never become a party you have to
 * trust. Anything it returns is either checkable offline (a signature, a
 * derivation) or has no security content at all (a probability). That is why
 * delegation is implemented as split-key grinding rather than "we grind it and
 * email you the key".
 */

import bs58 from 'bs58';

import { createRouter, json, text, body, assert, HttpError } from './router.mjs';
import { attestationKey, publicKeyring } from './keys.mjs';
import {
	validatePattern, expectedAttempts, expectedAttemptsUniform, effectiveLength,
	formatTimeEstimate, MAX_PATTERN_LENGTH, DIFFICULTY_MODEL,
} from '../src/validation.js';
import { LEADING_CHAR_PROBABILITY, leadingCharDifficultyRatio, patternProbability } from '../src/base58-distribution.js';
import { computeRarity, appraiseAddress, RARITY_TIERS } from '../src/rarity.js';
import {
	buildCertificateCore, signCertificate, verifyProofOfGrind,
	FORMAT_KEYPAIR, FORMAT_SPLIT_KEY, SUPPORTED_FORMATS,
} from '../src/proof-of-grind.js';
import {
	grindSplitKeyOffset, verifySplitKeyClaim, isValidP1, p1Fingerprint,
	validateSplitKeyPattern, offsetPoint, parsePoint, pointToAddress, SPLIT_KEY_PROTOCOL,
} from '../src/split-key.js';
import { agentCard, mcpDescriptor, llmsTxt, openApi, robotsTxt, sitemapXml } from './discovery.mjs';

export const SERVICE = {
	name: 'solana-vanity',
	version: '1.0.0',
	description: 'Solana vanity address grinding: exact difficulty maths, signed proof-of-grind certificates, and trustless split-key delegation.',
	repository: 'https://github.com/nirholas/solana-vanity',
	license: 'Apache-2.0',
};

/** Server-side split-key grinds are bounded so one caller cannot hold a worker. */
const SPLITKEY_MAX_MS = 20_000;
const SPLITKEY_DEFAULT_MS = 8_000;

const router = createRouter();

// ── Health ───────────────────────────────────────────────────────────────────
router.get('/api/health', ({ env }) => {
	const key = attestationKey(env);
	return json({
		ok: true,
		service: SERVICE.name,
		version: SERVICE.version,
		attestation: { keyId: key.keyId, publicKeyBase58: key.publicKeyBase58, ephemeral: key.ephemeral },
		serverGrind: serverGrindEnabled(env),
		difficultyModel: DIFFICULTY_MODEL,
	});
});

// ── Quote: what does this pattern cost? ──────────────────────────────────────
router.post('/api/quote', async ({ req, env }) => {
	const b = await body(req);
	const { prefix, suffix, ignoreCase } = readPattern(b);
	const rate = positiveNumber(b.attemptsPerSecond, 0);

	const attempts = expectedAttempts(prefix, suffix, ignoreCase);
	const uniform = expectedAttemptsUniform(prefix, suffix, ignoreCase);
	const rarity = computeRarity({ prefix, suffix, ignoreCase });

	return json({
		pattern: { prefix, suffix, ignoreCase },
		probability: patternProbability({ prefix, suffix, ignoreCase }),
		difficulty: {
			model: DIFFICULTY_MODEL,
			expectedAttempts: attempts,
			effectiveLength: effectiveLength(attempts),
			// The naive model every other grinder ships, and how far off it is here.
			// Shown, not hidden: a caller comparing quotes deserves to see why ours
			// differs from a tool that assumes every Base58 character is uniform.
			uniformModel: { expectedAttempts: uniform, ratio: uniform > 0 ? attempts / uniform : null },
			leadingCharPenalty: prefix ? leadingCharDifficultyRatio(prefix[0]) : null,
		},
		rarity,
		eta: rate > 0 ? { attemptsPerSecond: rate, human: formatTimeEstimate(attempts, rate), seconds: attempts / rate } : null,
		limits: { maxPatternLength: MAX_PATTERN_LENGTH },
	}, { cache: 'public, max-age=3600' });
});

// ── Appraise an address that already exists ──────────────────────────────────
router.post('/api/appraise', async ({ req }) => {
	const b = await body(req);
	const address = String(b.address || '').trim();
	assert(address, 'address is required');
	let decoded;
	try {
		decoded = bs58.decode(address);
	} catch {
		throw new HttpError(400, 'address is not valid Base58');
	}
	assert(decoded.length === 32, 'address must decode to 32 bytes');

	const opts = {
		ignoreCase: !!b.ignoreCase,
		...(Number.isInteger(b.prefixLen) ? { prefixLen: b.prefixLen } : {}),
		...(Number.isInteger(b.suffixLen) ? { suffixLen: b.suffixLen } : {}),
		...(positiveNumber(b.ratePerSecond, 0) ? { ratePerSecond: Number(b.ratePerSecond) } : {}),
	};
	return json({ appraisal: appraiseAddress(address, opts) }, { cache: 'public, max-age=3600' });
});

// ── The Base58 leading-character table (why quotes look the way they do) ─────
router.get('/api/difficulty/leading-characters', () => json({
	model: DIFFICULTY_MODEL,
	note: 'Base58 encodes a 256-bit integer, so the leading character is not uniform. These are exact probabilities over the whole key space, summing to 1.',
	characters: Object.entries(LEADING_CHAR_PROBABILITY).map(([character, probability]) => ({
		character,
		probability,
		versusUniform: leadingCharDifficultyRatio(character),
	})),
	tiers: RARITY_TIERS,
}, { cache: 'public, max-age=86400' }));

// ── Certificates ─────────────────────────────────────────────────────────────
router.post('/api/certify', async ({ req, env }) => {
	const b = await body(req);
	const { prefix, suffix, ignoreCase } = readPattern(b);
	const address = String(b.address || '').trim();
	assert(address, 'address is required');

	let decoded;
	try {
		decoded = bs58.decode(address);
	} catch {
		throw new HttpError(400, 'address is not valid Base58');
	}
	assert(decoded.length === 32, 'address must decode to 32 bytes');

	// The certificate attests provenance, so it must not attest a lie: an address
	// that does not actually match the claimed pattern is refused outright.
	const lower = (s) => (ignoreCase ? s.toLowerCase() : s);
	assert(!prefix || lower(address).startsWith(lower(prefix)), 'address does not start with the claimed prefix');
	assert(!suffix || lower(address).endsWith(lower(suffix)), 'address does not end with the claimed suffix');

	const format = SUPPORTED_FORMATS.includes(b.format) ? b.format : FORMAT_KEYPAIR;

	// A split-key certificate whose non-custody assertion is missing or wrong can
	// never verify, so refuse to mint one rather than hand back a document that
	// fails the moment anyone checks it.
	if (format === FORMAT_SPLIT_KEY) {
		const nc = b.nonCustody;
		assert(nc && nc.buyerPublicKey && nc.serverComponent,
			'a split-key certificate needs nonCustody: { buyerPublicKey, serverComponent }');
		const derived = verifySplitKeyClaim({
			p1: String(nc.buyerPublicKey),
			offset: b.offset ? String(b.offset) : null,
			address,
			pattern: { prefix, suffix, ignoreCase },
		});
		// Without the offset we cannot re-derive, so check the published points
		// add up instead: that is the same equation a verifier will run.
		const sumOk = b.offset
			? derived.derivationOk
			: pointsAddUp(String(nc.buyerPublicKey), String(nc.serverComponent), address);
		assert(sumOk, 'buyerPublicKey + serverComponent does not equal the address');
	}

	const key = attestationKey(env);

	const core = buildCertificateCore({
		address,
		pattern: { prefix, suffix, ignoreCase },
		format,
		attempts: positiveNumber(b.attempts, 0) || null,
		scheme: typeof b.scheme === 'string' ? b.scheme.slice(0, 64) : undefined,
		keyId: key.keyId,
		...(b.nonCustody ? { nonCustody: b.nonCustody } : {}),
	});
	const certificate = signCertificate({ core, signingSeed: key.seed, keyId: key.keyId });

	return json({
		certificate,
		keyId: key.keyId,
		ephemeralKey: key.ephemeral,
		verify: '/api/verify',
		keyring: '/.well-known/solana-vanity.json',
		...(key.ephemeral
			? { warning: 'This service is running with an ephemeral attestation key. The certificate verifies now and stops verifying when the process restarts. Set ATTESTATION_SEED for a durable identity.' }
			: {}),
	});
});

router.post('/api/verify', async ({ req, env }) => {
	const b = await body(req);
	const cert = b.certificate ?? b;
	assert(cert && typeof cert === 'object', 'send { "certificate": { … } }');
	const result = verifyProofOfGrind(cert, { keyring: publicKeyring(env) });
	return json({
		valid: result.valid,
		address: result.address,
		certId: result.certId,
		checks: result.checks,
	});
});

// ── Split-key delegation: grind for a caller without ever holding their key ──
router.post('/api/splitkey/grind', async ({ req, env }) => {
	const b = await body(req);
	const p1 = String(b.p1 || '').trim();
	assert(p1, 'p1 is required: the public point a1·B you generated locally');
	assert(isValidP1(p1), 'p1 is not a valid Ed25519 point');

	const { prefix, suffix, ignoreCase } = readPattern(b);
	// The split-key module validates independently of readPattern, and throws
	// rather than returning a flag; surface its message as a 400 instead of a 500.
	try {
		validateSplitKeyPattern({ prefix, suffix, ignoreCase });
	} catch (err) {
		throw new HttpError(400, err.message);
	}

	const budget = Math.min(SPLITKEY_MAX_MS, positiveNumber(b.timeBudgetMs, SPLITKEY_DEFAULT_MS));
	const started = Date.now();
	const result = grindSplitKeyOffset({ p1, prefix, suffix, ignoreCase, timeBudgetMs: budget });

	if (!result.found) {
		return json({
			found: false,
			attempts: result.attempts,
			durationMs: result.durationMs,
			timeBudgetMs: budget,
			expectedAttempts: expectedAttempts(prefix, suffix, ignoreCase),
			hint: 'Call again with the same p1 to keep searching, or raise timeBudgetMs (capped at ' + SPLITKEY_MAX_MS + 'ms per request).',
			protocol: SPLIT_KEY_PROTOCOL,
		}, { status: 200 });
	}

	// A found offset is worthless to anyone but the holder of a1, so it is safe
	// to return over the wire: that is the entire point of the protocol.
	const key = attestationKey(env);
	const core = buildCertificateCore({
		address: result.address,
		pattern: { prefix, suffix, ignoreCase },
		format: FORMAT_SPLIT_KEY,
		attempts: result.attempts,
		keyId: key.keyId,
		nonCustody: { buyerPublicKey: p1, serverComponent: offsetPoint(result.offset) },
	});
	const certificate = signCertificate({ core, signingSeed: key.seed, keyId: key.keyId });

	return json({
		found: true,
		protocol: SPLIT_KEY_PROTOCOL,
		address: result.address,
		offset: result.offset,
		serverComponent: offsetPoint(result.offset),
		attempts: result.attempts,
		durationMs: Date.now() - started,
		p1Fingerprint: p1Fingerprint(p1),
		certificate,
		next: 'Combine locally: aFinal = (a1 + offset) mod L. This service cannot compute it, because it never saw a1.',
	});
});

router.post('/api/splitkey/verify', async ({ req }) => {
	const b = await body(req);
	assert(b.p1 && b.offset && b.address, 'p1, offset and address are required');
	const result = verifySplitKeyClaim({
		p1: String(b.p1),
		offset: String(b.offset),
		address: String(b.address),
		pattern: b.pattern && typeof b.pattern === 'object' ? b.pattern : undefined,
	});
	return json(result);
});

// ── Server-side grind (opt-in, custodial, loudly labelled) ───────────────────
router.post('/api/grind', async ({ req, env }) => {
	if (!serverGrindEnabled(env)) {
		throw new HttpError(
			403,
			'Server-side grinding is disabled on this deployment. It hands a secret key over a network, which this project treats as a last resort. Use the browser grinder, the CLI, or POST /api/splitkey/grind, which delegates the work without anyone else ever holding your key.',
			{ enable: 'set ALLOW_SERVER_GRIND=1 to enable it on a deployment you control' },
		);
	}
	const b = await body(req);
	const { prefix, suffix, ignoreCase } = readPattern(b);

	// Loaded lazily: it reads the WebAssembly module off disk, which only exists
	// on a filesystem host (Node/Docker), never on an edge runtime.
	let grindVanityNode;
	try {
		({ grindVanityNode } = await import('../src/grinder-node.js'));
	} catch (err) {
		throw new HttpError(501, `this runtime cannot run the native grinder (${err.message}); use /api/splitkey/grind`);
	}

	const result = grindVanityNode({
		prefix,
		suffix,
		ignoreCase,
		timeBudgetMs: Math.min(SPLITKEY_MAX_MS, positiveNumber(b.timeBudgetMs, SPLITKEY_DEFAULT_MS)),
	});

	return json({
		...result,
		secretKey: result.secretKey ? Array.from(result.secretKey) : null,
		custodyWarning: 'This secret key travelled over the network and existed in this server process. Treat it as compromised for anything of value, and prefer /api/splitkey/grind.',
	});
});

// ── Discovery: humans, crawlers, agents ──────────────────────────────────────
router.get('/.well-known/solana-vanity.json', ({ env, url }) => json({
	service: SERVICE.name,
	version: SERVICE.version,
	description: SERVICE.description,
	repository: SERVICE.repository,
	license: SERVICE.license,
	protocols: { certificate: 'three-pog/v1', splitKey: SPLIT_KEY_PROTOCOL, difficultyModel: DIFFICULTY_MODEL },
	attestationKeys: publicKeyring(env),
	endpoints: {
		quote: `${url.origin}/api/quote`,
		appraise: `${url.origin}/api/appraise`,
		certify: `${url.origin}/api/certify`,
		verify: `${url.origin}/api/verify`,
		splitKeyGrind: `${url.origin}/api/splitkey/grind`,
		openapi: `${url.origin}/openapi.json`,
	},
}, { cache: 'public, max-age=300' }));

router.get('/.well-known/agents.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/agent.json', ({ url }) => json(agentCard(url.origin), { cache: 'public, max-age=3600' }));
router.get('/.well-known/mcp.json', ({ url }) => json(mcpDescriptor(url.origin), { cache: 'public, max-age=3600' }));
router.get('/openapi.json', ({ url }) => json(openApi(url.origin), { cache: 'public, max-age=3600' }));
router.get('/llms.txt', ({ url }) => text(llmsTxt(url.origin), { cache: 'public, max-age=3600' }));
router.get('/robots.txt', ({ url }) => text(robotsTxt(url.origin)));
router.get('/sitemap.xml', ({ url }) => text(sitemapXml(url.origin), { type: 'application/xml; charset=utf-8' }));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pull a validated pattern out of a request body. Rejects anything the grinder
 * itself would reject, so a caller never gets a 200 for work that cannot happen.
 * @param {Record<string, any>} b
 * @returns {{ prefix: string, suffix: string, ignoreCase: boolean }}
 */
function readPattern(b) {
	const prefix = String(b.prefix ?? '').trim();
	const suffix = String(b.suffix ?? '').trim();
	const ignoreCase = !!b.ignoreCase;
	assert(prefix || suffix, 'give a prefix, a suffix, or both');
	for (const [side, value] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		assert(v.valid, `${side}: ${v.errors.join('; ')}`);
	}
	assert(
		prefix.length + suffix.length <= MAX_PATTERN_LENGTH,
		`prefix + suffix exceed ${MAX_PATTERN_LENGTH} characters combined`,
	);
	return { prefix, suffix, ignoreCase };
}

/**
 * Check `P1 + a2·B == address` from public values only. The same equation a
 * certificate verifier runs, used here so the service cannot issue a
 * non-custody claim that does not hold.
 * @param {string} p1
 * @param {string} serverComponent
 * @param {string} address
 * @returns {boolean}
 */
function pointsAddUp(p1, serverComponent, address) {
	try {
		return pointToAddress(parsePoint(p1).add(parsePoint(serverComponent))) === address;
	} catch {
		return false;
	}
}

/** @param {any} value @param {number} fallback @returns {number} */
function positiveNumber(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {Record<string, any>} env @returns {boolean} */
function serverGrindEnabled(env) {
	const flag = env?.ALLOW_SERVER_GRIND ?? (typeof process !== 'undefined' ? process.env?.ALLOW_SERVER_GRIND : undefined);
	return flag === '1' || flag === 'true';
}

/**
 * The application handler. Returns `null` when nothing matched so a host can
 * serve static assets from the same origin.
 * @param {Request} req
 * @param {any} [env]
 * @returns {Promise<Response|null>}
 */
export function handle(req, env) {
	return router.handle(req, env);
}
