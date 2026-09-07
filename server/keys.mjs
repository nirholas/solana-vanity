/**
 * The attestation key.
 *
 * Certificates issued by this service are signed with a long-lived Ed25519 key.
 * Verification is offline and rotation-aware: the public half is published at
 * `/.well-known/solana-vanity.json`, and a verifier pins against that keyring
 * rather than trusting whatever public key a pasted certificate carries.
 *
 * Operators supply the secret half in `ATTESTATION_SEED` (32 bytes, hex or
 * Base58). If none is set the service mints an ephemeral key for the process
 * and says so, in the key id (`ephemeral-…`), in the well-known document and in
 * every certificate response. That keeps a fresh clone working end to end
 * without ever pretending an ephemeral key is a durable identity: restart the
 * process and yesterday's certificates no longer verify against the live
 * keyring, which is exactly the truth.
 *
 * Generate a durable one with `npm run keygen`.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

/** @type {{ seed: Uint8Array, publicKey: Uint8Array, publicKeyBase58: string, keyId: string, ephemeral: boolean } | null} */
let cached = null;

/**
 * @param {string} raw hex (with or without 0x) or Base58
 * @returns {Uint8Array}
 */
function decodeSeed(raw) {
	const s = raw.trim();
	const hex = s.startsWith('0x') ? s.slice(2) : s;
	if (/^[0-9a-fA-F]{64}$/.test(hex)) {
		const out = new Uint8Array(32);
		for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		return out;
	}
	const bytes = bs58.decode(s);
	if (bytes.length === 32) return bytes;
	// A 64-byte Solana secret key is `[seed][pubkey]`; accept it and take the seed.
	if (bytes.length === 64) return bytes.slice(0, 32);
	throw new Error(`ATTESTATION_SEED must be 32 bytes (got ${bytes.length})`);
}

/**
 * Load (once) the attestation key for this process.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ seed: Uint8Array, publicKey: Uint8Array, publicKeyBase58: string, keyId: string, ephemeral: boolean }}
 */
export function attestationKey(env = {}) {
	if (cached) return cached;
	const raw = env.ATTESTATION_SEED || (typeof process !== 'undefined' ? process.env?.ATTESTATION_SEED : undefined);
	let seed;
	let ephemeral = false;
	if (raw) {
		seed = decodeSeed(raw);
	} else {
		seed = ed25519.utils.randomSecretKey();
		ephemeral = true;
		console.warn(
			'[attestation] ATTESTATION_SEED is not set. Minting an ephemeral key for this process.\n' +
			'              Certificates will stop verifying when the process restarts.\n' +
			'              Run `npm run keygen` and set ATTESTATION_SEED for a durable identity.',
		);
	}
	const publicKey = ed25519.getPublicKey(seed);
	const publicKeyBase58 = bs58.encode(publicKey);
	cached = {
		seed,
		publicKey,
		publicKeyBase58,
		keyId: `${ephemeral ? 'ephemeral' : 'sv'}-${bytesToHex(publicKey).slice(0, 16)}`,
		ephemeral,
	};
	return cached;
}

/**
 * The public keyring served at `/.well-known/solana-vanity.json` and consumed by
 * the verifier. An array, because rotation means more than one key can be valid
 * at a time: publish the new key alongside the old one until every certificate
 * signed by the old one has aged out.
 * @param {Record<string, string|undefined>} [env]
 */
export function publicKeyring(env = {}) {
	const key = attestationKey(env);
	return [{
		keyId: key.keyId,
		publicKeyBase58: key.publicKeyBase58,
		ephemeral: key.ephemeral,
		algorithm: 'ed25519',
	}];
}
