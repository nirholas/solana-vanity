/**
 * Cloudflare Worker host.
 *
 * The same Fetch handler as the Node server, with static assets served by the
 * Workers Assets binding instead of the filesystem.
 *
 * One endpoint behaves differently here, on purpose: `/api/grind` needs the
 * WebAssembly grinder loaded from disk and is therefore unavailable on the edge.
 * It answers 501 with a pointer to `/api/splitkey/grind`, which is pure
 * arithmetic and runs anywhere. Nothing is silently degraded.
 *
 * Deploy: npm run build && npx wrangler deploy
 */

import { handle } from '../server/app.mjs';

export default {
	/**
	 * @param {Request} request
	 * @param {{ ASSETS?: { fetch: (req: Request) => Promise<Response> } }} env
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env) {
		const response = await handle(request, env);
		if (response) return response;
		if (env.ASSETS) return env.ASSETS.fetch(request);
		return new Response('not found', { status: 404 });
	},
};
