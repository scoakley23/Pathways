import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, buildOfficeMatcher, parseDate, parseProcessingTime, parseRange, toMonths } from '../scripts/lib/uscis.mjs';

test('converts units to months', () => {
  assert.equal(toMonths(6, 'Months'), 6);
  assert.equal(toMonths('2', 'years'), 24);
  assert.ok(Math.abs(toMonths(52, 'Weeks') - 12) < 1e-9);
  assert.ok(Math.abs(toMonths(365, 'Days') - 12) < 1e-9);
});

test('rejects values it cannot interpret instead of guessing', () => {
  assert.throws(() => toMonths(5, 'fortnights'), ParseError);
  assert.throws(() => toMonths(5, undefined), ParseError);
  assert.throws(() => toMonths(0, 'Months'), ParseError);
  assert.throws(() => toMonths('', 'Months'), ParseError);
  assert.throws(() => toMonths(null, 'Months'), ParseError);
  assert.throws(() => parseRange([]), ParseError);
  assert.throws(() => parseRange([{ value: 4, unit: 'Months' }, { value: 'n/a', unit: 'Months' }]), ParseError);
});

test('single-value range', () => {
  const r = parseRange([{ value: 11, unit: 'Months' }]);
  assert.deepEqual(r, { months: 11, lowMonths: null, display: '11 months', raw: [{ value: 11, unit: 'Months' }] });
});

test('two-bound range uses the upper bound, in either order', () => {
  const r = parseRange([{ value: 14, unit: 'Months' }, { value: 30, unit: 'Weeks' }]);
  assert.equal(r.months, 14);
  assert.equal(r.lowMonths, 6.9);
  assert.equal(r.display, '30 weeks – 14 months');
  assert.equal(parseRange([{ value: 30, unit: 'Weeks' }, { value: 14, unit: 'Months' }]).months, 14);
});

test('processing-time responses must have the expected shape', () => {
  assert.throws(() => parseProcessingTime({}), ParseError);
  assert.throws(() => parseProcessingTime({ data: { processing_time: {} } }), ParseError);
  const [e] = parseProcessingTime({
    data: { processing_time: { subtypes: [{ form_type: 'X', publication_date: 'September 15, 2026', range: [{ value: 3, unit: 'Months' }] }] } },
  });
  assert.equal(e.subtype, 'X');
  assert.equal(e.months, 3);
  assert.equal(e.publicationDate, '2026-09-15');
});

test('parses USCIS dates', () => {
  assert.equal(parseDate('March 1, 2025'), '2025-03-01');
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(undefined), null);
});

test('matches office names to coordinates', () => {
  const match = buildOfficeMatcher([
    { name: 'Boston MA', aliases: [] },
    { name: 'Saint Albans VT', aliases: ['St Albans VT'] },
    { name: 'National Benefits Center', aliases: ['NBC'] },
  ]);
  assert.equal(match('BOS', 'Boston MA')?.name, 'Boston MA');
  assert.equal(match('XYZ', 'Boston MA Field Office')?.name, 'Boston MA');
  assert.equal(match('STA', 'St. Albans VT')?.name, 'Saint Albans VT');
  assert.equal(match('NBC', 'Something else')?.name, 'National Benefits Center');
  assert.equal(match('BOX', 'Bostonia CA'), null);
});
