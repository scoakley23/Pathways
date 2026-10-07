#!/usr/bin/env node
// Checks data/processing-times.json before it is published. Exits non-zero
// (and the scheduled workflow refuses to commit) if the data is sample data,
// malformed, implausible, stale, or changed suspiciously since last time.
//
// Usage:
//   node scripts/validate-data.mjs [file] [--previous old.json] [--max-age-days 120]

import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const file = positional[0] ?? 'data/processing-times.json';
const previousFile = argValue('--previous');
const MAX_AGE_DAYS = Number(argValue('--max-age-days', 120));
const MIN_TIMES = Number(argValue('--min-times', 100));
const MAX_MONTHS = 120; // nothing USCIS publishes should exceed 10 years

const errors = [];
const warnings = [];

let data;
try {
  data = JSON.parse(await readFile(file, 'utf8'));
} catch (err) {
  console.error(`✗ Can't read ${file}: ${err.message}`);
  process.exit(1);
}

// ---------- provenance ----------

if (data.sample !== false) errors.push(`file is ${data.sample ? 'sample' : 'unlabelled'} data, not live USCIS data`);
if (data.source !== 'https://egov.uscis.gov/processing-times') errors.push(`unexpected source ${JSON.stringify(data.source)}`);
if (Number.isNaN(Date.parse(data.generatedAt))) errors.push('generatedAt is missing or invalid');

// ---------- structure ----------

const forms = new Map((data.forms ?? []).map((f) => [f.form, new Set((f.subtypes ?? []).map((s) => s.code))]));
const offices = data.offices ?? {};
const times = data.times ?? [];
if (times.length < MIN_TIMES) errors.push(`only ${times.length} processing times (expected at least ${MIN_TIMES})`);

const entryErrors = [];
const seen = new Set();
let missingPublication = 0;
for (const [i, t] of times.entries()) {
  const id = `${t.form}/${t.office}/${t.subtype}`;
  const bad = (msg) => entryErrors.push(`times[${i}] ${id}: ${msg}`);
  if (!forms.has(t.form)) bad('unknown form');
  else if (!forms.get(t.form).has(t.subtype)) bad('unknown category for this form');
  if (!offices[t.office]) bad('unknown office');
  if (seen.has(id)) bad('duplicate entry');
  seen.add(id);
  if (typeof t.months !== 'number' || !(t.months > 0) || t.months > MAX_MONTHS) bad(`implausible months ${t.months}`);
  if (t.lowMonths != null && !(t.lowMonths > 0 && t.lowMonths <= t.months)) bad(`low bound ${t.lowMonths} > ${t.months}`);
  if (!Array.isArray(t.raw) || !t.raw.length) bad('missing raw USCIS values');
  if (!t.publicationDate) missingPublication++;
}

if (entryErrors.length) {
  errors.push(...entryErrors.slice(0, 20));
  if (entryErrors.length > 20) errors.push(`… and ${entryErrors.length - 20} more problems with individual entries`);
}

// ---------- freshness ----------

if (missingPublication / Math.max(times.length, 1) > 0.1) {
  warnings.push(`${missingPublication} of ${times.length} entries have no USCIS publication date`);
}
if (data.publishedAt) {
  const ageDays = (Date.now() - Date.parse(data.publishedAt)) / 864e5;
  if (ageDays > MAX_AGE_DAYS) errors.push(`newest USCIS publication date is ${data.publishedAt} (${Math.round(ageDays)} days old)`);
} else {
  warnings.push('no USCIS publication date recorded');
}

const unmapped = Object.entries(offices).filter(([, o]) => o.lat == null);
if (unmapped.length) warnings.push(`${unmapped.length} office(s) have no map location: ${unmapped.map(([c, o]) => `${c} (${o.name})`).join(', ')}`);

// ---------- comparison with the previous release ----------
// A unit mix-up or parser bug tends to shift most numbers at once, while real
// USCIS updates move a minority of them.

if (previousFile) {
  try {
    const prev = JSON.parse(await readFile(previousFile, 'utf8'));
    if (!prev.sample) {
      const old = new Map(prev.times.map((t) => [`${t.form}/${t.office}/${t.subtype}`, t.months]));
      let shared = 0;
      let bigMoves = 0;
      for (const t of times) {
        const before = old.get(`${t.form}/${t.office}/${t.subtype}`);
        if (before == null) continue;
        shared++;
        if (Math.abs(t.months - before) / before > 0.5) bigMoves++;
      }
      if (shared >= 20 && bigMoves / shared > 0.3) {
        errors.push(`${bigMoves} of ${shared} times changed by more than 50% since the last release; check the parser before publishing`);
      }
      if (prev.times.length >= 100 && times.length < prev.times.length * 0.7) {
        errors.push(`entry count dropped from ${prev.times.length} to ${times.length}`);
      }
      console.log(`Compared with previous release: ${shared} shared entries, ${bigMoves} moved by more than 50%.`);
    }
  } catch (err) {
    warnings.push(`couldn't compare with previous release: ${err.message}`);
  }
}

// ---------- report ----------

for (const w of warnings) console.warn(`! ${w}`);
for (const e of errors) console.error(`✗ ${e}`);
if (errors.length) {
  console.error(`\n${file} failed validation with ${errors.length} error(s).`);
  process.exit(1);
}
console.log(`✓ ${file}: ${times.length} times, ${forms.size} forms, ${Object.keys(offices).length} offices, published ${data.publishedAt ?? 'unknown'}.`);
