#!/usr/bin/env node
/**
 * Mint a durable attestation key.
 *
 * Prints the secret seed once, on stdout, and never writes it anywhere: put it
 * in your secret manager (or `.env`) as ATTESTATION_SEED and keep it out of the
 * repository. The public half is what you publish.
 *
 *   node server/keygen.mjs
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils';
import bs58 from 'bs58';

const seed = ed25519.utils.randomSecretKey();
const publicKey = ed25519.getPublicKey(seed);

console.log('ATTESTATION_SEED=%s', bytesToHex(seed));
console.log('');
console.log('public key (Base58): %s', bs58.encode(publicKey));
console.log('key id:              sv-%s', bytesToHex(publicKey).slice(0, 16));
console.log('');
console.log('Store the seed in a secret manager. Anyone holding it can sign certificates');
console.log('as this service; nobody holding it can touch a ground wallet, because the');
console.log('service never sees one.');
