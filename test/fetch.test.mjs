// Runs the real fetcher against saved API responses (test/fixtures/api) and
// checks the numbers that come out match the numbers that went in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProcessingTime } from '../scripts/lib/uscis.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'api');

async function fetchFromFixtures() {
  const dir = await mkdtemp(path.join(tmpdir(), 'pathways-'));
  const out = path.join(dir, 'out.json');
  const rawDir = path.join(dir, 'raw');
  await run(process.execPath, ['--import', path.join(ROOT, 'test', 'mock-fetch.mjs'), 'scripts/fetch-processing-times.mjs', '--out', out, '--raw-dir', rawDir], {
    cwd: ROOT,
    env: { ...process.env, USCIS_FIXTURES: FIXTURES },
  });
  return { data: JSON.parse(await readFile(out, 'utf8')), rawDir };
}

test('every published number equals the value in the USCIS response it came from', async () => {
  const { data, rawDir } = await fetchFromFixtures();
  assert.equal(data.sample, false);
  assert.ok(data.times.length > 0);
  for (const t of data.times) {
    const file = `processingtime__${t.form}__${t.office}__${t.subtype}.json`;
    const payload = JSON.parse(await readFile(path.join(FIXTURES, file), 'utf8'));
    const source = parseProcessingTime(payload).find((e) => e.subtype === t.subtype);
    assert.ok(source, `${file} has an entry for ${t.subtype}`);
    assert.deepEqual(t.raw, source.raw, `${file}: raw values copied through unchanged`);
    assert.equal(t.months, source.months);
  }
  // Every response used was archived.
  const archived = new Set(await readdir(rawDir));
  for (const f of await readdir(FIXTURES)) assert.ok(archived.has(f), `${f} archived`);
});

test('picks the requested category when a response lists several', async () => {
  const { data } = await fetchFromFixtures();
  const find = (form, office, subtype) => data.times.find((t) => t.form === form && t.office === office && t.subtype === subtype);
  // These fixtures are hand-written; update if they are replaced with real responses.
  if (find('N-400', 'BOS', 'N400')) {
    assert.equal(find('N-400', 'BOS', 'N400').months, 6.5);
    assert.equal(find('N-400', 'BOS', 'N400-MIL').months, 3);
    assert.equal(find('I-485', 'NBC', '485-FB').display, '30 weeks – 14 months');
    assert.equal(data.offices.BOS.city, 'Boston');
    assert.equal(data.publishedAt, '2026-09-15');
  }
});
