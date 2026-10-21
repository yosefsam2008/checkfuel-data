// POST /api/places/autocomplete  { input, sessionToken, lat?, lng? } -> { suggestions: [{ placeId, main, secondary }] }
// Places API (New) Autocomplete. Billing: keystrokes inside one sessionToken are free once /api/places/details closes the session.
import { cacheGet, cacheSet, fail, guard, isCoord, isToken, json, preflight, GOOGLE_KEY } from '../_lib.js';

// Predictions are short-lived Google content kept well under the 30-day ceiling; placeIds themselves have no caching limit.
const TTL = 7 * 24 * 3600;

export const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
// bias rounded to 0.1° (~10km) so nearby users share entries
export const acKey = (input, lat, lng) => `ac:${normalize(input)}:${isCoord(lat, lng) ? `${lat.toFixed(1)},${lng.toFixed(1)}` : '-'}`;

export const toSuggestions = (data) =>
  (data?.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p) => p?.placeId)
    .map((p) => ({ placeId: p.placeId, main: p.structuredFormat?.mainText?.text ?? '', secondary: p.structuredFormat?.secondaryText?.text ?? '' }));

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
  const input = typeof body?.input === 'string' ? body.input.trim() : '';
  const { sessionToken, lat, lng } = body ?? {};
  if (input.length < 2 || input.length > 100) return fail('bad_input', 'input must be 2-100 characters', 400);
  if (!isToken(sessionToken)) return fail('bad_token', 'sessionToken missing or malformed', 400);

  const key = acKey(input, lat, lng);
  const cached = await cacheGet('autocomplete', key);
  if (cached) return json({ suggestions: cached });

  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify({
      input,
      sessionToken,
      languageCode: 'he',
      includedRegionCodes: ['il'],
      ...(isCoord(lat, lng) && { locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 30000 } } }),
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return fail('upstream', `Places autocomplete failed (${res?.status ?? 0})`, 502);

  const suggestions = toSuggestions(await res.json());
  await cacheSet(key, suggestions, TTL);
  return json({ suggestions });
}
