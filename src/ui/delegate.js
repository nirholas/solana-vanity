/**
 * Split-key delegation page.
 *
 * The whole protocol, driven from the browser:
 *
 *   1. generate a1 (secret, stays in this closure) and P1 = a1·B (public);
 *   2. POST P1 + the pattern to /api/splitkey/grind, repeatedly, until the
 *      remote grinder reports a hit. Each request is time-boxed server-side, so
 *      a long search is many short requests rather than one held connection;
 *   3. combine aFinal = (a1 + a2) mod L here;
 *   4. verify the result locally before showing it, because a server that
 *      returns a wrong offset must fail visibly rather than silently.
 *
 * a1 is never written to storage, never sent, and dies with the tab.
 */

import { bytesToHex } from '@noble/hashes/utils';
import {
	generateRequesterShare, combineScalars, verifySplitKeyClaim,
	expandedSecretKey, offsetPoint,
} from '../split-key.js';
import { validatePattern, expectedAttempts, MAX_PATTERN_LENGTH, formatTimeEstimate } from '../validation.js';
import { computeRarity } from '../rarity.js';
import { setGrindActivity } from './activity.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The requester's share for this tab. Regenerated on demand, never persisted. */
let share = null;
let running = false;
let stopped = false;

$('gen').addEventListener('click', () => {
	share = generateRequesterShare();
	$('p1').textContent = share.p1;
	$('a1').textContent = 'held in memory only, never sent, never stored';
	$('share').hidden = false;
	$('gen').textContent = 'Generate a new share';
	update();
});

['prefix', 'suffix'].forEach((id) => $(id).addEventListener('input', update));
$('ci').addEventListener('change', update);
update();

function readPattern() {
	return {
		prefix: $('prefix').value.trim(),
		suffix: $('suffix').value.trim(),
		ignoreCase: $('ci').checked,
	};
}

function update() {
	const { prefix, suffix, ignoreCase } = readPattern();
	const errors = [];
	for (const [side, value] of [['prefix', prefix], ['suffix', suffix]]) {
		if (!value) continue;
		const v = validatePattern(value);
		if (!v.valid) errors.push(`${side}: ${v.errors.join('; ')}`);
	}
	if (prefix.length + suffix.length > MAX_PATTERN_LENGTH) {
		errors.push(`prefix + suffix exceed ${MAX_PATTERN_LENGTH} characters combined`);
	}

	$('prefix').classList.toggle('invalid', !!errors.find((e) => e.startsWith('prefix')));
	$('suffix').classList.toggle('invalid', !!errors.find((e) => e.startsWith('suffix')));

	if (!prefix && !suffix) {
		$('est').textContent = 'type a pattern to see what it costs';
		$('tier').innerHTML = '';
		$('run').disabled = true;
		return;
	}
	if (errors.length) {
		$('est').textContent = errors.join('; ');
		$('tier').innerHTML = '';
		$('run').disabled = true;
		return;
	}

	// The remote grinder walks the curve one point addition at a time. That is
	// two orders of magnitude slower than the WASM keypair grinder, and saying so
	// up front is the difference between a useful tool and a hung progress bar.
	const attempts = expectedAttempts(prefix, suffix, ignoreCase);
	const rarity = computeRarity({ prefix, suffix, ignoreCase });
	$('est').textContent = `${Math.round(attempts).toLocaleString()} expected offsets · ${formatTimeEstimate(attempts, 6000)} at a typical delegated rate`;
	$('tier').innerHTML = `<span class="tier-tag ${attempts > 5e6 ? 'tier-paid' : 'tier-free'}">${esc(rarity.tierLabel)}</span>`;
	$('run').disabled = !share || running;
	if (!share) $('est').textContent = 'generate your secret share first';
}

$('cancel').addEventListener('click', () => { stopped = true; });

$('run').addEventListener('click', async () => {
	if (!share || running) return;
	const pattern = readPattern();
	running = true;
	stopped = false;
	$('run').disabled = true;
	$('cancel').hidden = false;
	$('progress').hidden = false;
	$('out').hidden = true;
	$('err').hidden = true;
	setGrindActivity(1);

	let rounds = 0;
	let attempts = 0;
	try {
		for (;;) {
			if (stopped) throw new Error('stopped');
			rounds++;
			$('rounds').textContent = rounds.toLocaleString();

			const r = await fetch('/api/splitkey/grind', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ p1: share.p1, ...pattern, timeBudgetMs: 8000 }),
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

			attempts += data.attempts || 0;
			$('attempts').textContent = attempts.toLocaleString();

			if (data.found) {
				finish(data, pattern, attempts, rounds);
				return;
			}
		}
	} catch (e) {
		if (e.message !== 'stopped') {
			$('err').textContent = `Delegation failed: ${e.message}`;
			$('err').hidden = false;
		}
	} finally {
		running = false;
		$('cancel').hidden = true;
		$('progress').hidden = true;
		$('run').disabled = false;
		setGrindActivity(0);
		update();
	}
});

/**
 * Combine locally, check the server told the truth, and render the wallet.
 * @param {any} data response from /api/splitkey/grind
 * @param {{prefix:string,suffix:string,ignoreCase:boolean}} pattern
 * @param {number} attempts
 * @param {number} rounds
 */
function finish(data, pattern, attempts, rounds) {
	// Never trust the offset: re-derive the address from P1 and the offset, and
	// confirm it matches both the claim and the requested pattern.
	const claim = verifySplitKeyClaim({ p1: share.p1, offset: data.offset, address: data.address, pattern });
	if (!claim.ok) {
		$('err').textContent = `The grinder returned an offset that does not produce the address it claimed (${claim.reason}). Nothing was accepted.`;
		$('err').hidden = false;
		return;
	}

	const combined = combineScalars(share.a1, data.offset);
	if (combined.address !== data.address) {
		$('err').textContent = 'Local combination disagreed with the delegated address. Nothing was accepted.';
		$('err').hidden = false;
		return;
	}

	const expanded = expandedSecretKey(combined.scalar);
	const expandedHex = bytesToHex(expanded);
	const serverPoint = offsetPoint(data.offset);
	const addr = combined.address;
	// Highlight what the address actually contains, not what was requested: a
	// case-insensitive match returns a different spelling than the one typed.
	const head = addr.slice(0, pattern.prefix.length);
	const tail = pattern.suffix ? addr.slice(addr.length - pattern.suffix.length) : '';
	const mid = addr.slice(pattern.prefix.length, pattern.suffix ? addr.length - pattern.suffix.length : addr.length);

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result">
			<h3>✦ Wallet ready. The grinder never held this key</h3>
			<div class="addr">${head ? `<span class="pfx">${esc(head)}</span>` : ''}${esc(mid)}${tail ? `<span class="sfx">${esc(tail)}</span>` : ''}</div>
			<div class="meta">${attempts.toLocaleString()} offsets over ${rounds} request${rounds === 1 ? '' : 's'} · verified locally before it was shown</div>

			<div class="kv"><span class="k">P1 (yours, public)</span><span class="v mono" style="font-size:.72rem">${esc(share.p1)}</span></div>
			<div class="kv"><span class="k">a2·B (grinder's, public)</span><span class="v mono" style="font-size:.72rem">${esc(serverPoint)}</span></div>
			<div class="kv"><span class="k">P1 + a2·B</span><span class="v" style="color:#4ade80">= the address above ✓</span></div>

			<div class="export-grid">
				<button id="dl-expanded" class="btn primary" type="button">⬇ Expanded secret key (64 bytes)</button>
				<button id="copy-addr" class="btn" type="button">Copy address</button>
				<a class="btn" id="dl-cert" href="#" download="certificate.json">⬇ Certificate</a>
				<a class="btn" href="/verify.html">Verify the certificate →</a>
			</div>

			<div class="secret-box">
				<span class="fl">Expanded secret key (hex), which an SDK signer takes directly</span>
				<code id="expanded-value">${esc(expandedHex)}</code>
			</div>

			<div class="warn">
				<strong>This is an expanded key, not a seed.</strong>
				It signs for the address and is a valid Solana account, but a seed-only wallet import will reject it.
				Save it now: nothing about it exists outside this tab.
			</div>
		</div>`;

	$('dl-expanded').addEventListener('click', () => {
		download(`${addr.slice(0, 8)}-expanded.json`, JSON.stringify({
			scheme: 'ed25519-split-key/v1',
			address: addr,
			expandedSecretKeyHex: expandedHex,
			note: 'Raw Ed25519 scalar plus signing-nonce prefix. Use with an SDK signer; seed-only wallets cannot import it.',
		}, null, 2));
	});

	$('copy-addr').addEventListener('click', async () => {
		try {
			await navigator.clipboard.writeText(addr);
			$('copy-addr').textContent = 'Copied!';
		} catch {
			$('copy-addr').textContent = 'Copy failed, select it above';
		}
		setTimeout(() => { $('copy-addr').textContent = 'Copy address'; }, 2000);
	});

	if (data.certificate) {
		const blob = new Blob([JSON.stringify(data.certificate, null, 2)], { type: 'application/json' });
		$('dl-cert').href = URL.createObjectURL(blob);
		$('dl-cert').download = `${addr.slice(0, 8)}-certificate.json`;
	} else {
		$('dl-cert').remove();
	}
}

/** @param {string} filename @param {string} contents */
function download(filename, contents) {
	const blob = new Blob([contents], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
