#!/usr/bin/env node
/**
 * solana-vanity CLI.
 *
 *   solana-vanity grind --prefix AGNT --suffix pump [--out wallet.json]
 *   solana-vanity delegate --prefix AGNT [--api https://…]
 *   solana-vanity quote --prefix AGNT [--rate 120000]
 *   solana-vanity appraise <address> [--suffix-len 4]
 *   solana-vanity verify <certificate.json> [--api https://…]
 *   solana-vanity serve [--port 8787]
 *   solana-vanity mcp
 *
 * Everything except `delegate` and `verify --api` works with no network at all.
 */

import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import process from 'node:process';

import bs58 from 'bs58';

import { grindVanityPool } from '../src/grinder-pool.js';
import { grindVanityMnemonic, MAX_MNEMONIC_PATTERN_LENGTH, expectedMnemonicAttempts } from '../src/mnemonic-grinder.js';
import { expectedAttempts, formatTimeEstimate, validatePattern } from '../src/validation.js';
import { computeRarity, appraiseAddress } from '../src/rarity.js';
import { verifyProofOfGrind } from '../src/proof-of-grind.js';
import {
	generateRequesterShare, combineScalars, verifySplitKeyClaim, expandedSecretKey,
} from '../src/split-key.js';

const DEFAULT_API = process.env.SOLANA_VANITY_API || 'https://solana-vanity.dev';

const argv = process.argv.slice(2);
const command = argv[0];
const flags = parseFlags(argv.slice(1));

/** ANSI colours, disabled when the output is piped or NO_COLOR is set. */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
	dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
	gold: (s) => (tty ? `\x1b[38;5;221m${s}\x1b[0m` : s),
	green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
	red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

try {
	await main();
} catch (err) {
	console.error(c.red(`error: ${err.message}`));
	process.exitCode = 1;
}

async function main() {
	switch (command) {
		case 'grind': return cmdGrind();
		case 'delegate': return cmdDelegate();
		case 'quote': return cmdQuote();
		case 'appraise': return cmdAppraise();
		case 'verify': return cmdVerify();
		case 'serve': return cmdServe();
		case 'mcp': return cmdMcp();
		case 'help': case '--help': case '-h': case undefined: return usage();
		case 'version': case '--version': case '-v': {
			const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
			console.log(pkg.version);
			return;
		}
		default:
			usage();
			throw new Error(`unknown command "${command}"`);
	}
}

function usage() {
	console.log(`${c.gold('solana-vanity')} ${c.dim('- grind, price and verify Solana vanity addresses')}

${c.bold('Commands')}
  grind      Grind a keypair locally across every core. The key never leaves this machine.
  delegate   Split-key grind through a remote API. The remote side cannot derive your key.
  quote      Exact difficulty, rarity and ETA for a pattern.
  appraise   Score an address that already exists.
  verify     Verify a proof-of-grind certificate.
  serve      Run the HTTP API and, if built, the site.
  mcp        Run the Model Context Protocol server on stdio.

${c.bold('grind')}
  --prefix <chars>     Base58 characters the address must start with
  --suffix <chars>     Base58 characters the address must end with
  --ignore-case        Match letters in any case (much faster)
  --cores <n>          Workers to use (default: every core, ${availableParallelism()} here)
  --mnemonic           Grind a BIP-39 seed phrase instead of a raw keypair
  --words <n>          Seed phrase length: 12, 15, 18, 21 or 24 (default 12)
  --out <file>         Write the Solana CLI keypair JSON here instead of stdout
  --json               Machine-readable output

${c.bold('Examples')}
  solana-vanity grind --prefix AGNT --out wallet.json
  solana-vanity quote --prefix AGNT --rate 120000
  solana-vanity delegate --prefix AGNT --api http://localhost:8787
  solana-vanity appraise 5CyxU... --suffix-len 4
`);
}

// ── grind ────────────────────────────────────────────────────────────────────
async function cmdGrind() {
	if (flags.mnemonic) return cmdGrindMnemonic();
	const { prefix, suffix, ignoreCase } = readPattern();
	const cores = flags.cores ? Number(flags.cores) : availableParallelism();
	const expected = expectedAttempts(prefix, suffix, ignoreCase);
	const rarity = computeRarity({ prefix, suffix, ignoreCase });

	if (!flags.json) {
		console.log(`${c.gold('✦')} grinding ${c.bold(describe(prefix, suffix))} ${c.dim(`(${rarity.tierLabel})`)}`);
		console.log(c.dim(`  ${Math.round(expected).toLocaleString('en-US')} expected attempts across ${cores} cores`));
	}

	const result = await grindVanityPool({
		prefix,
		suffix,
		ignoreCase,
		workers: cores,
		onProgress: flags.json ? undefined : ({ attempts, rate }) => {
			const eta = formatTimeEstimate(Math.max(0, expected - attempts), rate || 1);
			process.stderr.write(`\r  ${attempts.toLocaleString('en-US')} tried · ${Math.round(rate).toLocaleString('en-US')}/s · eta ${eta}   `);
		},
	});

	if (!flags.json) process.stderr.write('\r' + ' '.repeat(72) + '\r');

	if (flags.out) writeFileSync(flags.out, JSON.stringify(Array.from(result.secretKey)));

	if (flags.json) {
		console.log(JSON.stringify({
			address: result.publicKey,
			secretKey: Array.from(result.secretKey),
			secretKeyBase58: bs58.encode(result.secretKey),
			attempts: result.attempts,
			durationMs: result.durationMs,
			workers: result.workers,
			rarity,
		}, null, 2));
		return;
	}

	console.log(`${c.green('✓')} ${c.bold(result.publicKey)}`);
	console.log(c.dim(`  ${result.attempts.toLocaleString('en-US')} attempts in ${(result.durationMs / 1000).toFixed(1)}s across ${result.workers} cores`));
	console.log(c.dim(`  ${rarity.tierLabel} · rarity score ${rarity.rarityScore}`));
	if (flags.out) {
		console.log(`${c.gold('→')} keypair written to ${flags.out} ${c.dim('(Solana CLI format)')}`);
	} else {
		console.log('');
		console.log(c.dim('  secret key (Base58, treat like cash):'));
		console.log(`  ${bs58.encode(result.secretKey)}`);
		console.log('');
		console.log(c.dim('  Pass --out wallet.json to write the Solana CLI keypair file instead.'));
	}
}

/**
 * Grind a BIP-39 seed phrase whose first derived account matches the pattern.
 *
 * This is what most people actually want from a vanity wallet: a phrase they can
 * type into Phantom or Solflare, not a raw key file. It is also two orders of
 * magnitude slower than keypair grinding, because every candidate costs a full
 * PBKDF2-HMAC-SHA512 seed derivation (2048 iterations) plus SLIP-10, so the
 * practical pattern length is short and the CLI says so rather than hanging.
 */
function cmdGrindMnemonic() {
	const { prefix, suffix, ignoreCase } = readPattern();
	if (prefix.length + suffix.length > MAX_MNEMONIC_PATTERN_LENGTH) {
		throw new Error(
			`seed-phrase grinding is limited to ${MAX_MNEMONIC_PATTERN_LENGTH} pattern characters: each candidate needs a full ` +
			`PBKDF2 seed derivation, so a longer pattern would take days. Grind a raw keypair instead (drop --mnemonic), ` +
			`or delegate it with \`solana-vanity delegate\`.`,
		);
	}
	const words = Number(flags.words || 12);
	const strengthByWords = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 };
	const strength = strengthByWords[words];
	if (!strength) throw new Error('--words must be 12, 15, 18, 21 or 24');

	const expected = expectedMnemonicAttempts(prefix, suffix, ignoreCase);
	if (!flags.json) {
		console.log(`${c.gold('✦')} grinding a ${words}-word seed phrase for ${c.bold(describe(prefix, suffix))}`);
		console.log(c.dim(`  ${Math.round(expected).toLocaleString('en-US')} expected attempts, single-threaded PBKDF2`));
	}

	const result = grindVanityMnemonic({ prefix, suffix, ignoreCase, strength, timeBudgetMs: Number(flags['time-budget-ms'] || 120_000) });

	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`${c.green('✓')} ${c.bold(result.publicKey)}`);
	console.log(c.dim(`  ${result.attempts.toLocaleString('en-US')} attempts in ${(result.durationMs / 1000).toFixed(1)}s`));
	console.log(c.dim(`  derivation path ${result.derivationPath}`));
	console.log('');
	console.log(c.dim('  seed phrase (write it down, it is the whole wallet):'));
	console.log(`  ${c.bold(result.mnemonic)}`);
	if (flags.out) {
		writeFileSync(flags.out, JSON.stringify(Array.from(result.secretKey)));
		console.log('');
		console.log(`${c.gold('→')} keypair also written to ${flags.out} ${c.dim('(Solana CLI format)')}`);
	}
}

// ── delegate ─────────────────────────────────────────────────────────────────
async function cmdDelegate() {
	const { prefix, suffix, ignoreCase } = readPattern();
	const api = (flags.api || DEFAULT_API).replace(/\/$/, '');
	const share = generateRequesterShare();

	if (!flags.json) {
		console.log(`${c.gold('✦')} delegating ${c.bold(describe(prefix, suffix))} to ${api}`);
		console.log(c.dim(`  P1 ${share.p1}`));
		console.log(c.dim('  a1 stays on this machine and is never transmitted'));
	}

	let attempts = 0;
	let rounds = 0;
	for (;;) {
		rounds++;
		const r = await fetch(`${api}/api/splitkey/grind`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ p1: share.p1, prefix, suffix, ignoreCase, timeBudgetMs: 15000 }),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		attempts += data.attempts || 0;
		if (!flags.json) process.stderr.write(`\r  ${attempts.toLocaleString('en-US')} offsets over ${rounds} request${rounds === 1 ? '' : 's'}   `);
		if (!data.found) continue;

		if (!flags.json) process.stderr.write('\r' + ' '.repeat(72) + '\r');

		// Never trust the response: re-derive the address, then combine locally.
		const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern: { prefix, suffix, ignoreCase } });
		if (!claim.ok) throw new Error(`remote returned an invalid offset: ${claim.reason}`);
		const combined = combineScalars(share.a1, data.offset);
		if (combined.address !== data.address) throw new Error('local combination disagreed with the delegated address');

		const expanded = Buffer.from(expandedSecretKey(combined.scalar)).toString('hex');
		if (flags.json) {
			console.log(JSON.stringify({ address: combined.address, expandedSecretKeyHex: expanded, attempts, rounds, certificate: data.certificate }, null, 2));
			return;
		}
		console.log(`${c.green('✓')} ${c.bold(combined.address)}`);
		console.log(c.dim(`  ${attempts.toLocaleString('en-US')} offsets over ${rounds} request${rounds === 1 ? '' : 's'}, verified locally`));
		console.log('');
		console.log(c.dim('  expanded secret key (hex), which an SDK signer takes directly:'));
		console.log(`  ${expanded}`);
		console.log('');
		console.log(c.dim('  This is a raw Ed25519 scalar, not a seed: seed-only wallet imports will reject it.'));
		if (flags.out) {
			writeFileSync(flags.out, JSON.stringify({ scheme: 'ed25519-split-key/v1', address: combined.address, expandedSecretKeyHex: expanded }, null, 2));
			console.log(`${c.gold('→')} written to ${flags.out}`);
		}
		return;
	}
}

// ── quote ────────────────────────────────────────────────────────────────────
function cmdQuote() {
	const { prefix, suffix, ignoreCase } = readPattern();
	const rate = Number(flags.rate || 0);
	const expected = expectedAttempts(prefix, suffix, ignoreCase);
	const rarity = computeRarity({ prefix, suffix, ignoreCase });

	if (flags.json) {
		console.log(JSON.stringify({ pattern: { prefix, suffix, ignoreCase }, expectedAttempts: expected, rarity, eta: rate > 0 ? formatTimeEstimate(expected, rate) : null }, null, 2));
		return;
	}
	console.log(`${c.gold('✦')} ${c.bold(describe(prefix, suffix))}`);
	console.log(`  expected attempts  ${Math.round(expected).toLocaleString('en-US')}`);
	console.log(`  rarity             ${rarity.tierLabel} · score ${rarity.rarityScore}`);
	console.log(`  effective length   ${rarity.effectiveLength} characters`);
	console.log(`  model              ${rarity.model}`);
	if (rate > 0) console.log(`  eta at ${Number(rate).toLocaleString('en-US')}/s   ${formatTimeEstimate(expected, rate)}`);
	if (rarity.bonuses.length) {
		console.log('');
		for (const b of rarity.bonuses) console.log(c.dim(`  + ${b.label}: ${b.detail}`));
	}
}

// ── appraise ─────────────────────────────────────────────────────────────────
function cmdAppraise() {
	const address = argv[1] && !argv[1].startsWith('--') ? argv[1] : flags.address;
	if (!address) throw new Error('usage: solana-vanity appraise <address>');
	const result = appraiseAddress(address, {
		ignoreCase: !!flags['ignore-case'],
		...(flags['prefix-len'] ? { prefixLen: Number(flags['prefix-len']) } : {}),
		...(flags['suffix-len'] ? { suffixLen: Number(flags['suffix-len']) } : {}),
	});
	if (flags.json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`${c.gold('✦')} ${c.bold(result.address)}`);
	console.log(`  read as            ${result.prefix || '(none)'}…${result.suffix || ''}`);
	console.log(`  expected attempts  ${Math.round(result.expectedAttempts).toLocaleString('en-US')}`);
	console.log(`  rarity             ${result.tierLabel} · score ${result.rarityScore}`);
	console.log(`  grind time         ${result.grindHuman} ${c.dim(`at ${result.ratePerSecond.toLocaleString('en-US')}/s`)}`);
	for (const b of result.bonuses) console.log(c.dim(`  + ${b.label}: ${b.detail}`));
}

// ── verify ───────────────────────────────────────────────────────────────────
async function cmdVerify() {
	const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : flags.file;
	if (!file) throw new Error('usage: solana-vanity verify <certificate.json>');
	const raw = JSON.parse(await readFile(file, 'utf8'));
	const cert = raw.certificate ?? raw;

	// Pin against the issuer's published key ring when we can reach it. Without a
	// pin, a self-signed forgery passes the signature check, so say which mode ran.
	let keyring = null;
	const api = (flags.api || DEFAULT_API).replace(/\/$/, '');
	try {
		const r = await fetch(`${api}/.well-known/solana-vanity.json`);
		if (r.ok) keyring = (await r.json()).attestationKeys || null;
	} catch {
		keyring = null;
	}

	const result = verifyProofOfGrind(cert, keyring ? { keyring } : {});
	if (flags.json) {
		console.log(JSON.stringify({ ...result, keyringPinned: !!keyring, keyringSource: keyring ? api : null }, null, 2));
		process.exitCode = result.valid ? 0 : 1;
		return;
	}
	console.log(result.valid ? c.green('✓ certificate is valid') : c.red('✗ certificate is NOT valid'));
	console.log(c.dim(`  address ${result.address}`));
	console.log(c.dim(`  key ring ${keyring ? `pinned from ${api}` : "unavailable, checked against the certificate's own key"}`));
	console.log('');
	for (const check of result.checks) {
		console.log(`  ${check.pass ? c.green('✓') : c.red('✗')} ${check.label}`);
		console.log(c.dim(`     ${check.detail}`));
	}
	process.exitCode = result.valid ? 0 : 1;
}

// ── serve / mcp ──────────────────────────────────────────────────────────────
async function cmdServe() {
	if (flags.port) process.env.PORT = String(flags.port);
	await import('../server/index.mjs');
}

async function cmdMcp() {
	// Connect the transport here rather than letting the module self-start: it
	// only auto-connects when it is the process entry point, which it is not when
	// the CLI dispatches to it.
	const [{ buildServer, TOOLS }, { StdioServerTransport }] = await Promise.all([
		import('../mcp/index.js'),
		import('@modelcontextprotocol/sdk/server/stdio.js'),
	]);
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	console.error(`[solana-vanity] MCP server on stdio with ${TOOLS.length} tools`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** @returns {{ prefix: string, suffix: string, ignoreCase: boolean }} */
function readPattern() {
	const prefix = String(flags.prefix || '');
	const suffix = String(flags.suffix || '');
	const ignoreCase = !!flags['ignore-case'];
	if (!prefix && !suffix) throw new Error('give --prefix, --suffix, or both');
	for (const [label, value] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) throw new Error(`invalid ${label}: ${v.errors.join('; ')}`);
	}
	return { prefix, suffix, ignoreCase };
}

/** @param {string} prefix @param {string} suffix @returns {string} */
function describe(prefix, suffix) {
	return `${prefix || ''}…${suffix || ''}`;
}

/**
 * `--key value` and `--flag` into an object. A value that looks like the next
 * flag is treated as a boolean, so `--json --prefix A` parses correctly.
 * @param {string[]} args
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(args) {
	/** @type {Record<string, string|boolean>} */
	const out = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next === undefined || next.startsWith('--')) out[key] = true;
		else { out[key] = next; i++; }
	}
	return out;
}
