/**
 * Rarity appraiser page.
 *
 * Two jobs: appraise a pasted address through the API, and render the exact
 * Base58 leading-character table that explains why the numbers look the way
 * they do. The table is the argument; the appraiser is the demo.
 */

import { LEADING_CHAR_PROBABILITY, leadingCharDifficultyRatio } from '../base58-distribution.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '∞');

$('appraise').addEventListener('click', run);
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

async function run() {
	const address = $('addr').value.trim();
	$('err').hidden = true;
	$('out').hidden = true;
	if (!address) {
		fail('Paste a Solana address first.');
		return;
	}
	const btn = $('appraise');
	btn.disabled = true;
	btn.textContent = 'Appraising…';
	try {
		const payload = { address, ignoreCase: $('ci').checked };
		const plen = parseInt($('plen').value, 10);
		const slen = parseInt($('slen').value, 10);
		if (Number.isInteger(plen)) payload.prefixLen = plen;
		if (Number.isInteger(slen)) payload.suffixLen = slen;

		const r = await fetch('/api/appraise', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(payload),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		render(data.appraisal);
	} catch (e) {
		fail(e.message);
	} finally {
		btn.disabled = false;
		btn.textContent = 'Appraise';
	}
}

/** @param {string} message */
function fail(message) {
	$('err').textContent = message;
	$('err').hidden = false;
}

/** @param {any} a */
function render(a) {
	const bonuses = (a.bonuses || []).length
		? `<div style="margin-top:.8rem">
				<span class="fl">Bonuses</span>
				${a.bonuses.map((b) => `<div class="kv"><span class="k">${esc(b.label)}</span><span class="v">+${b.bits} bits<span style="display:block;font-weight:400;color:#666;font-size:.72rem">${esc(b.detail)}</span></span></div>`).join('')}
			</div>`
		: '<p class="lede" style="font-size:.8rem;margin:.8rem 0 0">No pattern bonuses: the characters are not a word, a palindrome or a repeat run.</p>';

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result" style="margin-top:1.1rem">
			<h3>${esc(a.tierLabel)} · rarity score ${a.rarityScore}</h3>
			<div class="addr">${a.prefix ? `<span class="pfx">${esc(a.prefix)}</span>` : ''}${esc(a.address.slice((a.prefix || '').length, a.address.length - (a.suffix || '').length))}${a.suffix ? `<span class="sfx">${esc(a.suffix)}</span>` : ''}</div>
			<div class="meta">
				Treated <strong>${(a.prefix || '').length}</strong> leading and <strong>${(a.suffix || '').length}</strong> trailing characters as intentional.
			</div>
			<div class="kv"><span class="k">Expected attempts</span><span class="v">${fmt(a.expectedAttempts)}</span></div>
			<div class="kv"><span class="k">Effective length</span><span class="v">${a.effectiveLength} chars</span></div>
			<div class="kv"><span class="k">Rarity bits</span><span class="v">${a.rarityBits}</span></div>
			<div class="kv"><span class="k">Grind time at ${fmt(a.ratePerSecond)}/s</span><span class="v">${esc(a.grindHuman)}</span></div>
			<div class="kv"><span class="k">Difficulty model</span><span class="v">${esc(a.model)}</span></div>
			${bonuses}
		</div>`;
}

// ── The leading-character table ──────────────────────────────────────────────
renderTable();

function renderTable() {
	const rows = Object.entries(LEADING_CHAR_PROBABILITY)
		.map(([ch, p]) => ({ ch, p, ratio: leadingCharDifficultyRatio(ch) }))
		.sort((a, b) => b.p - a.p);

	// Group consecutive characters that share a probability band: the table has
	// six bands and 58 rows, and the bands are the point.
	const bands = [];
	for (const row of rows) {
		const last = bands[bands.length - 1];
		if (last && Math.abs(last.p - row.p) / row.p < 1e-9) last.chars.push(row.ch);
		else bands.push({ p: row.p, ratio: row.ratio, chars: [row.ch] });
	}

	$('table').innerHTML = bands.map((b) => {
		const harder = b.ratio > 1;
		const label = b.chars.length > 3
			? `${esc(b.chars[0])} … ${esc(b.chars[b.chars.length - 1])} <span style="color:#666">(${b.chars.length} symbols)</span>`
			: b.chars.map((c) => `<code>${esc(c)}</code>`).join(' ');
		return `<div class="kv">
			<span class="k">${label}</span>
			<span class="v" style="color:${harder ? '#f87171' : '#4ade80'}">
				${b.p.toExponential(3)}
				<span style="display:block;font-weight:400;font-size:.72rem;color:#666">
					${harder ? `${b.ratio.toFixed(1)}× harder` : `${(1 / b.ratio).toFixed(1)}× easier`} than the 1/58 model claims
				</span>
			</span>
		</div>`;
	}).join('') + `<p class="lede" style="font-size:.8rem;margin:.9rem 0 0">
		Computed here in your browser from <code>src/base58-distribution.js</code>: an exact BigInt count of how many of the
		2²⁵⁶ possible keys encode to a string starting with each symbol. The probabilities sum to 1.
	</p>`;
}
