#!/usr/bin/env node
// Downloads current USCIS processing times and writes data/processing-times.json
// for the map. USCIS publishes these at https://egov.uscis.gov/processing-times
// through an undocumented JSON API; its browser CORS rules mean the site can't
// call it directly, so this script runs on a schedule (see .github/workflows).
//
// Usage:
//   node scripts/fetch-processing-times.mjs                  # fetch live data
//   node scripts/fetch-processing-times.mjs --raw-dir raw    # also save every API response
//   node scripts/fetch-processing-times.mjs --forms I-485,N-400   # only some forms
//   node scripts/fetch-processing-times.mjs --sample         # fake data, written to a separate file
//   node scripts/fetch-processing-times.mjs --out file.json  # write somewhere else

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ParseError, buildOfficeMatcher, findArray, normalize, parseProcessingTime } from './lib/uscis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_FILE = path.join(ROOT, 'data', 'processing-times.json');
// Sample data never goes in the live file; the site only loads it with ?sample.
const SAMPLE_FILE = path.join(ROOT, 'data', 'sample-processing-times.json');
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
// Abort without writing if more than this share of office lookups fail.
const MAX_FAILURE_RATE = 0.1;

const args = process.argv.slice(2);
const argValue = (name) => {
  const a = args.find((x) => x === name || x.startsWith(`${name}=`));
  if (!a) return null;
  return a.includes('=') ? a.split('=').slice(1).join('=') : args[args.indexOf(a) + 1];
};
const SAMPLE = args.includes('--sample');
const RAW_DIR = argValue('--raw-dir') && path.resolve(argValue('--raw-dir'));
const ONLY_FORMS = argValue('--forms')?.split(',').map((s) => s.trim().toUpperCase()) ?? null;
const OUT_FILE = argValue('--out') ? path.resolve(argValue('--out')) : SAMPLE ? SAMPLE_FILE : LIVE_FILE;

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
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ParseError(`non-JSON response from ${url} (blocked or changed?): ${text.slice(0, 120)}`);
      }
      if (RAW_DIR) {
        await writeFile(path.join(RAW_DIR, `${urlPath.replace(/[^A-Za-z0-9-]+/g, '__')}.json`), text);
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (err instanceof ParseError) break;
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

// ---------- live fetch ----------

async function fetchLive(matchOffice) {
  const formsPayload = await getJson('forms');
  const formList = findArray(formsPayload, 'form_name', ['data', 'forms', 'forms']) ?? [];
  if (!formList.length) throw new ParseError('no forms returned from the USCIS API; has its format changed?');

  const forms = [];
  const offices = {};
  const times = [];
  const unmatched = new Set();
  const failures = [];
  let lookups = 0;

  const selected = formList.filter((f) => !ONLY_FORMS || ONLY_FORMS.includes(String(f.form_name).toUpperCase()));
  if (ONLY_FORMS && selected.length !== ONLY_FORMS.length) {
    const found = new Set(selected.map((f) => String(f.form_name).toUpperCase()));
    console.warn(`Not offered by USCIS: ${ONLY_FORMS.filter((f) => !found.has(f)).join(', ')}`);
  }

  for (const f of selected) {
    const formName = f.form_name;
    const typesPayload = await getJson(`formtypes/${formName}`);
    const subtypeList = findArray(typesPayload, 'form_type', ['data', 'form_types', 'subtypes']) ?? [];
    const subtypes = subtypeList.map((s) => ({
      code: s.form_type,
      description: s.form_type_description_en ?? s.form_type_description ?? s.form_type,
    }));
    forms.push({ form: formName, description: f.form_description_en ?? f.form_description ?? '', subtypes });

    const jobs = [];
    for (const st of subtypes) {
      const officesPayload = await getJson(`formoffices/${formName}/${st.code}`);
      const officeList = findArray(officesPayload, 'office_code', ['data', 'form_offices', 'offices']) ?? [];
      for (const o of officeList) {
        const code = o.office_code;
        if (!offices[code]) {
          const geo = matchOffice(code, o.office_description);
          if (!geo) unmatched.add(`${code}: ${o.office_description}`);
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

    lookups += jobs.length;
    const results = await mapLimit(jobs, CONCURRENCY, async (job) => {
      const where = `${formName}/${job.office}/${job.subtype}`;
      try {
        const payload = await getJson(`processingtime/${formName}/${job.office}/${job.subtype}`);
        if (!payload) throw new Error('404 Not Found');
        const entries = parseProcessingTime(payload);
        // Only keep the entry for the category we asked about; never guess.
        let entry = entries.find((e) => e.subtype === job.subtype);
        if (!entry && entries.length === 1 && entries[0].subtype == null) entry = entries[0];
        if (!entry) throw new ParseError(`response doesn't include category ${job.subtype}`);
        return { form: formName, ...entry, subtype: job.subtype, office: job.office };
      } catch (err) {
        failures.push(`${where}: ${err.message}`);
        return null;
      }
    });
    const ok = results.filter(Boolean);
    times.push(...ok);
    console.log(`${formName}: ${subtypes.length} categories, ${jobs.length} office lookups, ${ok.length} times`);
  }

  if (unmatched.size) {
    console.warn(`\n${unmatched.size} office(s) have no coordinates; add them to data/offices.json to map them:`);
    for (const u of unmatched) console.warn(`  ${u}`);
  }
  if (failures.length) {
    console.warn(`\n${failures.length} of ${lookups} lookups failed:`);
    for (const f of failures.slice(0, 50)) console.warn(`  ${f}`);
    if (failures.length > 50) console.warn(`  … and ${failures.length - 50} more`);
  }
  if (lookups && failures.length / lookups > MAX_FAILURE_RATE) {
    throw new Error(`${Math.round((failures.length / lookups) * 100)}% of lookups failed (limit ${MAX_FAILURE_RATE * 100}%)`);
  }
  return { forms, offices, times };
}

// ---------- sample data ----------

// Deterministic fake data for working on the site offline. Written only to
// data/sample-processing-times.json and flagged `sample: true`.
function buildSample(officeList) {
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
  const round = (n) => Math.round(n * 10) / 10;

  const offices = {};
  const times = [];
  for (const o of officeList) {
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
          display: `${months} months`, raw: [], publicationDate: null, receiptDate: null,
        });
      }
    }
  }
  return { forms: forms.map(({ where, base, ...f }) => f), offices, times };
}

// ---------- main ----------

const officeList = JSON.parse(await readFile(OFFICES_FILE, 'utf8'));
if (RAW_DIR) await mkdir(RAW_DIR, { recursive: true });

let result;
if (SAMPLE) {
  result = buildSample(officeList);
} else {
  try {
    result = await fetchLive(buildOfficeMatcher(officeList));
  } catch (err) {
    console.error(`\nFetch failed: ${err.message}`);
    console.error('Existing data file left unchanged.');
    process.exit(1);
  }
  if (!result.times.length) {
    console.error('USCIS returned no processing times; existing data file left unchanged.');
    process.exit(1);
  }
}

const publicationDates = result.times.map((t) => t.publicationDate).filter(Boolean).sort();

// Keep the old file (and its timestamp) when nothing changed, so the scheduled
// workflow only commits real updates.
const previous = await readFile(OUT_FILE, 'utf8').then(JSON.parse).catch(() => null);
const fingerprint = (d) => JSON.stringify([d.forms, d.offices, d.times]);
if (previous && fingerprint(previous) === fingerprint(result)) {
  console.log('\nNo changes since the last fetch.');
  process.exit(0);
}

const doc = {
  generatedAt: new Date().toISOString(),
  publishedAt: publicationDates.at(-1) ?? null,
  source: 'https://egov.uscis.gov/processing-times',
  sample: SAMPLE,
  ...result,
};
await writeFile(OUT_FILE, JSON.stringify(doc) + '\n');
console.log(`\nWrote ${result.times.length} processing times across ${Object.keys(result.offices).length} offices to ${path.relative(ROOT, OUT_FILE)}`);
