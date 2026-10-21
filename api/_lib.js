// Shared helpers for the Google proxies. Vercel does not route files whose name starts with "_".
export const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY ?? process.env.GOOGLE_ROUTES_API_KEY;

// the web build calls these from another origin
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
export const json = (body, status = 200) => Response.json(body, { status, headers: CORS });
export const fail = (code, message, status) => json({ error: { code, message } }, status);
export const preflight = () => new Response(null, { status: 204, headers: CORS });

// ---------- KV: Upstash Redis REST (also what Vercel KV exposes). Fail-open: no env or any error means "no cache". ----------
const KV_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

async function kv(command) {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const res = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(800),
    });
    return res.ok ? (await res.json()).result : null;
  } catch {
    return null;
  }
}

/** Cached JSON or null; logs hit/miss under `tag` (never the key: it holds what the user typed). */
export async function cacheGet(tag, key) {
  const raw = await kv(['GET', key]);
  let value = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {}
  console.log(`${tag} cache: ${value ? 'hit' : 'miss'}`);
  return value;
}

export const cacheSet = (key, value, ttlSeconds) => kv(['SET', key, JSON.stringify(value), 'EX', ttlSeconds]);

// ---------- rate limit ----------
// shortcut: per-instance window, so the real cap is LIMIT x warm instances; move to KV INCR if abuse shows up
const LIMIT = 60; // requests per minute per IP, all endpoints together
const hits = new Map();

export function limited(req) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  const h = hits.get(ip);
  if (!h || h.minute !== minute) {
    if (hits.size > 5000) hits.clear(); // bound memory; the window is a minute anyway
    hits.set(ip, { minute, n: 1 });
    return false;
  }
  return ++h.n > LIMIT;
}

/** Shared guard for every proxy: rate limit, then the key. Returns an error Response or null. */
export function guard(req) {
  if (limited(req)) return fail('rate_limited', 'Too many requests, try again in a minute', 429);
  if (!GOOGLE_KEY) return fail('not_configured', 'Google API key missing on the server', 500);
  return null;
}

export const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(t);
export const isPlaceId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{10,300}$/.test(id);
export const isCoord = (lat, lng) => typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
