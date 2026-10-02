/* ───────────────────────────────────────────────────────────────
   functions/relay/[[path]].js — a stateless pass-through for /relay/*.

   Why it exists: neither vendor answers a browser. api.typesafe.ai refuses
   the preflight from any origin we tried ("Disallowed CORS origin"), and the
   Enablers gateway answers the preflight 401 with no CORS headers. So the
   page posts to its own origin, and this forwards the request.

   What it does, and all it does:
     - three routes, fixed upstream URLs, POST only; anything else is 404/405
     - same-origin callers only (the Origin header must be this site)
     - the caller's own `Authorization: Bearer …` goes upstream unchanged;
       no key is ever added here, and a request without one is refused
     - Content-Type and Authorization are the only headers forwarded; no
       cookies, no client IP headers
     - the body is capped, read once, and streamed back as the vendor sent it
     - nothing is logged, cached or stored: no console call, no KV, no cache
       API, and `Cache-Control: no-store` on every response

   Inert until the Pages project sets RELAY_ENABLED=1, so deploying the site
   does not open it. Locally, tools/jev-attributes/server.mjs runs the same
   `relay()` (see its --public flag).
   ─────────────────────────────────────────────────────────────── */

export const ROUTES = {
  "typesafe/systemone": "https://api.typesafe.ai/v1/systemone",
  "laya/systemone": "https://inference-staging.api.enablers.algolia.net/v1/systemone",
  "enablers/chat/completions": "https://inference-eu.api.enablers.algolia.net/v1/chat/completions",
};

export const MAX_BODY = 512 * 1024;
const TIMEOUT_MS = 180000;

const reply = (status, error) => new Response(JSON.stringify({ error }), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

/** Request → Response. `fetchImpl` is the upstream fetch, swapped in tests. */
export async function relay(request, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/relay\//, "");
  const upstream = Object.prototype.hasOwnProperty.call(ROUTES, route) ? ROUTES[route] : null;
  if (!upstream) return reply(404, "no such route");
  if (request.method !== "POST") return reply(405, "POST only");
  if (request.headers.get("Origin") !== url.origin) return reply(403, "same-origin only");
  const auth = request.headers.get("Authorization") || "";
  if (!/^Bearer [^\s]{8,4096}$/.test(auth)) return reply(401, "bring your own key");
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) return reply(413, "body too large");
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY) return reply(413, "body too large");

  let res;
  try {
    res = await fetchImpl(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth, "User-Agent": "agent-studio-demos-relay" },
      body,
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (_) {
    return reply(502, "upstream unreachable");
  }
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(res.headers.get("Retry-After") ? { "Retry-After": res.headers.get("Retry-After") } : {}),
    },
  });
}

/** Cloudflare Pages Functions entry point */
export function onRequest(context) {
  if (!context.env || context.env.RELAY_ENABLED !== "1") return reply(404, "relay off");
  return relay(context.request);
}
