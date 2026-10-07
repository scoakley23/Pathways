// Preloaded with `node --import` to replace fetch() with responses read from
// test/fixtures/api, so the fetcher can run end to end offline.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = process.env.USCIS_FIXTURES;

globalThis.fetch = async (url) => {
  const urlPath = decodeURIComponent(new URL(url).pathname.replace('/processing-times/api/', ''));
  try {
    const body = await readFile(path.join(DIR, `${urlPath.replace(/[^A-Za-z0-9-]+/g, '__')}.json`), 'utf8');
    return new Response(body, { status: 200 });
  } catch {
    return new Response('', { status: 404 });
  }
};
