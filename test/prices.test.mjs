// node --test api/   (no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrices } from './prices.js';

const row = (date, name, price) => ({ 'תאריך': `${date} 00:00:00`, 'מוצר': name, 'מחיר': price });
const GAS = 'בנזין 95 אוקטן נטול עופרת בהזרמה';
const GAS_EX = 'בלו בנזין (סעיף 1 לתוספת לצו)';

// proof table in checkfuel/docs/prices-source.md, plus look-alike rows the full-text q also returns
const gate = [row('2026-09-01', GAS, '2671.31'), row('2026-10-01', GAS, '3110.44'), row('2026-10-01', 'בנזין 95 אוקטן נטול עופרת במכלית', '3085.55'),
  row('2026-10-01', 'סולר לתחבורה בהזרמה', '3879.94')];
const excise = [row('2026-09-01', GAS_EX, '3656.52'), row('2026-09-07', GAS_EX, '3232.79'), row('2026-10-01', GAS_EX, '3232.79'),
  row('2026-10-05', GAS_EX, '2809.06'), row('2026-10-05', 'בלו בנזין 100 לכלי טיס ק"ל', '9999'), row('2026-10-01', 'בלו סולר', '3503.33')];
const cbs = (value, baseDesc = '2024 ממוצע') => ({ month: [{ code: 120590, date: [{ year: 2026, month: 9, currBase: { baseDesc, value } }] }] });
const inputs = (over = {}) => ({ Gasoline: { gate, excise }, Diesel: { gate, excise }, Electric: cbs(104.7), ...over });

test('proof table: 8.25, 7.75, 8.27, 7.77', () => {
  for (const [day, want] of [['2026-09-01', '8.25'], ['2026-09-07', '7.75'], ['2026-10-01', '8.27'], ['2026-10-05', '7.77']]) {
    const p = buildPrices(inputs(), day);
    assert.equal(p.Gasoline, want, day);
    assert.equal(p.effectiveFrom, day);
    assert.equal(p.computed.Gasoline, true);
  }
});

test('a row dated in the future is ignored', () => {
  const p = buildPrices(inputs({ Gasoline: { gate: [...gate, row('2026-11-01', GAS, '3300')], excise } }), '2026-10-20');
  assert.equal(p.Gasoline, '7.77');
  assert.equal(p.effectiveFrom, '2026-10-05');
});

test('missing row falls back', () => {
  const p = buildPrices(inputs({ Gasoline: { gate: [], excise } }), '2026-10-20');
  assert.deepEqual([p.Gasoline, p.computed.Gasoline, p.effectiveFrom], ['7.77', false, '2026-10-05']);
});

test('fetch error falls back for that field only', () => {
  const p = buildPrices(inputs({ Diesel: { gate: new Error('timeout'), excise } }), '2026-10-20');
  assert.deepEqual(p.computed, { Gasoline: true, Diesel: false, Electric: true });
});

test('more than 15% from the anchor falls back', () => {
  const p = buildPrices(inputs({ Gasoline: { gate: [row('2026-10-01', GAS, '4500')], excise } }), '2026-10-20');
  assert.deepEqual([p.Gasoline, p.computed.Gasoline], ['7.77', false]);
});

test('non-numeric price falls back', () => {
  for (const bad of ['abc', '', null]) {
    const p = buildPrices(inputs({ Gasoline: { gate: [row('2026-10-01', GAS, bad)], excise } }), '2026-10-20');
    assert.deepEqual([p.Gasoline, p.computed.Gasoline], ['7.77', false], String(bad));
  }
});

test('electric: index 104.7 gives 0.64', () => {
  assert.equal(buildPrices(inputs(), '2026-10-20').Electric, '0.64');
});

test('electric: CBS rebase or missing value falls back for Electric only', () => {
  for (const c of [cbs(100, 'ממוצע 2026'), cbs(undefined), {}, new Error('timeout')]) {
    const p = buildPrices(inputs({ Electric: c }), '2026-10-20');
    assert.equal(p.Electric, '0.64');
    assert.deepEqual(p.computed, { Gasoline: true, Diesel: true, Electric: false });
  }
});

test('diesel at the anchor inputs gives 11.71', () => {
  const p = buildPrices(inputs(), '2026-10-20');
  assert.deepEqual([p.Diesel, p.computed.Diesel], ['11.71', true]);
});

test('response keeps the string fields the apps parse', () => {
  const p = buildPrices(inputs(), '2026-10-20');
  for (const k of ['Gasoline', 'Diesel', 'Electric']) assert.equal(typeof p[k], 'string');
  assert.equal(p.source, 'data.gov.il, משרד האנרגיה');
});
