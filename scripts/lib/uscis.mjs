// Parsing for the USCIS processing-times API. Kept free of I/O so it can be
// unit-tested against saved responses (see test/).
//
// Numbers are parsed strictly: anything that doesn't look exactly like a
// processing time is rejected with a ParseError rather than guessed at, so a
// change in the USCIS format fails the update instead of publishing bad data.

export class ParseError extends Error {}

export const normalize = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmount\b/g, 'mt')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const UNIT_TO_MONTHS = { month: 1, week: 12 / 52, day: 12 / 365, year: 12 };

export function toMonths(value, unit) {
  const v = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ParseError(`invalid processing-time value ${JSON.stringify(value)}`);
  }
  const u = String(unit ?? '').toLowerCase().trim().replace(/s$/, '');
  if (!(u in UNIT_TO_MONTHS)) throw new ParseError(`unknown time unit ${JSON.stringify(unit)}`);
  return v * UNIT_TO_MONTHS[u];
}

const round = (n) => Math.round(n * 10) / 10;

// A USCIS "range" is a list of {value, unit}. Older data has two bounds,
// newer data a single value (the time in which 80% of cases were completed).
export function parseRange(range) {
  if (!Array.isArray(range) || range.length === 0) throw new ParseError('missing or empty range');
  const parts = range.map((r) => {
    const unit = r?.unit ?? r?.unit_en;
    return { value: Number(r?.value), unit, months: toMonths(r?.value, unit) };
  });
  parts.sort((a, b) => a.months - b.months);
  const lo = parts[0];
  const hi = parts[parts.length - 1];
  const fmt = (p) => `${p.value} ${String(p.unit).toLowerCase()}`;
  const isRange = parts.length > 1 && lo.months !== hi.months;
  return {
    months: round(hi.months),
    lowMonths: isRange ? round(lo.months) : null,
    display: isRange ? `${fmt(lo)} – ${fmt(hi)}` : fmt(hi),
    raw: parts.map(({ value, unit }) => ({ value, unit })),
  };
}

// Parses a /processingtime/{form}/{office}[/{subtype}] response into one entry
// per form category.
export function parseProcessingTime(payload) {
  const pt = payload?.data?.processing_time;
  if (!pt || typeof pt !== 'object') throw new ParseError('response has no data.processing_time');
  const entries = Array.isArray(pt.subtypes) && pt.subtypes.length ? pt.subtypes : pt.range ? [pt] : [];
  if (!entries.length) throw new ParseError('data.processing_time has no subtypes or range');
  return entries.map((s) => ({
    subtype: s.form_type ?? null,
    ...parseRange(s.range),
    publicationDate: parseDate(s.publication_date ?? pt.publication_date),
    receiptDate: parseDate(s.service_request_date ?? s.service_request_date_en),
  }));
}

// USCIS dates appear as "September 15, 2026" or ISO strings. Returns YYYY-MM-DD.
export function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Listing endpoints (forms, categories, offices) nest their arrays a few
// levels deep; look up the documented path first, then search for an array of
// objects carrying `key`. These are only names, never the numbers we publish.
export function findArray(obj, key, knownPath = []) {
  let known = obj;
  for (const k of knownPath) known = known?.[k];
  if (Array.isArray(known)) return known;
  return searchArray(obj, key);
}

function searchArray(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (obj.some((x) => x && typeof x === 'object' && key in x)) return obj;
    for (const x of obj) {
      const r = searchArray(x, key);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(obj)) {
    const r = searchArray(v, key);
    if (r) return r;
  }
  return null;
}

export function buildOfficeMatcher(offices) {
  const index = new Map();
  for (const o of offices) {
    for (const key of [o.name, ...(o.aliases ?? [])]) index.set(normalize(key), o);
  }
  return (code, description) => {
    for (const c of [description, code, String(description ?? '').replace(/\s*\(.*\)\s*$/, '')]) {
      const hit = index.get(normalize(c));
      if (hit) return hit;
    }
    // "City ST" prefix, e.g. "Boston MA Field Office".
    const n = normalize(description);
    for (const [key, o] of index) if (key.length > 4 && n.startsWith(key + ' ')) return o;
    return null;
  };
}
