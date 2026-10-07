#!/usr/bin/env node
// Downloads current USCIS processing times and writes data/processing-times.json
// for the map. USCIS publishes these at https://egov.uscis.gov/processing-times
// through an undocumented JSON API; its browser CORS rules mean the site can't
// call it directly, so this script runs on a schedule (see .github/workflows).
//
// Usage:
//   node scripts/fetch-processing-times.mjs            # fetch live data
//   node scripts/fetch-processing-times.mjs --sample   # write clearly-labelled fake data
//   node scripts/fetch-processing-times.mjs --forms I-485,N-400   # only some forms

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'data', 'processing-times.json');
const OFFICES_FILE = path.join(ROOT, 'data', 'offices.json');

const API = 'https://egov.uscis.gov/processing-times/api';
const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://egov.uscis.gov/processing-times/',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
const CONCURRENCY = 4;
const RETRIES = 3;

const args = process.argv.slice(2);
const SAMPLE = args.includes('--sample');
const formsArg = args.find((a) => a.startsWith('--forms'));
const ONLY_FORMS = formsArg
  ? (formsArg.includes('=') ? formsArg.split('=')[1] : args[args.indexOf(formsArg) + 1])
      .split(',')
      .map((s) => s.trim().toUpperCase())
  : null;

// ---------- office matching ----------

const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmount\b/g, 'mt')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

async function loadOfficeIndex() {
  const offices = JSON.parse(await readFile(OFFICES_FILE, 'utf8'));
  const index = new Map();
  for (const o of offices) {
    for (const key of [o.name, ...(o.aliases ?? [])]) index.set(normalize(key), o);
  }
  return {
    offices,
    match(code, description) {
      const candidates = [description, code, String(description ?? '').replace(/\s*\(.*\)\s*$/, '')];
      for (const c of candidates) {
        const hit = index.get(normalize(c));
        if (hit) return hit;
      }
      // Fall back to "City ST" prefix matching, e.g. "Boston MA Field Office".
      const n = normalize(description);
      for (const [key, o] of index) if (key.length > 4 && n.startsWith(key)) return o;
      return null;
    },
  };
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(urlPath) {
  const url = `${API}/${urlPath.split('/').map(encodeURIComponent).join('/')}`;
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// The USCIS payloads nest their arrays a few levels deep and have changed
// shape over time, so find the first array whose objects carry a given key.
function findArray(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.some((x) => x && typeof x === 'object' && key in x)) return obj;
    for (const x of obj) {
      const r = findArray(x, key);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(obj)) {
    const r = findArray(v, key);
    if (r) return r;
  }
  return null;
}

// ---------- parsing ----------

const UNIT_TO_MONTHS = { month: 1, week: 12 / 52, day: 12 / 365, year: 12 };

function toMonths(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const u = String(unit ?? 'months').toLowerCase().replace(/s$/, '');
  return v * (UNIT_TO_MONTHS[u] ?? 1);
}

function parseRange(range) {
  if (!Array.isArray(range) || !range.length) return null;
  const parts = range
    .map((r) => ({ value: Number(r.value), unit: r.unit ?? r.unit_en ?? 'Months', months: toMonths(r.value, r.unit ?? r.unit_en) }))
    .filter((r) => r.months != null && r.months > 0);
  if (!parts.length) return null;
  parts.sort((a, b) => a.months - b.months);
  const hi = parts[parts.length - 1];
  const lo = parts[0];
  return {
    months: round(hi.months),
    lowMonths: lo !== hi ? round(lo.months) : null,
    display: lo !== hi ? `${fmt(lo)} – ${fmt(hi)}` : fmt(hi),
  };
}

const round = (n) => Math.round(n * 10) / 10;
const fmt = (p) => `${p.value} ${p.unit.toLowerCase()}`;

function parseProcessingTime(payload, requestedSubtype) {
  const pt = payload?.data?.processing_time ?? payload?.processing_time ?? payload;
  const out = [];
  const subtypes = findArray(pt, 'range');
  const entries = subtypes ?? (pt?.range ? [pt] : []);
  for (const s of entries) {
    const range = parseRange(s.range);
    if (!range) continue;
    out.push({
      subtype: s.form_type ?? s.subtype ?? requestedSubtype ?? null,
      ...range,
      publicationDate: s.publication_date ?? pt?.publication_date ?? null,
      receiptDate: s.service_request_date ?? s.service_request_date_en ?? null,
    });
  }
  return out;
}

// ---------- live fetch ----------

async function fetchLive(officeIndex) {
  const formsPayload = await getJson('forms');
  const formList = findArray(formsPayload, 'form_name') ?? [];
  if (!formList.length) throw new Error('No forms returned from USCIS API — has its shape changed?');

  const forms = [];
  const offices = {};
  const times = [];
  const unmatched = new Set();

  const selected = formList.filter((f) => !ONLY_FORMS || ONLY_FORMS.includes(String(f.form_name).toUpperCase()));
  for (const f of selected) {
    const formName = f.form_name;
    const typesPayload = await getJson(`formtypes/${formName}`);
    const subtypeList = findArray(typesPayload, 'form_type') ?? [];
    const subtypes = subtypeList.map((s) => ({
      code: s.form_type,
      description: s.form_type_description_en ?? s.form_type_description ?? s.form_type,
    }));
    forms.push({ form: formName, description: f.form_description_en ?? f.form_description ?? '', subtypes });

    // Collect the offices for every subtype, then ask each one for its times.
    const jobs = [];
    for (const st of subtypes) {
      const officesPayload = await getJson(`formoffices/${formName}/${st.code}`);
      const officeList = findArray(officesPayload, 'office_code') ?? [];
      for (const o of officeList) {
        const code = o.office_code;
        if (!offices[code]) {
          const geo = officeIndex.match(code, o.office_description);
          if (!geo) unmatched.add(`${code} — ${o.office_description}`);
          offices[code] = {
            name: o.office_description ?? code,
            type: geo?.type ?? 'other',
            city: geo?.city ?? null,
            state: geo?.state ?? null,
            lat: geo?.lat ?? null,
            lng: geo?.lng ?? null,
          };
        }
        jobs.push({ subtype: st.code, office: code });
      }
    }

    const results = await mapLimit(jobs, CONCURRENCY, async (job) => {
      try {
        const payload = await getJson(`processingtime/${formName}/${job.office}/${job.subtype}`);
        return parseProcessingTime(payload, job.subtype)
          .filter((t) => !t.subtype || t.subtype === job.subtype)
          .map((t) => ({ ...t, subtype: job.subtype, office: job.office }));
      } catch (err) {
        console.warn(`  ! ${formName}/${job.office}/${job.subtype}: ${err.message}`);
        return [];
      }
    });
    const before = times.length;
    for (const r of results) for (const t of r) times.push({ form: formName, ...t });
    console.log(`${formName}: ${subtypes.length} categories, ${jobs.length} office lookups, ${times.length - before} times`);
  }

  if (unmatched.size) {
    console.warn(`\n${unmatched.size} office(s) have no coordinates; add them to data/offices.json to map them:`);
    for (const u of unmatched) console.warn(`  ${u}`);
  }
  return { forms, offices, times };
}

// ---------- sample data ----------

// Deterministic fake data so the site can be developed without network access.
// The output is flagged `sample: true` and the UI shows a banner for it.
function buildSample(officeIndex) {
  const forms = [
    { form: 'I-485', description: 'Application to Register Permanent Residence or Adjust Status', subtypes: [
      { code: 'FB', description: 'Family-based adjustment applications' },
      { code: 'EB', description: 'Employment-based adjustment applications' } ], where: ['field', 'NBC'], base: 11 },
    { form: 'N-400', description: 'Application for Naturalization', subtypes: [
      { code: 'N400', description: 'Application for naturalization' } ], where: ['field'], base: 6 },
    { form: 'I-130', description: 'Petition for Alien Relative', subtypes: [
      { code: 'SPOUSE-USC', description: 'Permanent resident filing for a spouse or child under 21' },
      { code: 'PARENT-USC', description: 'U.S. citizen filing for a parent, unmarried son or daughter under 21' } ], where: ['service', 'field'], base: 14 },
    { form: 'I-765', description: 'Application for Employment Authorization', subtypes: [
      { code: 'C09', description: 'Based on a pending asylum application [(c)(8)] or adjustment [(c)(9)]' },
      { code: 'ALL', description: 'All other applications for employment authorization' } ], where: ['service', 'NBC'], base: 4 },
    { form: 'I-131', description: 'Application for Travel Document', subtypes: [
      { code: 'AP', description: 'Advance parole document' } ], where: ['service', 'NBC'], base: 7 },
    { form: 'I-751', description: 'Petition to Remove Conditions on Residence', subtypes: [
      { code: 'I751', description: 'Removal of lawful permanent resident conditions (spouse of U.S. citizen or LPR)' } ], where: ['service'], base: 22 },
    { form: 'I-90', description: 'Application to Replace Permanent Resident Card', subtypes: [
      { code: 'I90', description: 'Application to replace permanent resident card' } ], where: ['service', 'NBC'], base: 9 },
    { form: 'I-589', description: 'Application for Asylum and for Withholding of Removal', subtypes: [
      { code: 'AFF', description: 'Affirmative asylum application' } ], where: ['asylum'], base: 30 },
  ];

  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);

  const offices = {};
  const times = [];
  for (const o of officeIndex.offices) {
    const code = o.aliases.find((a) => /^[A-Z]{3,4}$/.test(a)) ?? normalize(o.name).replace(/ /g, '-').toUpperCase();
    offices[code] = { name: o.name, type: o.type, city: o.city, state: o.state, lat: o.lat, lng: o.lng };
    for (const f of forms) {
      const isCenter = o.type !== 'service' || ['CSC', 'NSC', 'TSC', 'VSC', 'PSC'].includes(code);
      const handles = (f.where.includes(o.type) && isCenter) || f.where.includes(code);
      if (!handles) continue;
      for (const st of f.subtypes) {
        const months = round(Math.max(0.5, f.base * (0.45 + rand() * 1.3)));
        times.push({
          form: f.form, subtype: st.code, office: code, months, lowMonths: null,
          display: `${months} months`, publicationDate: null, receiptDate: null,
        });
      }
    }
  }
  return { forms: forms.map(({ where, base, ...f }) => f), offices, times };
}

// ---------- main ----------

const officeIndex = await loadOfficeIndex();
let result;
if (SAMPLE) {
  result = buildSample(officeIndex);
} else {
  try {
    result = await fetchLive(officeIndex);
  } catch (err) {
    console.error(`Fetch failed: ${err.message}`);
    console.error('Existing data file left unchanged.');
    process.exit(1);
  }
  if (!result.times.length) {
    console.error('USCIS returned no processing times; existing data file left unchanged.');
    process.exit(1);
  }
}

// Keep the old file (and its timestamp) when nothing changed, so the scheduled
// workflow only commits real updates.
const previous = await readFile(OUT_FILE, 'utf8').then(JSON.parse).catch(() => null);
const fingerprint = (d) => JSON.stringify([d.sample ?? SAMPLE, d.forms, d.offices, d.times]);
if (previous && fingerprint(previous) === fingerprint({ ...result, sample: SAMPLE })) {
  console.log('\nNo changes since the last fetch.');
  process.exit(0);
}

const doc = {
  generatedAt: new Date().toISOString(),
  source: 'https://egov.uscis.gov/processing-times',
  sample: SAMPLE,
  ...result,
};
await writeFile(OUT_FILE, JSON.stringify(doc) + '\n');
console.log(`\nWrote ${result.times.length} processing times across ${Object.keys(result.offices).length} offices to ${path.relative(ROOT, OUT_FILE)}`);
