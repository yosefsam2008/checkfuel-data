// Vercel Function for the checkfuel-data project: driving route proxy for the Google Routes API (Essentials tier).
// Set GOOGLE_MAPS_API_KEY (or the older GOOGLE_ROUTES_API_KEY) in the project's env vars, redeploy.
// Served at https://checkfuel-data.vercel.app/api/route ; the app reads it from EXPO_PUBLIC_ROUTE_URL.
// Body: origin = originPlaceId | origin {latitude, longitude} | origin "address"; destination = destPlaceId | destination "address".
import { cacheGet, cacheSet, fail, guard, isCoord, isPlaceId, json, preflight, GOOGLE_KEY } from './_lib.js';

// Google Maps Platform ToS: Content may only be cached temporarily (lat/lng values up to 30 days); placeIds may be kept
// indefinitely. A route result is Content, so keep it short: one day covers "same trip twice" without holding Content long.
const TTL = 24 * 3600;

/** -> { wp: Google waypoint, key: cache-key part } or null when the input is missing/invalid */
export function waypoint(placeId, value) {
  if (placeId !== undefined) return isPlaceId(placeId) ? { wp: { placeId }, key: `pid:${placeId}` } : null;
  if (typeof value === 'string') {
    const a = value.trim();
    return a && a.length <= 200 ? { wp: { address: a }, key: `ad:${a.toLowerCase()}` } : null;
  }
  const { latitude: lat, longitude: lng } = value ?? {};
  // ~100m rounding so nearby requests share a cache entry
  return isCoord(lat, lng) ? { wp: { location: { latLng: { latitude: lat, longitude: lng } } }, key: `ll:${lat.toFixed(3)},${lng.toFixed(3)}` } : null;
}

export const OPTIONS = preflight;

export async function POST(req) {
  const blocked = guard(req);
  if (blocked) return blocked;

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('bad_json', 'Body must be JSON', 400);
  }
  const from = waypoint(body?.originPlaceId, body?.origin);
  const to = waypoint(body?.destPlaceId, body?.destination ?? null);
  if (!from || !to) return fail('bad_request', 'origin and destination are required', 400);

  const key = `rt:${from.key}|${to.key}`;
  const cached = await cacheGet('route', key);
  if (cached) return json(cached);

  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
    },
    body: JSON.stringify({ origin: from.wp, destination: to.wp, travelMode: 'DRIVE', languageCode: 'he', regionCode: 'IL' }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res?.ok) return fail('upstream', `Routes failed (${res?.status ?? 0})`, 502);

  const route = (await res.json()).routes?.[0];
  if (!route?.distanceMeters) return fail('no_route', 'No driving route between these points', 404);

  // same shape the app has always read (distanceMeters/durationSeconds), plus the polyline for the mini map
  const out = {
    distanceMeters: route.distanceMeters,
    durationSeconds: parseInt(route.duration ?? '0', 10),
    polyline: route.polyline?.encodedPolyline,
  };
  await cacheSet(key, out, TTL);
  return json(out);
}
