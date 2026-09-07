/**
 * Grinder page controller.
 *
 * Owns the pattern inputs, the difficulty read-out, the core selector, the live
 * grind loop and everything the page shows once a key exists. The grind itself
 * happens in `../grinder.js`, which fans the work out to one Web Worker per
 * selected core; this module never touches a keypair except to render and
 * export it.
 *
 * The secret key lives in this module's closure and in nothing else: no
 * localStorage, no fetch body, no console.log. The only way it leaves the tab is
 * a download or a clipboard copy the visitor asked for.
 */

import bs58 from 'bs58';
import { grindVanity } from '../grinder.js';
import {
	validatePattern, expectedAttempts, effectiveLength, MAX_PATTERN_LENGTH,
} from '../validation.js';
import { computeRarity } from '../rarity.js';
import { setGrindActivity } from './activity.js';

const $ = (id) => document.getElementById(id);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Rough per-core throughput used only for the pre-grind estimate. The WASM
 * ed25519 grinder derives tens of thousands of keypairs/sec per core; 30k is a
 * conservative figure consistent with the live rate the grinder reports once
 * running. Every pre-grind number is labelled a rough estimate; the live rate is
 * the real one.
 */
const RATE_PER_CORE = 30000;

let ignoreCase = false;

// ── Core selection ───────────────────────────────────────────────────────────
const HW_CORES = Math.max(1, navigator.hardwareConcurrency || 4);
const DEFAULT_CORES = Math.max(1, Math.min(HW_CORES, Math.round(HW_CORES / 2) || 1));
let cores = DEFAULT_CORES;

const coreSlider = $('core-count');
coreSlider.max = String(HW_CORES);
coreSlider.value = String(DEFAULT_CORES);
$('core-max').textContent = HW_CORES;
$('core-count-val').textContent = DEFAULT_CORES;
$('cores').textContent = DEFAULT_CORES;

const presetVals = [...new Set([1, DEFAULT_CORES, HW_CORES])].sort((a, b) => a - b);
const presetLabel = (n) => (n === 1 ? '1 core' : n === HW_CORES ? `Max (${n})` : `${n}`);
$('core-ticks').innerHTML = presetVals
	.map((n) => `<button type="button" data-cores="${n}" aria-pressed="${n === DEFAULT_CORES}">${presetLabel(n)}</button>`)
	.join('');

function setCores(n) {
	cores = Math.max(1, Math.min(HW_CORES, n | 0));
	coreSlider.value = String(cores);
	$('core-count-val').textContent = cores;
	$('core-ticks').querySelectorAll('button').forEach((b) => {
		b.setAttribute('aria-pressed', String(Number(b.dataset.cores) === cores));
	});
	refreshChipEstimates();
	update();
}

function refreshChipEstimates() {
	document.querySelectorAll('.chip').forEach((c) => {
		const est = c.querySelector('.chip-est');
		if (est) est.textContent = ' ' + fmtTime(estSeconds(c.dataset.prefix || '', c.dataset.suffix || ''));
	});
}

coreSlider.addEventListener('input', () => setCores(Number(coreSlider.value)));
$('core-ticks').querySelectorAll('button').forEach((b) => {
	b.addEventListener('click', () => setCores(Number(b.dataset.cores)));
});

// ── Formatting helpers ───────────────────────────────────────────────────────
function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const ADDR_LEN = 44;

function sample(prefix = '', suffix = '') {
	const mid = Math.max(0, ADDR_LEN - prefix.length - suffix.length);
	let out = prefix;
	for (let i = 0; i < mid; i++) out += BASE58[Math.floor(Math.random() * BASE58.length)];
	return out + suffix;
}

function fmtTime(seconds) {
	if (seconds < 1) return '<1s';
	if (seconds < 60) return `~${Math.round(seconds)}s`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)}h`;
	return '>1d';
}

function estSeconds(prefix, suffix) {
	if (!prefix && !suffix) return 0;
	return expectedAttempts(prefix, suffix, ignoreCase) / (RATE_PER_CORE * cores);
}

document.querySelectorAll('.chip').forEach((c) => {
	c.querySelector('.chip-est').textContent = ' ' + fmtTime(estSeconds(c.dataset.prefix || '', c.dataset.suffix || ''));
	c.addEventListener('click', () => {
		$('prefix').value = c.dataset.prefix || '';
		$('suffix').value = c.dataset.suffix || '';
		$('prefix').dispatchEvent(new Event('input'));
		($('prefix').value ? $('prefix') : $('suffix')).focus();
	});
});

// ── Idle preview ─────────────────────────────────────────────────────────────
let previewLoop = null;
function startPreviewLoop() {
	stopPreviewLoop();
	previewLoop = setInterval(() => {
		const pfx = $('prefix').value;
		const sfx = $('suffix').value;
		if ((!pfx && !sfx) || $('prefix').classList.contains('invalid') || $('suffix').classList.contains('invalid')) return;
		const rest = $('preview').querySelector('.rest');
		if (rest) rest.textContent = sample(pfx, sfx).slice(pfx.length, ADDR_LEN - sfx.length);
	}, 700);
}
function stopPreviewLoop() {
	if (previewLoop) clearInterval(previewLoop);
	previewLoop = null;
}

function renderPreview(pfx, sfx, restClass = 'rest') {
	const s = sample(pfx, sfx);
	const mid = s.slice(pfx.length, ADDR_LEN - sfx.length);
	return `${pfx ? `<span class="pfx">${esc(pfx)}</span>` : ''}<span class="${restClass}">${esc(mid)}</span>${sfx ? `<span class="sfx">${esc(sfx)}</span>` : ''}`;
}

function update() {
	const pfx = $('prefix').value;
	const sfx = $('suffix').value;
	ignoreCase = $('ignore-case').checked;

	const pfxValid = !pfx || BASE58_RE.test(pfx);
	const sfxValid = !sfx || BASE58_RE.test(sfx);
	$('prefix').classList.toggle('invalid', !pfxValid);
	$('suffix').classList.toggle('invalid', !sfxValid);

	const total = pfx.length + sfx.length;
	const over = total > MAX_PATTERN_LENGTH;
	$('combo-warn').textContent = over
		? `Prefix + suffix can be at most ${MAX_PATTERN_LENGTH} characters combined (you have ${total}). Longer patterns aren't realistic to grind in a browser. Delegate them instead.`
		: '';

	document.querySelectorAll('.meter .seg').forEach((s, i) => {
		const lit = Math.min(total, MAX_PATTERN_LENGTH);
		s.className = 'seg' + (i < lit ? ` lit-${lit}` : '');
	});

	if (!pfx && !sfx) {
		$('preview').innerHTML = `<span class="rest">${esc(sample())}</span>`;
		$('est').textContent = 'type a prefix or suffix to see estimated time';
		$('tier').innerHTML = '';
		$('grind').disabled = true;
		return;
	}
	if (!pfxValid || !sfxValid) {
		$('preview').textContent = 'invalid Base58: avoid 0, O, I, l';
		$('est').textContent = '';
		$('tier').innerHTML = '';
		$('grind').disabled = true;
		return;
	}
	if (over) {
		$('preview').innerHTML = renderPreview(pfx, sfx);
		$('est').textContent = '';
		$('tier').innerHTML = '';
		$('grind').disabled = true;
		return;
	}

	$('preview').innerHTML = renderPreview(pfx, sfx);
	$('est').textContent = `rough estimate: ${fmtTime(estSeconds(pfx, sfx))} on ${cores} cores`;
	const attempts = expectedAttempts(pfx, sfx, ignoreCase);
	const effLen = effectiveLength(attempts);
	const tier = computeRarity({ prefix: pfx, suffix: sfx, ignoreCase }).tierLabel;
	$('tier').innerHTML = effLen >= 5
		? `<span class="tier-tag tier-paid">${esc(tier)} · slow, minutes+</span>`
		: `<span class="tier-tag tier-free">${esc(tier)} · fast</span>`;
	$('grind').disabled = false;
}

['prefix', 'suffix'].forEach((id) => {
	$(id).addEventListener('input', update);
	$(id).addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !$('grind').disabled) $('grind').click();
	});
});
$('ignore-case').addEventListener('change', () => { refreshChipEstimates(); update(); });
update();
startPreviewLoop();

// ── Grind ────────────────────────────────────────────────────────────────────
let abort = null;
let controls = null;
let scanLoop = null;

function setCoreControlsDisabled(disabled) {
	coreSlider.disabled = disabled;
	$('core-ticks').querySelectorAll('button').forEach((b) => { b.disabled = disabled; });
	$('prefix').disabled = disabled;
	$('suffix').disabled = disabled;
	$('ignore-case').disabled = disabled;
}

function setPaused(paused) {
	$('pause').textContent = paused ? 'Resume' : 'Pause';
	$('pause').classList.toggle('primary', paused);
	$('paused-tag').hidden = !paused;
	$('progress').classList.toggle('paused', paused);
	setGrindActivity(paused ? 0 : 1);
}

function endGrindUI() {
	if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	$('pause').hidden = true;
	$('stop').hidden = true;
	setPaused(false);
	setCoreControlsDisabled(false);
	setGrindActivity(0);
}

$('grind').addEventListener('click', async () => {
	const prefix = $('prefix').value.trim();
	const suffix = $('suffix').value.trim();
	if (!prefix && !suffix) {
		$('error').textContent = 'Enter a prefix, a suffix, or both.';
		$('error').hidden = false;
		return;
	}
	const errs = [];
	if (prefix) { const v = validatePattern(prefix); if (!v.valid) errs.push(...v.errors.map((e) => `prefix: ${e}`)); }
	if (suffix) { const v = validatePattern(suffix); if (!v.valid) errs.push(...v.errors.map((e) => `suffix: ${e}`)); }
	if (prefix.length + suffix.length > MAX_PATTERN_LENGTH) errs.push(`prefix + suffix exceed ${MAX_PATTERN_LENGTH} characters combined`);
	if (errs.length) {
		$('error').textContent = errs.join('; ');
		$('error').hidden = false;
		return;
	}

	$('grind').hidden = true;
	$('pause').hidden = false;
	$('stop').hidden = false;
	setPaused(false);
	setCoreControlsDisabled(true);
	$('progress').hidden = false;
	$('result').hidden = true;
	$('error').hidden = true;
	$('attempts').textContent = '0';
	$('rate').textContent = '0/s';
	$('cores').textContent = cores;
	$('eta').textContent = fmtTime(estSeconds(prefix, suffix));
	$('scan').innerHTML = renderPreview(prefix, suffix, 'scan-mid');
	stopPreviewLoop();

	scanLoop = setInterval(() => {
		if (controls?.paused) return;
		const midNode = $('scan').querySelector('.scan-mid');
		if (midNode) midNode.textContent = sample(prefix, suffix).slice(prefix.length, ADDR_LEN - suffix.length);
	}, 100);

	abort = new AbortController();
	controls = {};
	try {
		const result = await grindVanity({
			prefix,
			suffix,
			ignoreCase,
			maxWorkers: cores,
			controller: controls,
			signal: abort.signal,
			onProgress: ({ attempts, rate, eta, paused }) => {
				$('attempts').textContent = attempts.toLocaleString();
				$('rate').textContent = paused ? 'paused' : `${Math.round(rate).toLocaleString()}/s`;
				$('eta').textContent = eta;
				setGrindActivity(paused ? 0 : Math.min(1, rate / (RATE_PER_CORE * cores)));
			},
		});
		renderResult(result, prefix, suffix);
	} catch (err) {
		endGrindUI();
		if (err?.name !== 'AbortError') {
			$('error').textContent = `Grind failed: ${err.message || err}`;
			$('error').hidden = false;
		}
		$('grind').hidden = false;
		$('progress').hidden = true;
		startPreviewLoop();
	} finally {
		controls = null;
		if (scanLoop) { clearInterval(scanLoop); scanLoop = null; }
	}
});

$('pause').addEventListener('click', () => {
	if (!controls) return;
	if (controls.paused) { controls.resume(); setPaused(false); }
	else { controls.pause(); setPaused(true); }
});

$('stop').addEventListener('click', () => abort?.abort());

// ── Result, export, certificate ──────────────────────────────────────────────
function renderResult(result, prefix, suffix) {
	endGrindUI();
	$('grind').hidden = false;
	$('grind').textContent = 'Generate another';
	$('progress').hidden = true;

	const addr = result.publicKey;
	// Highlight the characters the *address* actually has, never the ones that
	// were typed: under a case-insensitive grind the two differ, and rendering
	// the request would show a string that is not the address you now own.
	const head = addr.slice(0, prefix.length);
	const tail = suffix ? addr.slice(addr.length - suffix.length) : '';
	const mid = addr.slice(prefix.length, suffix ? addr.length - suffix.length : addr.length);
	const addrHtml = `${head ? `<span class="pfx">${esc(head)}</span>` : ''}${esc(mid)}${tail ? `<span class="sfx">${esc(tail)}</span>` : ''}`;
	const rate = Math.round(result.attempts / (result.durationMs / 1000));
	const rarity = computeRarity({ prefix, suffix, ignoreCase });

	$('result').hidden = false;
	$('result').innerHTML = `
		<div class="result">
			<h3>✦ Wallet ready</h3>
			<div class="addr">${addrHtml}</div>
			<div class="meta">
				${result.attempts.toLocaleString()} attempts in ${(result.durationMs / 1000).toFixed(1)}s
				across ${result.workers} cores (${rate.toLocaleString()}/s) ·
				<strong>${esc(rarity.tierLabel)}</strong>, rarity score ${rarity.rarityScore}
			</div>
			<div class="export-grid">
				<button id="download" class="btn primary" type="button">⬇ Keypair JSON (Solana CLI)</button>
				<button id="copy-secret" class="btn" type="button">Copy secret key (Base58)</button>
				<button id="copy-pubkey" class="btn" type="button">Copy address</button>
				<button id="certify" class="btn" type="button">Get proof-of-grind certificate</button>
			</div>
			<div class="secret-box" id="secret-box" hidden>
				<span class="fl">Secret key (Base58), treat like cash</span>
				<code id="secret-value"></code>
			</div>
			<div id="cert-host"></div>
			<div class="warn">
				<strong>Save the keypair file before navigating away.</strong>
				Once you close this tab the secret key is gone. Nothing about it was ever sent anywhere.
				Anyone with the file can spend funds at this address.
			</div>
		</div>
	`;

	const filename = `${addr.slice(0, 8)}.json`;
	$('download').addEventListener('click', () => {
		const json = JSON.stringify(Array.from(result.secretKey));
		const blob = new Blob([json], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	});

	$('copy-secret').addEventListener('click', async () => {
		const b58 = bs58.encode(result.secretKey);
		$('secret-value').textContent = b58;
		$('secret-box').hidden = false;
		await copyOrSelect($('copy-secret'), b58, $('secret-value'), 'Copy secret key (Base58)');
	});

	$('copy-pubkey').addEventListener('click', async () => {
		await copyOrSelect($('copy-pubkey'), addr, $('result').querySelector('.addr'), 'Copy address');
	});

	$('certify').addEventListener('click', () => requestCertificate({ result, prefix, suffix, rate }));
}

/**
 * Copy to the clipboard, and fall back to selecting the text when the clipboard
 * is unavailable (denied permission, insecure context) so the button never
 * silently does nothing.
 * @param {HTMLButtonElement} btn
 * @param {string} text
 * @param {Element} selectTarget
 * @param {string} label
 */
async function copyOrSelect(btn, text, selectTarget, label) {
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = 'Copied!';
	} catch {
		const range = document.createRange();
		range.selectNodeContents(selectTarget);
		const sel = window.getSelection();
		sel.removeAllRanges();
		sel.addRange(range);
		btn.textContent = 'Selected, press Ctrl+C';
	}
	setTimeout(() => { btn.textContent = label; }, 2000);
}

/**
 * Ask the API to sign a proof-of-grind certificate for this address.
 *
 * Only public values are sent: the address, the pattern and the observed
 * attempt count. The certificate is a signed statement of provenance that
 * anyone can verify offline on /verify.html; it is not, and cannot be, a claim
 * about the secret key, which the server has never seen.
 *
 * @param {{ result: any, prefix: string, suffix: string, rate: number }} ctx
 */
async function requestCertificate({ result, prefix, suffix, rate }) {
	const host = $('cert-host');
	const btn = $('certify');
	btn.disabled = true;
	host.innerHTML = '<div class="cert-box"><span class="spin"></span> requesting a signed certificate…</div>';
	try {
		const r = await fetch('/api/certify', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				address: result.publicKey,
				prefix,
				suffix,
				ignoreCase,
				attempts: result.attempts,
				durationMs: result.durationMs,
				workers: result.workers,
				attemptsPerSecond: rate,
				scheme: 'browser-wasm',
			}),
		});
		const data = await r.json();
		if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
		const blob = new Blob([JSON.stringify(data.certificate, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		host.innerHTML = `
			<div class="cert-box">
				<h4>Certificate issued</h4>
				<div class="kv"><span class="k">Address</span><span class="v">${esc(result.publicKey.slice(0, 6))}…${esc(result.publicKey.slice(-4))}</span></div>
				<div class="kv"><span class="k">Tier</span><span class="v">${esc(data.certificate.rarity?.tier ?? 'unrated')}</span></div>
				<div class="kv"><span class="k">Signed by</span><span class="v">${esc((data.certificate.keyId || '').slice(0, 16))}…</span></div>
				<div class="actions">
					<a class="btn" href="${url}" download="${esc(result.publicKey.slice(0, 8))}-certificate.json">⬇ Download certificate</a>
					<a class="btn" href="/verify.html" rel="noopener">Verify it →</a>
				</div>
			</div>`;
	} catch (e) {
		host.innerHTML = `<div class="cert-box"><h4>Certificate unavailable</h4>
			<p style="margin:.2rem 0 0;color:var(--muted)">${esc(e.message)}. Your wallet above is unaffected: the certificate is optional provenance, not part of the key.</p>
			</div>`;
		btn.disabled = false;
	}
}
