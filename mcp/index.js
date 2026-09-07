#!/usr/bin/env node
/**
 * solana-vanity MCP server.
 *
 * Six tools over stdio, so an assistant can price a vanity pattern, appraise an
 * address, grind one locally, delegate a hard one without exposing a key, and
 * verify a certificate.
 *
 * Four of the six need no network at all: they run the same maths and the same
 * WebAssembly grinder the site uses, on the machine hosting the server. Only
 * `vanity_split_key_grind` talks to a remote API, and even then the secret half
 * of the key is generated here and never sent.
 *
 *   { "mcpServers": { "solana-vanity": { "command": "npx", "args": ["-y", "solana-vanity", "mcp"] } } }
 */

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import bs58 from 'bs58';

import { grindVanityPool } from '../src/grinder-pool.js';
import { expectedAttempts, expectedAttemptsUniform, formatTimeEstimate, validatePattern, MAX_PATTERN_LENGTH } from '../src/validation.js';
import { LEADING_CHAR_PROBABILITY, leadingCharDifficultyRatio } from '../src/base58-distribution.js';
import { computeRarity, appraiseAddress } from '../src/rarity.js';
import { verifyProofOfGrind } from '../src/proof-of-grind.js';
import { generateRequesterShare, combineScalars, verifySplitKeyClaim, expandedSecretKey } from '../src/split-key.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const DEFAULT_API = process.env.SOLANA_VANITY_API || 'https://solana-vanity.dev';

/** Guard rails so an assistant cannot pin the host machine indefinitely. */
const GRIND_MAX_MS = Number(process.env.SOLANA_VANITY_MAX_GRIND_MS || 120_000);

const PATTERN_SHAPE = {
	prefix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Base58 characters the address must start with. Base58 has no 0, O, I or l.'),
	suffix: z.string().max(MAX_PATTERN_LENGTH).optional().describe('Base58 characters the address must end with.'),
	ignoreCase: z.boolean().optional().describe('Match letters in any case. Much cheaper, but the resulting casing is not chosen.'),
};

/** @type {Array<{name:string,title:string,description:string,annotations:object,inputSchema:object,handler:Function}>} */
const TOOLS = [
	{
		name: 'vanity_quote',
		title: 'Price a Solana vanity pattern',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Exact difficulty for a Solana vanity pattern: probability, expected attempts, rarity tier and an ETA at a given rate. ' +
			'Uses an exact count over the whole 2^256 key space rather than the 58^n approximation, which is wrong by up to 17x on the leading character. ' +
			'Pure maths, no network, no payment.',
		inputSchema: { ...PATTERN_SHAPE, attemptsPerSecond: z.number().positive().optional().describe('Your grind rate, to turn attempts into wall-clock time.') },
		handler(args) {
			const { prefix, suffix, ignoreCase } = readPattern(args);
			const attempts = expectedAttempts(prefix, suffix, ignoreCase);
			const uniform = expectedAttemptsUniform(prefix, suffix, ignoreCase);
			return {
				pattern: { prefix, suffix, ignoreCase },
				expectedAttempts: attempts,
				naiveModel: { expectedAttempts: uniform, ratio: uniform > 0 ? attempts / uniform : null },
				rarity: computeRarity({ prefix, suffix, ignoreCase }),
				eta: args?.attemptsPerSecond ? formatTimeEstimate(attempts, args.attemptsPerSecond) : null,
			};
		},
	},
	{
		name: 'vanity_appraise',
		title: 'Appraise an existing Solana address',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'Score how much grinding work an existing Solana address represents: which leading and trailing characters look deliberate, ' +
			'the expected attempts behind them, the rarity tier, and any pattern bonuses (dictionary word, palindrome, repeat run). Pure maths, no network.',
		inputSchema: {
			address: z.string().min(32).max(44).describe('Base58 Solana address.'),
			prefixLen: z.number().int().min(0).optional().describe('Override how many leading characters to treat as intentional.'),
			suffixLen: z.number().int().min(0).optional().describe('Override how many trailing characters to treat as intentional.'),
			ignoreCase: z.boolean().optional(),
		},
		handler(args) {
			const address = String(args?.address ?? '').trim();
			const decoded = bs58.decode(address);
			if (decoded.length !== 32) throw new Error(`address decodes to ${decoded.length} bytes, expected 32`);
			return {
				appraisal: appraiseAddress(address, {
					ignoreCase: !!args?.ignoreCase,
					...(Number.isInteger(args?.prefixLen) ? { prefixLen: args.prefixLen } : {}),
					...(Number.isInteger(args?.suffixLen) ? { suffixLen: args.suffixLen } : {}),
				}),
			};
		},
	},
	{
		name: 'vanity_grind',
		title: 'Grind a Solana vanity keypair locally',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			'Grind a Solana keypair whose address matches a pattern, using every core of the machine running this MCP server. ' +
			'Returns the address and the 64-byte secret key. The key is generated here and never leaves this machine, but it DOES cross ' +
			'the MCP transport into the calling assistant, so treat the result as sensitive and prefer vanity_split_key_grind for anything valuable.',
		inputSchema: {
			...PATTERN_SHAPE,
			cores: z.number().int().min(1).max(64).optional().describe(`Workers to use. Defaults to every core (${availableParallelism()} here).`),
			timeBudgetMs: z.number().int().positive().optional().describe(`Give up after this long. Capped at ${GRIND_MAX_MS}ms.`),
		},
		async handler(args) {
			const { prefix, suffix, ignoreCase } = readPattern(args);
			const budget = Math.min(GRIND_MAX_MS, args?.timeBudgetMs || GRIND_MAX_MS);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), budget);
			try {
				const result = await grindVanityPool({ prefix, suffix, ignoreCase, workers: args?.cores, signal: controller.signal });
				return {
					address: result.publicKey,
					secretKey: Array.from(result.secretKey),
					secretKeyBase58: bs58.encode(result.secretKey),
					attempts: result.attempts,
					durationMs: result.durationMs,
					workers: result.workers,
					rarity: computeRarity({ prefix, suffix, ignoreCase }),
					note: 'Solana CLI keypair format: write the secretKey array to a .json file to use it with `solana`.',
				};
			} catch (err) {
				if (err?.name === 'AbortError') {
					throw new Error(`no match within ${budget}ms. This pattern needs ~${Math.round(expectedAttempts(prefix, suffix, ignoreCase)).toLocaleString('en-US')} attempts; raise timeBudgetMs, shorten the pattern, or use vanity_split_key_grind.`);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	},
	{
		name: 'vanity_split_key_grind',
		title: 'Delegate a grind without exposing a key',
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		description:
			'Delegate a hard vanity pattern to a remote grinder using split-key arithmetic. A secret scalar a1 is generated here and never sent; ' +
			'the remote service searches offsets a2 against the public point P1 = a1*B and returns a2, which is useless without a1. ' +
			'The final key is combined and verified locally. The result is an expanded Ed25519 key (a raw scalar, not a seed): it signs correctly ' +
			'but seed-only wallet imports will reject it.',
		inputSchema: {
			...PATTERN_SHAPE,
			api: z.string().url().optional().describe(`API base URL. Defaults to ${DEFAULT_API}.`),
			maxRounds: z.number().int().min(1).max(50).optional().describe('How many time-boxed remote requests to make before giving up. Default 5.'),
		},
		async handler(args) {
			const { prefix, suffix, ignoreCase } = readPattern(args);
			const api = String(args?.api || DEFAULT_API).replace(/\/$/, '');
			const share = generateRequesterShare();
			const maxRounds = args?.maxRounds || 5;

			let attempts = 0;
			for (let round = 1; round <= maxRounds; round++) {
				const r = await fetch(`${api}/api/splitkey/grind`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ p1: share.p1, prefix, suffix, ignoreCase, timeBudgetMs: 15000 }),
				});
				const data = await r.json();
				if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
				attempts += data.attempts || 0;
				if (!data.found) continue;

				const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern: { prefix, suffix, ignoreCase } });
				if (!claim.ok) throw new Error(`the remote grinder returned an offset that does not produce its claimed address: ${claim.reason}`);
				const combined = combineScalars(share.a1, data.offset);
				if (combined.address !== data.address) throw new Error('local combination disagreed with the delegated address');

				return {
					address: combined.address,
					expandedSecretKeyHex: Buffer.from(expandedSecretKey(combined.scalar)).toString('hex'),
					attempts,
					rounds: round,
					certificate: data.certificate ?? null,
					nonCustody: 'P1 + a2*B == address was checked locally. The remote service never held a1 and could not derive this key.',
				};
			}
			return { found: false, attempts, rounds: maxRounds, hint: 'Raise maxRounds, or shorten the pattern.' };
		},
	},
	{
		name: 'vanity_verify_certificate',
		title: 'Verify a proof-of-grind certificate',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		description:
			'Verify a proof-of-grind certificate: signature, key ring membership, certificate id, pattern match, difficulty claim, rarity claim, freshness, ' +
			'and for split-key grinds the non-custody equation P1 + a2*B == address. Every claim is recomputed rather than trusted. ' +
			'Fetches the issuer key ring when reachable, and says so when it is not.',
		inputSchema: {
			certificate: z.record(z.string(), z.unknown()).describe('The certificate document.'),
			api: z.string().url().optional().describe('Issuer base URL for the published key ring.'),
		},
		async handler(args) {
			const cert = args?.certificate?.certificate ?? args?.certificate;
			if (!cert || typeof cert !== 'object') throw new Error('certificate must be an object');
			const api = String(args?.api || DEFAULT_API).replace(/\/$/, '');
			let keyring = null;
			try {
				const r = await fetch(`${api}/.well-known/solana-vanity.json`);
				if (r.ok) keyring = (await r.json()).attestationKeys || null;
			} catch {
				keyring = null;
			}
			const result = verifyProofOfGrind(cert, keyring ? { keyring } : {});
			return { ...result, keyringPinned: !!keyring, keyringSource: keyring ? api : null };
		},
	},
	{
		name: 'vanity_leading_characters',
		title: 'The exact Base58 leading-character table',
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
		description:
			'The exact probability that a random Solana address begins with each Base58 symbol, and how far each one is from the naive 1/58 assumption. ' +
			'Use it to pick a cheap prefix: symbols 5 through H are about 3.4x easier than the naive model claims, K through z about 17x harder.',
		inputSchema: {},
		handler() {
			return {
				model: 'base58-exact/v2',
				note: 'Base58 encodes a 256-bit integer, so encoding length varies and the leading character is not uniform. Probabilities sum to 1.',
				characters: Object.entries(LEADING_CHAR_PROBABILITY).map(([character, probability]) => ({
					character,
					probability,
					versusUniform: leadingCharDifficultyRatio(character),
				})),
			};
		},
	},
];

/**
 * @param {any} args
 * @returns {{ prefix: string, suffix: string, ignoreCase: boolean }}
 */
function readPattern(args) {
	const prefix = String(args?.prefix ?? '').trim();
	const suffix = String(args?.suffix ?? '').trim();
	if (!prefix && !suffix) throw new Error('give a prefix, a suffix, or both');
	for (const [label, value] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix, suffix, ignoreCase: !!args?.ignoreCase };
}

/**
 * Build a fully registered server without connecting a transport, so tests can
 * drive it in-process.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'solana-vanity', title: 'Solana Vanity', version: PKG.version },
		{
			capabilities: { tools: {} },
			instructions:
				'Solana vanity address tooling. vanity_quote and vanity_leading_characters price a pattern using an exact Base58 ' +
				'difficulty model (the leading character spans a 58x range, which 58^n models get wrong). vanity_appraise scores an ' +
				'address that already exists. vanity_grind produces a real keypair locally across every core. vanity_split_key_grind ' +
				'delegates a hard pattern to a remote grinder that mathematically cannot derive the resulting key. ' +
				'vanity_verify_certificate checks a signed proof-of-grind document. No API key and no payment are needed for any of them.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{ title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
				} catch (err) {
					return {
						content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}
	return server;
}

/** Tool definitions, exported so tests and docs stay in sync with the server. */
export { TOOLS };

async function main() {
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[solana-vanity@${PKG.version}] MCP server on stdio with ${TOOLS.length} tools`);
}

// Connect stdio only when this file is the process entry point, so importing it
// from a test or from the CLI does not hijack the parent's stdio.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
} else if (process.env.SOLANA_VANITY_MCP_STDIO === '1') {
	await main();
}
