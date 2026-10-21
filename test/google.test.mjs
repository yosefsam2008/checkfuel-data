// node --test test/   (no network: fetch is faked)
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_MAPS_API_KEY = 'test-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://kv.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
const { waypoint, POST: routePOST } = await import('../api/route.js');
const { acKey, toSuggestions, POST: acPOST } = await import('../api/places/autocomplete.js');
const { GET: detailsGET } = await import('../api/places/details.js');

// fake KV + Google; `kvBroken` makes every KV call fail
let store, google, kvBroken;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://kv.test')) {
    if (kvBroken) throw new Error('kv down');
    const [cmd, key, value] = JSON.parse(init.body);
    if (cmd === 'SET') store.set(key, value);
    return Response.json({ result: cmd === 'GET' ? (store.get(key) ?? null) : 'OK' });
  }
  google.push({ url, init });
  if (url.includes('computeRoutes')) return Response.json({ routes: [{ distanceMeters: 12345, duration: '900s', polyline: { encodedPolyline: 'abc' } }] });
  if (url.includes('places:autocomplete'))
    return Response.json({ suggestions: [{ placePrediction: { placeId: 'ChIJazrieli01', structuredFormat: { mainText: { text: 'עזריאלי' }, secondaryText: { text: 'תל אביב' } } } }] });
  return Response.json({ location: { latitude: 32.07, longitude: 34.79 } });
};
const reset = () => ((store = new Map()), (google = []), (kvBroken = false));
let ip = 0; // fresh IP per request so the rate limiter stays out of the way
const post = (handler, body) => handler(new Request('https://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': `10.0.0.${++ip % 250}` } }));

test('waypoint: placeId, address, coords, invalid', () => {
  assert.deepEqual(waypoint('ChIJazrieli01', undefined).wp, { placeId: 'ChIJazrieli01' });
  assert.equal(waypoint(undefined, ' Tel Aviv ').key, 'ad:tel aviv');
  assert.equal(waypoint(undefined, { latitude: 32.07123, longitude: 34.79456 }).key, 'll:32.071,34.795');
  assert.equal(waypoint('bad id!', undefined), null);
  assert.equal(waypoint(undefined, { latitude: 91, longitude: 0 }), null);
  assert.equal(waypoint(undefined, null), null);
});

test('route: second identical request is a cache hit (one Google call)', async () => {
  reset();
  const body = { originPlaceId: 'ChIJorigin001', destPlaceId: 'ChIJazrieli01' };
  const a = await (await post(routePOST, body)).json();
  const b = await (await post(routePOST, body)).json();
  assert.deepEqual(a, b);
  assert.deepEqual(a, { distanceMeters: 12345, durationSeconds: 900, polyline: 'abc' });
  assert.equal(google.length, 1);
  assert.deepEqual(JSON.parse(google[0].init.body).destination, { placeId: 'ChIJazrieli01' });
});

test('route: KV down -> fail-open, still answers', async () => {
  reset();
  kvBroken = true;
  const res = await post(routePOST, { origin: { latitude: 32, longitude: 34.8 }, destPlaceId: 'ChIJazrieli01' });
  assert.equal(res.status, 200);
  assert.equal(google.length, 1);
});

test('route: bad input -> {error:{code,message}}', async () => {
  reset();
  const res = await post(routePOST, { origin: { latitude: 32, longitude: 34.8 } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_request');
  assert.equal(google.length, 0);
});

test('autocomplete: normalized, biased, cached, field mask', async () => {
  reset();
  assert.equal(acKey('  Azrieli   TLV ', 32.0712, 34.7934), 'ac:azrieli tlv:32.1,34.8');
  const body = { input: 'עזריאלי', sessionToken: 'tok-12345678', lat: 32.07, lng: 34.79 };
  const a = await (await post(acPOST, body)).json();
  await post(acPOST, body);
  assert.deepEqual(a.suggestions, [{ placeId: 'ChIJazrieli01', main: 'עזריאלי', secondary: 'תל אביב' }]);
  assert.equal(google.length, 1);
  const sent = JSON.parse(google[0].init.body);
  assert.equal(sent.sessionToken, 'tok-12345678');
  assert.deepEqual(sent.includedRegionCodes, ['il']);
  assert.equal(sent.locationBias.circle.radius, 30000);
  assert.equal(google[0].init.headers['X-Goog-FieldMask'], 'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat');
  assert.deepEqual(toSuggestions({}), []);
});

test('autocomplete: rejects 1-char input and missing token', async () => {
  reset();
  assert.equal((await post(acPOST, { input: 'ע', sessionToken: 'tok-12345678' })).status, 400);
  assert.equal((await post(acPOST, { input: 'עז' })).status, 400);
  assert.equal(google.length, 0);
});

test('details: same token, location-only mask', async () => {
  reset();
  const res = await detailsGET(new Request('https://x/api/places/details?id=ChIJazrieli01&token=tok-12345678'));
  assert.deepEqual(await res.json(), { lat: 32.07, lng: 34.79 });
  assert.match(google[0].url, /places\/ChIJazrieli01\?sessionToken=tok-12345678$/);
  assert.equal(google[0].init.headers['X-Goog-FieldMask'], 'location');
});
