# ciel-cors-proxy

A tiny Cloudflare Worker that proxies
[`fossi-foundation/ciel-releases`](https://github.com/fossi-foundation/ciel-releases)
asset downloads with `Access-Control-Allow-Origin: *`, so browser
JavaScript can `fetch()` the `.tar.zst` archives directly. GitHub's
own release-asset CDN does not set CORS headers.

The Worker is intentionally allowlisted to URLs starting with

```
https://github.com/fossi-foundation/ciel-releases/releases/download/
```

so it cannot be used as a generic CORS bypass.

## Live deployment used by this repo's GitHub Pages site

```
https://ciel-cors-proxy.sifferman.workers.dev/?url=<url-encoded-upstream-url>
```

`main.gd` points at that URL directly. If you fork this repo and want
your own deploy, replace `SKY130_CORS_PROXY_URL_PREFIX` in
`project/main.gd` with the URL of your own deployment of this worker.

## Deploying your own copy

```bash
cd infra/cors-proxy
wrangler deploy
```

The Worker name (`ciel-cors-proxy`) plus your Cloudflare account's
`workers.dev` subdomain together form the URL:

```
https://ciel-cors-proxy.<your-cf-subdomain>.workers.dev
```

## Usage

```
GET https://ciel-cors-proxy.<your-cf-subdomain>.workers.dev/?url=<url-encoded-upstream-url>
```

`<upstream-url>` must start with the allowlisted prefix above. Any other
URL returns HTTP 400.

## Trust model

The proxy is untrusted. Callers are expected to verify the downloaded
bytes against a SHA-256 they obtained from a trusted source (e.g. the
[GitHub release API](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)'s
per-asset `digest` field, which is CORS-clean).
