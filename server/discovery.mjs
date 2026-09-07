/**
 * Discovery documents: how this service is found by crawlers, AI assistants,
 * agent runtimes and package/registry aggregators.
 *
 * Five audiences, five formats, all generated from one place so they cannot
 * drift apart:
 *
 *   robots.txt + sitemap.xml   search crawlers
 *   llms.txt                   AI assistants reading the site directly
 *                              (llmstxt.org convention)
 *   openapi.json               OpenAPI 3.1, for API catalogues, codegen and any
 *                              agent that can consume a tool schema
 *   /.well-known/agents.json   an agent card: what this service does, which
 *                              skills it exposes, and where to call them
 *   /.well-known/mcp.json      the Model Context Protocol server descriptor, so
 *                              an MCP host can install the tools without a
 *                              hand-written config
 *
 * Every URL is derived from the request origin, so a fork deployed anywhere
 * publishes correct documents with no configuration.
 */

const SUMMARY = 'Grind Solana vanity addresses with an exact Base58 difficulty model, verify signed proof-of-grind certificates, and delegate hard patterns through trustless split-key grinding that never exposes a private key.';

/** @param {string} origin */
export function agentCard(origin) {
	return {
		name: 'solana-vanity',
		description: SUMMARY,
		url: origin,
		provider: { organization: 'solana-vanity', url: 'https://github.com/nirholas/solana-vanity' },
		version: '1.0.0',
		documentationUrl: `${origin}/docs.html`,
		capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
		defaultInputModes: ['application/json'],
		defaultOutputModes: ['application/json'],
		skills: [
			{
				id: 'quote-vanity-difficulty',
				name: 'Quote a vanity pattern',
				description: 'Given a Base58 prefix and/or suffix, return the exact probability, expected attempts, rarity tier and an ETA at a given hash rate.',
				tags: ['solana', 'vanity', 'difficulty', 'pricing'],
				examples: ['How hard is a Solana address starting with AGNT?', 'What does a ...pump suffix cost to grind?'],
				endpoint: { method: 'POST', url: `${origin}/api/quote` },
			},
			{
				id: 'appraise-address',
				name: 'Appraise an address',
				description: 'Score an existing Solana address: which leading and trailing characters look deliberate, how much work they represent, and what tier that lands in.',
				tags: ['solana', 'rarity', 'appraisal'],
				examples: ['How rare is this Solana address?'],
				endpoint: { method: 'POST', url: `${origin}/api/appraise` },
			},
			{
				id: 'split-key-grind',
				name: 'Delegate a grind without giving up the key',
				description: 'Submit a public point P1 = a1·B and a pattern. The service searches offsets a2 so that P1 + a2·B matches, and returns a2. Only the caller, who holds a1, can compute the final secret.',
				tags: ['solana', 'vanity', 'split-key', 'non-custodial'],
				examples: ['Grind me a wallet starting with SOL without seeing my key'],
				endpoint: { method: 'POST', url: `${origin}/api/splitkey/grind` },
			},
			{
				id: 'verify-certificate',
				name: 'Verify a proof-of-grind certificate',
				description: 'Check a signed certificate end to end: signature, key ring membership, difficulty claim, rarity claim and, for split-key grinds, the non-custody equation P1 + a2·B == address.',
				tags: ['verification', 'provenance', 'ed25519'],
				examples: ['Is this vanity wallet certificate genuine?'],
				endpoint: { method: 'POST', url: `${origin}/api/verify` },
			},
		],
	};
}

/** @param {string} origin */
export function mcpDescriptor(origin) {
	return {
		name: 'solana-vanity',
		description: SUMMARY,
		version: '1.0.0',
		homepage: 'https://github.com/nirholas/solana-vanity',
		license: 'Apache-2.0',
		transport: { stdio: { command: 'npx', args: ['-y', 'solana-vanity', 'mcp'] } },
		remote: { httpApi: `${origin}/openapi.json` },
		tools: [
			{ name: 'vanity_quote', description: 'Exact difficulty, rarity and ETA for a Solana vanity pattern.' },
			{ name: 'vanity_appraise', description: 'Rarity appraisal of an existing Solana address.' },
			{ name: 'vanity_grind', description: 'Grind a Solana vanity keypair locally on the machine running the MCP server.' },
			{ name: 'vanity_split_key_grind', description: 'Delegate a grind to the hosted service without exposing a private key.' },
			{ name: 'vanity_verify_certificate', description: 'Verify a proof-of-grind certificate offline.' },
			{ name: 'vanity_leading_characters', description: 'The exact Base58 leading-character probability table.' },
		],
	};
}

/** @param {string} origin */
export function llmsTxt(origin) {
	return `# solana-vanity

> ${SUMMARY}

Open source (Apache-2.0), runs entirely client-side in the browser, and every
number it reports is reproducible from the source in this repository.

## What makes the numbers different

Base58 encodes a 256-bit integer, so the *leading* character of a Solana address
is not uniformly distributed. The 40 symbols from 'K' to 'z' are 17.2x harder to
lead with than '5' to 'H'. Tools that model a vanity pattern as 58^n are wrong by
up to 58x on the first character. This project counts the matching key space
exactly, with BigInt interval arithmetic over all 2^256 keys.

## Pages

- [Grinder](${origin}/): browser grinder, WebAssembly Ed25519, one worker per core.
- [Rarity](${origin}/rarity.html): appraise any Solana address.
- [Delegate](${origin}/delegate.html): trustless split-key grinding for hard patterns.
- [Verify](${origin}/verify.html): check a proof-of-grind certificate offline.
- [Docs](${origin}/docs.html): protocol, maths, API and self-hosting.

## API

- POST ${origin}/api/quote: difficulty, rarity and ETA for a pattern.
- POST ${origin}/api/appraise: rarity of an existing address.
- POST ${origin}/api/splitkey/grind: delegated grinding, non-custodial.
- POST ${origin}/api/splitkey/verify: check a split-key claim.
- POST ${origin}/api/certify: sign a proof-of-grind certificate.
- POST ${origin}/api/verify: verify a certificate.
- GET  ${origin}/api/difficulty/leading-characters: the exact Base58 table.
- GET  ${origin}/openapi.json: machine-readable schema for all of the above.

## For agents

Agent card: ${origin}/.well-known/agents.json
MCP server: ${origin}/.well-known/mcp.json  (npx -y solana-vanity mcp)
Attestation keys: ${origin}/.well-known/solana-vanity.json

## Safety

No endpoint on this service needs, wants, or accepts a private key. The browser
grinder never transmits one. Delegated grinding is split-key: the service
searches offsets against a public point and cannot reconstruct the final secret.
Server-side custodial grinding exists in the codebase but is disabled unless an
operator sets ALLOW_SERVER_GRIND=1 on their own deployment.
`;
}

/** @param {string} origin */
export function robotsTxt(origin) {
	return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

/** @param {string} origin */
export function sitemapXml(origin) {
	const pages = ['/', '/rarity.html', '/delegate.html', '/verify.html', '/docs.html'];
	const urls = pages.map((p) => `\t<url><loc>${origin}${p}</loc><changefreq>weekly</changefreq></url>`).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const PATTERN_PROPS = {
	prefix: { type: 'string', description: 'Base58 characters the address must start with.', example: 'AGNT' },
	suffix: { type: 'string', description: 'Base58 characters the address must end with.', example: 'pump' },
	ignoreCase: { type: 'boolean', default: false, description: 'Match letters in any case. Much cheaper, but the resulting casing is not chosen.' },
};

/** @param {string} origin */
export function openApi(origin) {
	return {
		openapi: '3.1.0',
		info: {
			title: 'solana-vanity',
			version: '1.0.0',
			summary: 'Solana vanity address difficulty, rarity, certificates and non-custodial delegated grinding.',
			description: SUMMARY,
			license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
			contact: { url: 'https://github.com/nirholas/solana-vanity' },
		},
		servers: [{ url: origin }],
		paths: {
			'/api/health': {
				get: {
					summary: 'Service health and attestation key identity',
					operationId: 'health',
					responses: { 200: { description: 'Service status', content: { 'application/json': { schema: { type: 'object' } } } } },
				},
			},
			'/api/quote': {
				post: {
					summary: 'Exact difficulty, rarity and ETA for a vanity pattern',
					operationId: 'quote',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							properties: { ...PATTERN_PROPS, attemptsPerSecond: { type: 'number', description: 'Your measured grind rate; adds a wall-clock ETA.' } },
						} } },
					},
					responses: {
						200: { description: 'Quote', content: { 'application/json': { schema: { type: 'object' } } } },
						400: { description: 'Invalid pattern' },
					},
				},
			},
			'/api/appraise': {
				post: {
					summary: 'Rarity appraisal of an existing Solana address',
					operationId: 'appraise',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['address'],
							properties: {
								address: { type: 'string', description: 'Base58 Solana address (32 bytes).' },
								prefixLen: { type: 'integer', description: 'Leading characters to treat as intentional. Auto-detected when omitted.' },
								suffixLen: { type: 'integer', description: 'Trailing characters to treat as intentional.' },
								ignoreCase: { type: 'boolean' },
							},
						} } },
					},
					responses: { 200: { description: 'Appraisal' }, 400: { description: 'Invalid address' } },
				},
			},
			'/api/difficulty/leading-characters': {
				get: {
					summary: 'Exact probability of each Base58 leading character',
					operationId: 'leadingCharacters',
					responses: { 200: { description: 'Probability table' } },
				},
			},
			'/api/certify': {
				post: {
					summary: 'Issue a signed proof-of-grind certificate',
					operationId: 'certify',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['address'],
							properties: {
								address: { type: 'string' },
								...PATTERN_PROPS,
								attempts: { type: 'integer', description: 'Attempts the grinder actually made.' },
								format: { type: 'string', enum: ['keypair', 'mnemonic', 'split-key'] },
							},
						} } },
					},
					responses: { 200: { description: 'Signed certificate' }, 400: { description: 'Address does not match the claimed pattern' } },
				},
			},
			'/api/verify': {
				post: {
					summary: 'Verify a proof-of-grind certificate',
					operationId: 'verifyCertificate',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { certificate: { type: 'object' } } } } } },
					responses: { 200: { description: 'Per-check verification audit' } },
				},
			},
			'/api/splitkey/grind': {
				post: {
					summary: 'Delegated grinding that cannot expose your key',
					description: 'Send P1 = a1·B. The service searches offsets a2 until P1 + a2·B matches the pattern, then returns a2. Compute aFinal = (a1 + a2) mod L locally; the service never sees a1 and cannot derive the secret.',
					operationId: 'splitKeyGrind',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['p1'],
							properties: {
								p1: { type: 'string', description: 'Your public point a1·B, Base58 or hex.' },
								...PATTERN_PROPS,
								timeBudgetMs: { type: 'integer', description: 'How long to search in this request. Capped server-side.' },
							},
						} } },
					},
					responses: { 200: { description: 'Offset scalar and matching address, or found:false when the budget ran out' } },
				},
			},
			'/api/splitkey/verify': {
				post: {
					summary: 'Check that an offset really produces the claimed address',
					operationId: 'splitKeyVerify',
					requestBody: {
						required: true,
						content: { 'application/json': { schema: {
							type: 'object',
							required: ['p1', 'offset', 'address'],
							properties: { p1: { type: 'string' }, offset: { type: 'string' }, address: { type: 'string' }, pattern: { type: 'object' } },
						} } },
					},
					responses: { 200: { description: 'Verification result' } },
				},
			},
			'/api/grind': {
				post: {
					summary: 'Custodial server-side grind (disabled by default)',
					description: 'Returns a secret key over the network. Disabled unless the operator sets ALLOW_SERVER_GRIND=1. Prefer the browser grinder, the CLI, or /api/splitkey/grind.',
					operationId: 'serverGrind',
					requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: PATTERN_PROPS } } } },
					responses: { 200: { description: 'Keypair' }, 403: { description: 'Disabled on this deployment' } },
				},
			},
		},
	};
}
