// Vercel Function for the checkfuel-data project: fuel prices computed from official open data (data.gov.il, CBS).
// Served at https://checkfuel-data.vercel.app/prices.json through the rewrite in vercel.json; shipped apps read that URL.
// Deploy: merge to main and push (Vercel deploys from Git), wait for the deployment to be Ready, then
//   curl https://checkfuel-data.vercel.app/prices.json  ->  "computed":{"Gasoline":true,"Diesel":true,"Electric":true}
// Re-anchor: set ANCHORS.<field> to a verified price plus the inputs in effect that day, and FALLBACK.<field> to the same price.
//   Gasoline when the ministry's monthly price differs from ours (margin or VAT changed); Diesel ~twice a year against a
//   real station price; Electric when CBS rebases (baseDesc changes).

const FALLBACK = { Gasoline: '7.77', Diesel: '11.71', Electric: '0.64' };
const VAT = 1.18;
// gate and excise in ₪ per kiloliter
const ANCHORS = {
  Gasoline: { price: 7.77, gate: 3110.44, excise: 2809.06, date: '2026-10-05' }, // ministry max, 95 self-service
  // shortcut: diesel is not price-controlled; one station board (11.97 full service − 0.26), station margin assumed constant
  Diesel: { price: 11.71, gate: 3879.94, excise: 3503.33, date: '2026-10-20' },
  Electric: { price: 0.6352, index: 104.7, base: '2024 ממוצע' }, // IEC home tariff of 2026-07-01
};
const RANGE = { Gasoline: [1, 20], Diesel: [1, 20], Electric: [0.2, 3] }; // same ranges as the app's parsePrices
const MAX_DRIFT = 0.15;

const GATE = 'aaa40832-ac82-4c86-bac6-0d05c83f576f'; // orl-prices, refinery-gate prices
const EXCISE = 'bdce45e7-9fe9-473e-bd51-cef1d787a951'; // excise (בלו)
const ROWS = {
  Gasoline: { gate: 'בנזין 95 אוקטן נטול עופרת בהזרמה', excise: 'בלו בנזין (סעיף 1 לתוספת לצו)' },
  Diesel: { gate: 'סולר לתחבורה בהזרמה', excise: 'בלו סולר' },
};
const CBS_URL = 'https://api.cbs.gov.il/index/data/price?id=120590&format=json&download=false&last=3';

const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' };

const num = (s) => {
  const n = Number(s);
  if (s === '' || s == null || !Number.isFinite(n)) throw new Error(`not a number: ${s}`);
  return n;
};

// q is full-text, so keep only the exact product, and skip rows announced for a future date
function latest(records, name, today) {
  if (records instanceof Error) throw records;
  const row = records
    .filter((r) => r['מוצר'] === name && r['תאריך'].slice(0, 10) <= today)
    .sort((a, b) => b['תאריך'].localeCompare(a['תאריך']))[0];
  if (!row) throw new Error(`no row ${name}`);
  return { value: num(row['מחיר']), date: row['תאריך'].slice(0, 10) };
}

export function fuelPrice(field, { gate, excise }, today) {
  const a = ANCHORS[field];
  const g = latest(gate, ROWS[field].gate, today);
  const e = latest(excise, ROWS[field].excise, today);
  const price = a.price + ((g.value - a.gate) + (e.value - a.excise)) / 1000 * VAT;
  return { price, date: g.date > e.date ? g.date : e.date };
}

export function electricPrice(cbs) {
  if (cbs instanceof Error) throw cbs;
  const latestMonth = cbs?.month?.[0]?.date?.[0]?.currBase;
  if (latestMonth?.baseDesc !== ANCHORS.Electric.base) throw new Error(`CBS base changed: ${latestMonth?.baseDesc}`);
  return { price: ANCHORS.Electric.price * num(latestMonth.value) / ANCHORS.Electric.index };
}

function check(field, price) {
  const [lo, hi] = RANGE[field];
  const anchor = ANCHORS[field].price;
  if (!(price >= lo && price <= hi) || Math.abs(price - anchor) / anchor > MAX_DRIFT) throw new Error(`out of range: ${price}`);
  return (Math.round(price * 100) / 100).toFixed(2);
}

// inputs: { Gasoline: { gate, excise }, Diesel: { gate, excise }, Electric: cbsJson }; any input may be an Error
export function buildPrices(inputs, today) {
  const body = { ...FALLBACK, effectiveFrom: ANCHORS.Gasoline.date, computed: {}, source: 'data.gov.il, משרד האנרגיה' };
  for (const field of ['Gasoline', 'Diesel', 'Electric']) {
    try {
      const r = field === 'Electric' ? electricPrice(inputs.Electric) : fuelPrice(field, inputs[field], today);
      body[field] = check(field, r.price);
      if (field === 'Gasoline') body.effectiveFrom = r.date;
      body.computed[field] = true;
    } catch (e) {
      console.error(`prices: ${field} fallback: ${e.message}`);
      body.computed[field] = false;
    }
  }
  return body;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const records = async (resource, name) => {
  const q = new URLSearchParams({ resource_id: resource, q: name, sort: '_id desc', limit: '20' });
  const data = await getJson(`https://data.gov.il/api/3/action/datastore_search?${q}`);
  if (!data?.success || !Array.isArray(data.result?.records)) throw new Error(`bad datastore response for ${name}`);
  return data.result.records;
};

export async function GET() {
  const today = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 10);
  const settled = await Promise.allSettled([
    records(GATE, ROWS.Gasoline.gate),
    records(EXCISE, ROWS.Gasoline.excise),
    records(GATE, ROWS.Diesel.gate),
    records(EXCISE, ROWS.Diesel.excise),
    getJson(CBS_URL),
  ]);
  const [gg, ge, dg, de, cbs] = settled.map((s) => (s.status === 'fulfilled' ? s.value : s.reason));
  const body = buildPrices({ Gasoline: { gate: gg, excise: ge }, Diesel: { gate: dg, excise: de }, Electric: cbs }, today);
  return Response.json(body, { headers: HEADERS });
}
