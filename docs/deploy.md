# Deploying

One Fetch handler (`server/app.mjs`) with two hosts. Pick either; the API is
identical apart from one endpoint noted below.

## Node (Docker, Cloud Run, a VM, anything)

```bash
npm ci
npm run build                       # static site into dist/
node server/keygen.mjs              # mint a durable attestation key
ATTESTATION_SEED=<hex> npm start    # serves the API and dist/ on :8787
```

The Dockerfile builds exactly this in two stages:

```bash
docker build -t solana-vanity .
docker run -p 8787:8787 -e ATTESTATION_SEED=<hex> solana-vanity
```

For Google Cloud Run:

```bash
gcloud run deploy solana-vanity \
  --source . --region us-central1 --allow-unauthenticated \
  --set-secrets ATTESTATION_SEED=solana-vanity-attestation:latest
```

## Cloudflare Workers

```bash
npm run build
npx wrangler secret put ATTESTATION_SEED
npx wrangler deploy
```

`wrangler.toml` binds `dist/` as the assets directory, so the Worker serves the
site and the API from one origin.

**One endpoint differs on the edge.** `POST /api/grind` needs the WebAssembly
grinder loaded from disk, which a Worker has no filesystem for. It answers 501
with a pointer to `/api/splitkey/grind`, which is pure arithmetic and runs
anywhere. Nothing else changes.

## Static-only

The browser grinder, the rarity table and certificate verification are all
client-side. `dist/` on any static host gives you a fully working grinder; the
pages degrade honestly when the API is absent (the certificate button reports
that provenance is unavailable, and the grinder is unaffected).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `ATTESTATION_SEED` | for durable certificates | 32-byte Ed25519 seed, hex or Base58. Without it the service mints an ephemeral key, says so in every response, and its certificates stop verifying on restart. |
| `ALLOW_SERVER_GRIND` | no | `1` enables the custodial `/api/grind`. Off by default; it returns a secret key over the network. |
| `PORT` | no | Node listen port. Default 8787. |

## After deploying

```bash
curl -s https://your-host/api/health
curl -s https://your-host/.well-known/solana-vanity.json    # your published key ring
curl -s https://your-host/openapi.json | head
```

`/api/health` reports whether the attestation key is ephemeral. If it says
`"ephemeral": true` on a production deployment, `ATTESTATION_SEED` did not reach
the process.
