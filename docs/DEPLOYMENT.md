# Deploying Colombo Atlas

The live site is hosted on **Cloudflare Pages**. Two large files live in the
`colombo-atlas-assets` bucket on the VPS's Garage S3 store, published read-only at
`https://colombo-assets.prabhavalabs.com`. Visitors use the same website for the map and
all downloads.

Pages accepts files up to 25 MiB. The city core and the complete landmark ZIP are
larger, so the Pages build moves them out of the static upload and adds a small
request handler. It streams those two files from the asset origin, supports resumed
downloads, and caches complete responses at the edge. Everything else stays on Pages'
static hosting. The models are unchanged.

## Current setup

| Setting | Value |
| --- | --- |
| Website | `https://colombo.prabhavalabs.com` |
| Pages project | `colombo-atlas` |
| Pages address | `https://colombo-atlas.pages.dev` |
| Production branch | `main` |
| Asset bucket | `colombo-atlas-assets` on Garage (`https://s3.prabhavalabs.com`) |
| Asset origin | `https://colombo-assets.prabhavalabs.com` (`LARGE_ASSETS_ORIGIN` in `wrangler.json`) |
| Node.js | 24 |

This project uses **Direct Upload**. A GitHub push by itself does not deploy it.
The deployment command builds locally, uploads the large files to Garage with the
AWS CLI, then publishes the Pages site. Nothing is stored in Cloudflare R2.

## Deploy an update

From a clean checkout of `main`, with Node.js installed:

```sh
npm ci
npx wrangler login
npm test
export COLOMBO_ASSETS_S3_ACCESS_KEY_ID=...      # the colombo-atlas key on the VPS:
export COLOMBO_ASSETS_S3_SECRET_ACCESS_KEY=...  # /opt/platform/env/apps/colombo-atlas.s3.env
npm run deploy
```

Use a Cloudflare login that can access this Pages project. The upload needs the AWS
CLI and the Garage key in the environment. Never put tokens or keys in the source files.

Each large file gets a content-hashed object key. The deployed handler refers to
those exact versions, so updating a model cannot silently change an older Pages
deployment. Keep old bucket objects while those deployments may need to be restored.

For a new setup, create the bucket on the VPS (it is public through Garage's website
endpoint and nginx) and the Pages project before the first deployment:

```sh
/opt/platform/bin/s3-new-app.sh colombo-atlas colombo-atlas-assets   # on the VPS
npx wrangler pages project create colombo-atlas --production-branch main
```

Project names must be available in the target account. If you rename resources,
update `wrangler.json` and the project name in the `deploy` command too.

## Check the build without publishing

```sh
npm run build:pages
```

The website is in `dist/`. Large files and their upload manifest are staged in
`.cloudflare-build/`; both directories are local build output. Always run the full
build before uploading. `npm run deploy` does this automatically and stops if an
upload fails.

For normal local development and a complete static build, keep using `npm run dev`
and `npm run build`. `npm run preview` is for that normal build; the Pages build
reads the large files from the asset origin.

## Domain setup

In Cloudflare, open **Workers & Pages → colombo-atlas → Custom domains** and add
`colombo.prabhavalabs.com`. Confirm the CNAME to `colombo-atlas.pages.dev` in the
`prabhavalabs.com` zone. Register the custom domain with Pages before adding DNS,
then wait for Cloudflare to show it as active and issue its HTTPS certificate.

See Cloudflare's [Pages limits](https://developers.cloudflare.com/pages/platform/limits/),
and [custom domain instructions](https://developers.cloudflare.com/pages/configuration/custom-domains/).
