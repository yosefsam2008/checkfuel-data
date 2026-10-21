// Vercel Function for the checkfuel-data project: driving route proxy for the Google Routes API (Essentials tier).
// Copy to api/route.js in checkfuel-data, set GOOGLE_ROUTES_API_KEY in the project's env vars, redeploy.
// Served at https://checkfuel-data.vercel.app/api/route ; the app reads it from EXPO_PUBLIC_ROUTE_URL.
const API_KEY = process.env.GOOGLE_ROUTES_API_KEY;

// shortcut: per-instance memory cache and no rate limit; add a KV cache + per-IP limit if Google costs show up
const cache = new Map();

// the web build calls this from another origin
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req) {
  if (!API_KEY) return json({ error: 'not_configured' }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  // origin is GPS coords or a typed address
  const addr = typeof body?.origin === 'string' ? body.origin.trim() : null;
  const lat = body?.origin?.latitude;
  const lng = body?.origin?.longitude;
  const dest = typeof body?.destination === 'string' ? body.destination.trim() : '';
  const coordsOk = typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if ((addr === null ? !coordsOk : !addr || addr.length > 200) || !dest || dest.length > 200) {
    return json({ error: 'bad_request' }, 400);
  }

  // ~100m origin rounding so nearby requests share a cache entry
  const key = `${addr !== null ? addr.toLowerCase() : `${lat.toFixed(3)},${lng.toFixed(3)}`}|${dest.toLowerCase()}`;
  if (cache.has(key)) return json(cache.get(key));

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin: addr !== null ? { address: addr } : { location: { latLng: { latitude: lat, longitude: lng } } },
      destination: { address: dest },
      travelMode: 'DRIVE',
      languageCode: 'he',
      regionCode: 'IL',
    }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res?.ok) return json({ error: 'upstream', status: res?.status ?? 0 }, 502);

  const route = (await res.json()).routes?.[0];
  if (!route?.distanceMeters) return json({ error: 'no_route' }, 404);

  const out = {
    distanceMeters: route.distanceMeters,
    durationSeconds: parseInt(route.duration ?? '0', 10),
    polyline: route.polyline?.encodedPolyline,
  };
  cache.set(key, out);
  return json(out);
}
