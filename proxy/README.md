# Optional CORS proxy

The Workbench can use bundled company data or a `companyfacts.json` loaded in the
browser. This optional proxy adds direct loading for non-bundled SEC filers.

You need the proxy only for that third case. The SEC's XBRL API
(`data.sec.gov/api/xbrl/*`) answers the CORS preflight but doesn't put an
`Access-Control-Allow-Origin` header on the actual response, so a browser can't read
it. This worker fetches the file server-side, where that rule doesn't apply, and
hands it back with the header.

## Deploy with Cloudflare

```bash
npm install -g wrangler
wrangler login
cd proxy
# edit the User-Agent email in worker.js first; the SEC asks clients to identify themselves
wrangler deploy
```

`wrangler deploy` prints a URL like `https://filing-forensics-proxy.<you>.workers.dev`.

## Use it

Open the Workbench, expand **Advanced**, paste that URL, and select **Save proxy**.
The setting is stored in your browser only. From then on, resolving a non-bundled
company loads it live instead of routing you to the download-and-drop step.

## What it will and won't do

- Serves only `GET /api/xbrl/*`. Any other path is refused.
- Sets the SEC-required `User-Agent` and edge-caches each file for an hour.
- Holds no secrets and writes nothing. It's a read-through cache with a CORS header.

The proxy is optional. Its response goes through the same browser-side extraction used
for a downloaded `companyfacts.json`.
