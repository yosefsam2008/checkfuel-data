// Vercel Function for the checkfuel-data project: fuel prices computed from official open data (data.gov.il, CBS).
// Served at https://checkfuel-data.vercel.app/prices.json through the rewrite in vercel.json; shipped apps read that URL.
// Deploy: merge to main and push (Vercel deploys from Git), wait for the deployment to be Ready, then
//   curl https://checkfuel-data.vercel.app/prices.json  ->  "computed":{"Gasoline":true,"Diesel":true,"Electric":true}
// Re-anchor (see MAINTENANCE.md): change only price and date (Electric: period) in ANCHORS, and set FALLBACK to the same
//   price as a 2-decimal string. The data.gov.il rows in effect on that date are looked up automatically.

const FALLBACK = { Gasoline: '7.77', Diesel: '11.71', Electric: '0.64' };
const VAT = 1.18;
// price = anchor.price + (Δgate + Δexcise) / 1000 × VAT, Δ = rows in effect today − rows in effect on anchor.date (₪/kL)
const ANCHORS = {
  Gasoline: { price: 7.77, date: '2026-10-05' }, // ministry max, 95 self-service
  // shortcut: diesel is not price-controlled; one station board (11.97 full service − 0.26), station margin assumed constant
  Diesel: { price: 11.71, date: '2026-10-20' },
  Electric: { price: 0.6352, period: '2026-07' }, // IEC home tariff of 2026-07-01; chained by CBS monthly % changes after it
};
// wide enough for years of normal drift, narrow enough to catch unit errors (₪/kL read as ₪/L, agorot as ₪)
const RANGE = { Gasoline: [4, 15], Diesel: [4, 20], Electric: [0.3, 1.5] };

const GATE = 'aaa40832-ac82-4c86-bac6-0d05c83f576f'; // orl-prices, refinery-gate prices
const EXCISE = 'bdce45e7-9fe9-473e-bd51-cef1d787a951'; // excise (בלו)
const ROWS = {
  Gasoline: { gate: 'בנזין 95 אוקטן נטול עופרת בהזרמה', excise: 'בלו בנזין (סעיף 1 לתוספת לצו)' },
  Diesel: { gate: 'סולר לתחבורה בהזרמה', excise: 'בלו סולר' },
};
// CBS caps a page at 100 months, so the electricity anchor stays usable for about 8 years
const CBS_URL = 'https://api.cbs.gov.il/index/data/price?id=120590&format=json&download=false&last=120';

const HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400' };

const num = (s) => {
  const n = Number(s);
  if (s === '' || s == null || !Number.isFinite(n)) throw new Error(`not a number: ${s}`);
  return n;
};

// q is full-text, so keep only the exact product, and skip rows dated after `day`
function latest(records, name, day) {
  if (records instanceof Error) throw records;
  const row = records
    .filter((r) => r['מוצר'] === name && r['תאריך'].slice(0, 10) <= day)
    .sort((a, b) => b['תאריך'].localeCompare(a['תאריך']))[0];
  if (!row) throw new Error(`no row ${name} on or before ${day}`);
  return { value: num(row['מחיר']), date: row['תאריך'].slice(0, 10) };
}

export function fuelPrice(field, { gate, excise }, today) {
  const a = ANCHORS[field];
  const g = latest(gate, ROWS[field].gate, today);
  const e = latest(excise, ROWS[field].excise, today);
  const g0 = latest(gate, ROWS[field].gate, a.date);
  const e0 = latest(excise, ROWS[field].excise, a.date);
  const price = a.price + ((g.value - g0.value) + (e.value - e0.value)) / 1000 * VAT;
  return { price, date: g.date > e.date ? g.date : e.date };
}

// percent is each month's change from the previous one, so it survives CBS rebasing
export function electricPrice(cbs) {
  if (cbs instanceof Error) throw cbs;
  const months = cbs?.month?.[0]?.date;
  if (!Array.isArray(months)) throw new Error('bad CBS response');
  const key = (m) => `${m.year}-${String(m.month).padStart(2, '0')}`;
  const { price, period } = ANCHORS.Electric;
  if (!months.some((m) => key(m) === period)) throw new Error(`CBS window lacks ${period}`);
  return { price: months.filter((m) => key(m) > period).reduce((p, m) => p * (1 + num(m.percent) / 100), price) };
}

function check(field, price) {
  const [lo, hi] = RANGE[field];
  if (!(price >= lo && price <= hi)) throw new Error(`out of range: ${price}`);
  return (Math.round(price * 100) / 100).toFixed(2);
}

// inputs: { Gasoline: { gate, excise }, Diesel: { gate, excise }, Electric: cbsJson }; any input may be an Error
export function buildPrices(inputs, today) {
  const body = { ...FALLBACK, effectiveFrom: ANCHORS.Gasoline.date, computed: {}, source: 'data.gov.il, משרד האנרגיה; הלמ"ס' };
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
  const q = new URLSearchParams({ resource_id: resource, q: name, sort: '_id desc', limit: '300' });
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
