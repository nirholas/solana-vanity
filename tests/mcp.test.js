/**
 * The MCP server is how an assistant reaches this project, so its tool list and
 * shapes are a public contract. These tests drive it over a real stdio
 * transport, the same way a host would.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = fileURLToPath(new URL('../mcp/index.js', import.meta.url));

/**
 * @template T
 * @param {(client: Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withClient(fn) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
	const client = new Client({ name: 'solana-vanity-tests', version: '1.0.0' });
	await client.connect(transport);
	try {
		return await fn(client);
	} finally {
		await client.close();
	}
}

/** @param {any} result @returns {any} */
function payload(result) {
	return JSON.parse(result.content[0].text);
}

test('the server exposes exactly the documented tools', async () => {
	const names = await withClient(async (client) => (await client.listTools()).tools.map((t) => t.name).sort());
	assert.deepEqual(names, [
		'vanity_appraise',
		'vanity_grind',
		'vanity_leading_characters',
		'vanity_quote',
		'vanity_split_key_grind',
		'vanity_verify_certificate',
	]);
});

test('vanity_quote prices a pattern and names the naive alternative', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_quote', arguments: { prefix: 'AGNT', attemptsPerSecond: 100000 } }),
	));
	assert.ok(data.expectedAttempts > 0);
	assert.ok(data.naiveModel.expectedAttempts > 0);
	assert.ok(data.rarity.tierLabel);
	assert.ok(typeof data.eta === 'string');
});

test('vanity_grind returns a usable keypair', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_grind', arguments: { prefix: 'a', ignoreCase: true } }),
	));
	assert.equal(data.secretKey.length, 64);
	assert.ok(data.address.toLowerCase().startsWith('a'));
});

test('a bad pattern comes back as a tool error, not a crash', async () => {
	const result = await withClient(async (client) => client.callTool({ name: 'vanity_quote', arguments: { prefix: 'A0B' } }));
	assert.equal(result.isError, true);
	assert.match(payload(result).error, /invalid prefix/);
});

test('vanity_leading_characters returns all 58 symbols', async () => {
	const data = await withClient(async (client) => payload(
		await client.callTool({ name: 'vanity_leading_characters', arguments: {} }),
	));
	assert.equal(data.characters.length, 58);
	const total = data.characters.reduce((sum, ch) => sum + ch.probability, 0);
	assert.ok(Math.abs(total - 1) < 1e-12);
});
