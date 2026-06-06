/* Filing Forensics CORS proxy: a Cloudflare Worker.
 *
 * Why it exists: data.sec.gov/api/xbrl/* answers the CORS preflight but never puts
 * Access-Control-Allow-Origin on the actual GET, so a browser can't read the body.
 * This worker fetches the file server-side (no CORS rule applies) and re-serves it
 * with the header, letting the Workbench load *any* filer live instead of making the
 * user download a companyfacts.json by hand.
 *
 * It is deliberately narrow: it only proxies GET requests to the XBRL API path, sets
 * the SEC-required User-Agent, and caches at the edge. Deploy it, then paste the
 * worker URL into the Workbench's Advanced box.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler deploy            # from this directory (see wrangler.toml)
 * Then set https://<name>.<you>.workers.dev under Advanced in the Workbench.
 */

const ALLOW_PATH = /^\/api\/xbrl\//;            // only the XBRL API, nothing else
const UA = "Filing Forensics (research/teaching) ianthelfrich@gmail.com"; // edit to your own contact email

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return cors(json({ error: "only GET" }, 405));
    if (!ALLOW_PATH.test(url.pathname)) {
      return cors(json({ error: "this proxy only serves /api/xbrl/* from data.sec.gov" }, 400));
    }

    const target = `https://data.sec.gov${url.pathname}${url.search}`;
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { "User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip" },
        cf: { cacheTtl: 3600, cacheEverything: true },   // edge-cache an hour
      });
    } catch (e) {
      return cors(json({ error: "upstream fetch failed", detail: String(e) }, 502));
    }

    if (!upstream.ok) return cors(json({ error: "SEC returned " + upstream.status }, upstream.status));

    const body = await upstream.arrayBuffer();
    const out = new Response(body, { status: 200 });
    out.headers.set("Content-Type", "application/json");
    out.headers.set("Cache-Control", "public, max-age=3600");
    return cors(out);
  },
};

function cors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  return resp;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
