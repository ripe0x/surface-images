# surface-images

Serves still images for [PND](https://pnd.fyi) Surface collections right
after each mint, then archives them to Arweave when you choose.

1. **Find collections.** The service watches one renderer. Every collection a
   Surface factory creates with that renderer (at deploy or by a later
   `setRenderer`) emits `RendererSet(renderer)`; the service picks it up from
   the logs once the block is confirmed and starts watching it, with no
   restart or configuration. A log from anything the factory did not create
   is ignored.
2. **Serve.** `GET /<collection>/<tokenId>.png` returns the token's PNG. A
   background loop watches each collection at a confirmed block and renders
   each new token from its own onchain HTML (`tokenURI` → `animation_url`),
   with the injected render context switched from `"token"` to `"capture"`.
   There is no local copy of the artwork, so the still is whatever the
   renderer serves.
3. **Point tokens at it.** The collection owner sets the RenderAssets capture
   template to `https://<host>/<collection>/{id}.png`. Every token then has an
   image with no per-mint transaction.
4. **Archive.** `npm run archive -- <from> <to>` downloads the hosted PNGs,
   uploads them to Arweave through ArDrive Turbo and verifies the bytes
   arweave.net serves.
5. **Publish.** The owner writes the verified `ar://` URIs with
   `RenderAssets.setCaptures`, then emits an ERC-4906 refresh.

The service holds no keys and no database. Its watch list and log cursor
live in `CACHE_DIR/collections.json`.

## Requirements

- Surface v2 collections (the `config()` that returns the renderer and the
  minted count) created by a factory with `isInstance(address)`, whose renderer returns `animation_url` as an HTML
  data URI containing exactly one injected `"context":"token"` (the Scripty
  renderer does), and draws its still into a canvas in `capture` context.
- Node 22.6 or newer. Rendering uses headless Chromium via Playwright.

## Run locally

```bash
npm install
npx playwright install chromium
CHAIN=sepolia FACTORY=0x... RENDERER=0x... FROM_BLOCK=<factory deploy block> CACHE_DIR=./cache npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAIN` | required | `mainnet` or `sepolia` |
| `FACTORY` | required | the Surface CloneFactory whose instances may be watched |
| `RENDERER` | required | watch every factory collection using this renderer |
| `FROM_BLOCK` | required | the factory's deploy block, where the first scan starts |
| `CACHE_DIR` | required | where PNGs are stored |
| `RPC_URL` | `https://<chain>.gateway.tenderly.co` | JSON-RPC endpoint |
| `CONFIRMATIONS` | `12` | blocks before a mint is rendered |
| `POLL_SECONDS` | `30` | how often new mints are checked |
| `IMAGE_SIZE` | `2048` | square output size in pixels |
| `RENDER_CONCURRENCY` | CPU count | browsers rendering in parallel |
| `PLACEHOLDER_URL` | built-in "Rendering…" SVG | https redirect for minted tokens not yet rendered |
| `PORT` | `8080` | HTTP port |

`GET /health` reports `scannedTo`, `lastPassAt`, `lastError`, and per
collection `minted`, `latestMinted` and `rendered`.

## Rush behavior

Requests only read PNGs from memory, so traffic never triggers rendering or
RPC calls. Rendered PNGs are cached for a year (a still never changes). A
token that is minted but not rendered yet (still confirming, or queued) gets
a "Rendering…" image with `no-cache`, so viewers pick up the real image as
soon as it exists; an id that is not minted at all returns 404.

Without a GPU, WebGL runs in software, and each browser has one GPU process,
so the service runs one browser per CPU. Measured on Fly.io for a 2048 × 2048
WebGL work: 9 s per token on one dedicated CPU, about 1.3 s on eight. Scale up
for a mint window and back down afterwards.

`CONFIRMATIONS` is the reorg assumption: a collection is found and a token
renders once its log or mint is
that deep, and the still is then cached forever. A deeper reorganization that
changed a seed needs that token's file deleted from `CACHE_DIR/<collection>`. Fewer
confirmations show images sooner (3 blocks is about 36 seconds on Ethereum);
12 is the conservative default.

## Deploy to Fly.io

```bash
cp fly.example.toml fly.toml
fly volumes create images --size 1 --region ewr --app <your-app>
fly deploy --ha=false
```

For a mint window:

```bash
fly scale vm performance-8x --app <your-app>
```

Once `/health` shows `rendered` equal to `minted`:

```bash
fly scale vm performance-1x --app <your-app>
```

A deploy returns the Machine to the size in `fly.toml`.

## Archive to Arweave

Uploads go through [ArDrive Turbo](https://docs.ar.io/build/upload/turbo-credits/),
paid in ETH on Ethereum mainnet. One dedicated Ethereum key pays for credits
and signs the uploads; fund it with a few dollars of ETH. Pass the key from
your secret store at run time; never write it to a file.

```bash
export ETH_PRIVATE_KEY="$(<command that prints the key>)" ETH_ADDRESS=<its address>
npm run archive -- balance
npm run archive -- top-up 0.002
```

`top-up` shows the credits the ETH buys and asks before sending; credits are
not refundable. About 45 PNGs of 750 KB per 0.001 ETH at October 2026 rates.

```bash
IMAGE_URL=https://<host>/<collection> COLLECTION=0x... CHAIN_ID=11155111 OUT_DIR=./archive PUBLISH_FILE=./archive/publish.json npm run archive -- 1 100
```

Each run moves every token one step: sign, upload, verify on arweave.net.
Re-run until every token reports `verified`. Signing is local and
deterministic and the signed upload is saved before it is sent, so re-runs
and crashes never pay twice (Turbo does not charge for a duplicate). Keep
`OUT_DIR` until the publish is confirmed.

## Publish

`PUBLISH_FILE` holds `{ "ids": [...], "uris": ["ar://...", ...] }` for every
verified token. From the collection owner or an admin:

1. `RenderAssets.setCaptures(collection, ids, uris)`
2. `collection.notifyMetadataUpdate(min, max)` so marketplaces re-fetch

Explicit captures take precedence over the template. Check a token's existing
image first: if it already has a permanent capture, leave it out.

## Tests

```bash
node --experimental-strip-types --no-warnings --test src/*.test.ts
```
