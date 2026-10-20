// node --test test/   (no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrices } from '../api/prices.js';

const row = (date, name, price) => ({ 'תאריך': `${date} 00:00:00`, 'מוצר': name, 'מחיר': price });
const GAS = 'בנזין 95 אוקטן נטול עופרת בהזרמה';
const GAS_EX = 'בלו בנזין (סעיף 1 לתוספת לצו)';
const DSL = 'סולר לתחבורה בהזרמה';
const DSL_EX = 'בלו סולר';

// real data.gov.il rows (proof table in checkfuel/docs/prices-source.md), plus look-alike rows the full-text q also returns
const gate = [row('2026-09-01', GAS, '2671.31'), row('2026-10-01', GAS, '3110.44'), row('2026-10-01', 'בנזין 95 אוקטן נטול עופרת במכלית', '3085.55'),
  row('2026-09-01', DSL, '3259.47'), row('2026-10-01', DSL, '3879.94')];
const excise = [row('2026-09-01', GAS_EX, '3656.52'), row('2026-09-07', GAS_EX, '3232.79'), row('2026-10-01', GAS_EX, '3232.79'),
  row('2026-10-05', GAS_EX, '2809.06'), row('2026-10-05', 'בלו בנזין 100 לכלי טיס ק"ל', '9999'), row('2026-10-01', DSL_EX, '3503.33')];
const month = (year, m, percent, baseDesc = '2024 ממוצע') => ({ year, month: m, percent, currBase: { baseDesc, value: 100 } });
// newest first, like the CBS API
const cbsMonths = [month(2026, 9, 0), month(2026, 8, 0), month(2026, 7, -0.8), month(2026, 6, 0)];
const cbs = (months = cbsMonths) => ({ month: [{ code: 120590, date: months }] });
const inputs = (over = {}) => ({ Gasoline: { gate, excise }, Diesel: { gate, excise }, Electric: cbs(), ...over });
const TODAY = '2026-10-20';

test('proof table with the real anchor: 8.25, 7.75, 8.27, 7.77', () => {
  for (const [day, want] of [['2026-09-01', '8.25'], ['2026-09-07', '7.75'], ['2026-10-01', '8.27'], ['2026-10-05', '7.77']]) {
    const p = buildPrices(inputs(), day);
    assert.deepEqual([p.Gasoline, p.computed.Gasoline, p.effectiveFrom], [want, true, day], day);
  }
});

test('diesel gives 11.71 at its anchor', () => {
  const p = buildPrices(inputs(), TODAY);
  assert.deepEqual([p.Diesel, p.computed.Diesel], ['11.71', true]);
});

test('a future-dated row is ignored', () => {
  const p = buildPrices(inputs({ Gasoline: { gate: [...gate, row('2026-11-01', GAS, '3300')], excise } }), TODAY);
  assert.deepEqual([p.Gasoline, p.effectiveFrom], ['7.77', '2026-10-05']);
});

test('a missing anchor-date row falls back', () => {
  // only a row after the anchor date: no gate row is in effect on 2026-10-05
  const p = buildPrices(inputs({ Gasoline: { gate: [row('2026-10-10', GAS, '3110.44')], excise } }), TODAY);
  assert.deepEqual([p.Gasoline, p.computed.Gasoline, p.effectiveFrom], ['7.77', false, '2026-10-05']);
});

test('a non-numeric price falls back', () => {
  for (const bad of ['abc', '', null]) {
    const p = buildPrices(inputs({ Gasoline: { gate: [...gate, row('2026-10-15', GAS, bad)], excise } }), TODAY);
    assert.deepEqual([p.Gasoline, p.computed.Gasoline], ['7.77', false], String(bad));
  }
});

test('a fetch error falls back for that field only', () => {
  const p = buildPrices(inputs({ Diesel: { gate: new Error('timeout'), excise } }), TODAY);
  assert.deepEqual(p.computed, { Gasoline: true, Diesel: false, Electric: true });
  assert.equal(p.Diesel, '11.71');
});

test('a unit error (gate × 10) falls back', () => {
  const p = buildPrices(inputs({ Gasoline: { gate: [...gate, row('2026-10-15', GAS, '31104.4')], excise } }), TODAY);
  assert.deepEqual([p.Gasoline, p.computed.Gasoline], ['7.77', false]);
});

test('a legitimate +20% drift is not a fallback', () => {
  // +1.554 ₪/L = 7.77 × 0.2, i.e. gate +1316.95 ₪/kL before VAT
  const p = buildPrices(inputs({ Gasoline: { gate: [...gate, row('2026-10-15', GAS, '4427.39')], excise } }), TODAY);
  assert.deepEqual([p.Gasoline, p.computed.Gasoline], ['9.32', true]);
});

test('electric: July −0.8%, Aug 0, Sep 0 gives 0.64; a later +2.0% month gives 0.6352 × 1.02', () => {
  assert.equal(buildPrices(inputs(), TODAY).Electric, '0.64');
  const p = buildPrices(inputs({ Electric: cbs([month(2026, 10, 2.0), ...cbsMonths]) }), TODAY);
  assert.deepEqual([p.Electric, p.computed.Electric], [(0.6352 * 1.02).toFixed(2), true]);
});

test('electric: a CBS rebase mid-window still computes', () => {
  const rebased = [month(2026, 10, 2.0, '2026 ממוצע'), month(2026, 9, 0, '2026 ממוצע'), month(2026, 8, 0), month(2026, 7, -0.8)];
  const p = buildPrices(inputs({ Electric: cbs(rebased) }), TODAY);
  assert.deepEqual([p.Electric, p.computed.Electric], ['0.65', true]);
});

test('electric: an anchor period missing from the window falls back, the other fields stay computed', () => {
  for (const c of [cbs([month(2026, 9, 0), month(2026, 8, 0)]), {}, new Error('timeout')]) {
    const p = buildPrices(inputs({ Electric: c }), TODAY);
    assert.equal(p.Electric, '0.64');
    assert.deepEqual(p.computed, { Gasoline: true, Diesel: true, Electric: false });
  }
});

test('response keeps the string fields the apps parse', () => {
  const p = buildPrices(inputs(), TODAY);
  for (const k of ['Gasoline', 'Diesel', 'Electric']) assert.equal(typeof p[k], 'string');
  assert.equal(p.source, 'data.gov.il, משרד האנרגיה; הלמ"ס');
});
