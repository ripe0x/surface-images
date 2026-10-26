# surface-images

Serves still images for a [PND](https://pnd.fyi) Surface collection right
after each mint, then archives them to Arweave when you choose.

1. **Serve.** `GET /<tokenId>.png` returns the token's PNG. A background loop
   watches the collection at a confirmed block and renders each new token from
   its own onchain HTML (`tokenURI` → `animation_url`), with the injected
   render context switched from `"token"` to `"capture"`. There is no local
   copy of the artwork, so the still is whatever the renderer serves.
2. **Point tokens at it.** The collection owner sets the RenderAssets capture
   template to `https://<host>/{id}.png`. Every token then has an image with
   no per-mint transaction.
3. **Archive.** `npm run archive -- <from> <to>` downloads the hosted PNGs,
   uploads them to Arweave with native AR transactions and verifies the
   confirmed bytes.
4. **Publish.** The owner writes the verified `ar://` URIs with
   `RenderAssets.setCaptures`, then emits an ERC-4906 refresh.

The service holds no keys and no database.

## Requirements

- A Surface collection whose renderer returns `animation_url` as an HTML
  data URI containing exactly one injected `"context":"token"` (the Scripty
  renderer does), and draws its still into a canvas in `capture` context.
- Node 22.6 or newer. Rendering uses headless Chromium via Playwright.

## Run locally

```bash
npm install
npx playwright install chromium
CHAIN=sepolia COLLECTION=0x... CACHE_DIR=./cache npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHAIN` | required | `mainnet` or `sepolia` |
| `COLLECTION` | required | Surface collection address |
| `CACHE_DIR` | required | where PNGs are stored |
| `RPC_URL` | `https://<chain>.gateway.tenderly.co` | JSON-RPC endpoint |
| `CONFIRMATIONS` | `12` | blocks before a mint is rendered |
| `POLL_SECONDS` | `30` | how often new mints are checked |
| `IMAGE_SIZE` | `2048` | square output size in pixels |
| `RENDER_CONCURRENCY` | CPU count | browsers rendering in parallel |
| `PLACEHOLDER_URL` | built-in "Rendering…" SVG | https redirect for minted tokens not yet rendered |
| `PORT` | `8080` | HTTP port |

`GET /health` reports `minted`, `rendered`, `lastPassAt` and `lastError`.

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

`CONFIRMATIONS` is the reorg assumption: a token renders once its mint is
that deep, and the still is then cached forever. A deeper reorganization that
changed a seed needs that token's file deleted from `CACHE_DIR`. Fewer
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

Fund a dedicated Arweave wallet with only what the upload needs (about
0.01 AR per 700 KB PNG). Pass its key from your secret store at run time;
never write it to a file:

```bash
ARWEAVE_JWK="$(<command that prints the wallet JWK>)" ARWEAVE_ADDRESS=<wallet address> IMAGE_URL=https://<host> COLLECTION=0x... CHAIN_ID=11155111 OUT_DIR=./archive PUBLISH_FILE=./archive/publish.json MAX_UPLOAD_WINSTON=50000000000 npm run archive -- 1 100
```

Each run moves every token one step: sign, upload, verify. Re-run until
every token reports `verified` (Arweave confirmation takes about 40 minutes).
A signature is saved before it is sent, so re-runs and crashes never pay twice.
Keep `OUT_DIR` until the publish is confirmed.

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
