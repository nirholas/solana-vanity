/**
 * Certificate verification page.
 *
 * Verification happens entirely in this tab, against the issuer's published key
 * ring, not against the key the certificate names for itself, which is the
 * check a self-signed forgery would pass. The key ring is fetched once from
 * `/.well-known/solana-vanity.json`; if that fetch fails the page says so and
 * still verifies everything else, marking the pin as unavailable rather than
 * quietly passing.
 */

import { verifyProofOfGrind } from '../proof-of-grind.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** @type {Array<{keyId?:string, publicKeyBase58:string}> | null} */
let keyring = null;
let keyringError = '';

loadKeyring();

async function loadKeyring() {
	try {
		const r = await fetch('/.well-known/solana-vanity.json');
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const data = await r.json();
		keyring = Array.isArray(data.attestationKeys) ? data.attestationKeys : null;
		if (!keyring?.length) throw new Error('no attestation keys published');
	} catch (e) {
		keyringError = e.message;
	}
}

$('file').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	$('cert').value = await file.text();
	verify();
});

$('verify').addEventListener('click', verify);

function verify() {
	$('err').hidden = true;
	$('out').hidden = true;

	let cert;
	try {
		cert = JSON.parse($('cert').value);
	} catch {
		$('err').textContent = 'That is not valid JSON. Paste the whole certificate document, including the outer braces.';
		$('err').hidden = false;
		return;
	}
	if (cert && cert.certificate && typeof cert.certificate === 'object') cert = cert.certificate;

	const result = verifyProofOfGrind(cert, keyring ? { keyring } : {});
	render(result);
}

/** @param {{valid:boolean, checks:Array<{id:string,label:string,pass:boolean,detail:string}>, address:string, certId:string}} result */
function render(result) {
	const passed = result.checks.filter((c) => c.pass).length;
	const banner = result.valid
		? `<h3 style="color:#4ade80">✓ Valid: ${passed}/${result.checks.length} checks passed</h3>`
		: `<h3 style="color:#f87171">✗ Not valid: ${result.checks.length - passed} check${result.checks.length - passed === 1 ? '' : 's'} failed</h3>`;

	const note = keyring
		? ''
		: `<p class="lede" style="font-size:.8rem;color:var(--warn-fg);margin:.6rem 0 0">
				The published key ring could not be loaded${keyringError ? ` (${esc(keyringError)})` : ''}, so the signature was checked against the
				certificate's own key. That catches tampering but not a forged issuer. Retry when the service is reachable.
			</p>`;

	$('out').hidden = false;
	$('out').innerHTML = `
		<div class="result" style="border-color:${result.valid ? 'rgba(74,222,128,.3)' : 'rgba(248,113,113,.35)'};background:${result.valid ? 'rgba(74,222,128,.05)' : 'rgba(248,113,113,.05)'}">
			${banner}
			<div class="addr">${esc(result.address || 'no address in certificate')}</div>
			<div class="meta">certificate id ${esc((result.certId || '').slice(0, 24))}…</div>
			${result.checks.map((c) => `
				<div class="kv">
					<span class="k">${c.pass ? '<span style="color:#4ade80">✓</span>' : '<span style="color:#f87171">✗</span>'} ${esc(c.label)}</span>
					<span class="v" style="font-weight:400;font-size:.76rem;color:#999;text-align:right;max-width:60%">${esc(c.detail)}</span>
				</div>`).join('')}
			${note}
		</div>`;
}
