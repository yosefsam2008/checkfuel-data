// GET /api/places/details?id=<placeId>&token=<sessionToken> -> { lat, lng }
// Place Details (New) with the autocomplete sessionToken closes the billing session. Field mask is `location` only (cheapest SKU).
// Not cached here on purpose: the app keeps the coords with the recent place, and a skipped call would leave the session open.
import { fail, guard, isPlaceId, isToken, json, preflight, GOOGLE_KEY } from '../_lib.js';

export const OPTIONS = preflight;

export async function GET(req) {
  const blocked = guard(req);
  if (blocked) return blocked;

  const params = new URL(req.url).searchParams;
  const id = params.get('id');
  const token = params.get('token');
  if (!isPlaceId(id)) return fail('bad_id', 'id missing or malformed', 400);
  if (!isToken(token)) return fail('bad_token', 'token missing or malformed', 400);

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(token)}`, {
    headers: { 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'location' },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (res?.status === 404) return fail('not_found', 'Place not found', 404);
  if (!res?.ok) return fail('upstream', `Place details failed (${res?.status ?? 0})`, 502);

  const loc = (await res.json()).location;
  if (!loc) return fail('not_found', 'Place has no location', 404);
  return json({ lat: loc.latitude, lng: loc.longitude });
}
