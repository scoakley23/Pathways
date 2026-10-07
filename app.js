/* global L */
'use strict';

const COLORS = ['--q1', '--q2', '--q3', '--q4', '--q5'].map((v) =>
  getComputedStyle(document.documentElement).getPropertyValue(v).trim()
);
const NONE_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--none').trim();
const DARK = window.matchMedia('(prefers-color-scheme: dark)').matches;
const USCIS_URL = 'https://egov.uscis.gov/processing-times/';
// Sample (made-up) data is only ever loaded when the URL has ?sample.
const SAMPLE_MODE = new URLSearchParams(location.search).has('sample');
const STALE_AFTER_DAYS = 60;
const TYPE_LABELS = { field: 'Field office', service: 'Service center', asylum: 'Asylum office', other: 'Office' };

const $ = (id) => document.getElementById(id);
const els = {
  form: $('form-select'),
  subtype: $('subtype-select'),
  type: $('type-select'),
  search: $('search'),
  list: $('office-list'),
  summary: $('summary'),
  detail: $('detail'),
  legend: $('legend'),
  banner: $('banner'),
  updated: $('updated'),
  unmapped: $('unmapped-note'),
};

const state = { form: null, subtype: null, type: 'all', office: null, query: '' };
let data;
let map;
let markerLayer;
const markers = new Map();

// ---------- helpers ----------

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

const fmtMonths = (m) => (m == null ? '—' : `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)} mo`);

const officeLabel = (o) => (o.city && o.state && !o.name.includes(o.state) ? `${o.name} (${o.city}, ${o.state})` : o.name);

function quantileBreaks(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return [];
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return [q(0.2), q(0.4), q(0.6), q(0.8)];
}

function colorFor(months, breaks) {
  if (months == null) return NONE_COLOR;
  let i = 0;
  while (i < breaks.length && months > breaks[i]) i++;
  return COLORS[i];
}

// ---------- state <-> URL ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { form: p.get('form'), subtype: p.get('category'), type: p.get('type'), office: p.get('office') };
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.form) p.set('form', state.form);
  if (state.subtype) p.set('category', state.subtype);
  if (state.type !== 'all') p.set('type', state.type);
  if (state.office) p.set('office', state.office);
  history.replaceState(null, '', `#${p}`);
}

// ---------- data selection ----------

function currentForm() {
  return data.forms.find((f) => f.form === state.form);
}

function currentSubtype() {
  return currentForm()?.subtypes.find((s) => s.code === state.subtype);
}

function currentRows() {
  return data.times
    .filter((t) => t.form === state.form && t.subtype === state.subtype)
    .map((t) => ({ ...t, office: t.office, info: data.offices[t.office] }))
    .filter((r) => r.info && (state.type === 'all' || r.info.type === state.type))
    .sort((a, b) => a.months - b.months);
}

// ---------- rendering ----------

function populateForms() {
  const formsWithData = new Set(data.times.map((t) => t.form));
  const forms = data.forms.filter((f) => formsWithData.has(f.form));
  els.form.innerHTML = forms
    .map((f) => `<option value="${escapeHtml(f.form)}">${escapeHtml(f.form)} — ${escapeHtml(f.description)}</option>`)
    .join('');
  if (!forms.some((f) => f.form === state.form)) {
    state.form = (forms.find((f) => f.form === 'I-485') ?? forms[0])?.form ?? null;
  }
  els.form.value = state.form;
}

function populateSubtypes() {
  const withData = new Set(data.times.filter((t) => t.form === state.form).map((t) => t.subtype));
  const subtypes = (currentForm()?.subtypes ?? []).filter((s) => withData.has(s.code));
  els.subtype.innerHTML = subtypes
    .map((s) => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.description)}</option>`)
    .join('');
  if (!subtypes.some((s) => s.code === state.subtype)) state.subtype = subtypes[0]?.code ?? null;
  els.subtype.value = state.subtype;
  els.subtype.disabled = subtypes.length <= 1;
}

function renderLegend(breaks) {
  if (!breaks.length) {
    els.legend.innerHTML = '<h3>No data</h3>';
    return;
  }
  const labels = [
    `≤ ${fmtMonths(breaks[0])}`,
    `${fmtMonths(breaks[0])} – ${fmtMonths(breaks[1])}`,
    `${fmtMonths(breaks[1])} – ${fmtMonths(breaks[2])}`,
    `${fmtMonths(breaks[2])} – ${fmtMonths(breaks[3])}`,
    `> ${fmtMonths(breaks[3])}`,
  ];
  els.legend.innerHTML =
    '<h3>Processing time</h3>' +
    labels
      .map((l, i) => `<div class="legend-row"><span class="swatch" style="background:${COLORS[i]}"></span>${l}</div>`)
      .join('');
}

function renderSummary(rows) {
  const form = currentForm();
  const sub = currentSubtype();
  if (!rows.length) {
    els.summary.innerHTML = `<h2>${escapeHtml(form?.form ?? '')}</h2><p class="muted">No offices of this type process this category.</p>`;
    return;
  }
  const months = rows.map((r) => r.months);
  const median = [...months].sort((a, b) => a - b)[Math.floor(months.length / 2)];
  const fastest = rows[0];
  const slowest = rows[rows.length - 1];
  els.summary.innerHTML = `
    <h2>${escapeHtml(form.form)} · ${escapeHtml(form.description)}</h2>
    <p class="muted small">${escapeHtml(sub?.description ?? '')}</p>
    <div class="stats">
      <div class="stat"><div class="label">Fastest</div><div class="value">${fmtMonths(fastest.months)}</div><div class="where" title="${escapeHtml(fastest.info.name)}">${escapeHtml(fastest.info.name)}</div></div>
      <div class="stat"><div class="label">Median</div><div class="value">${fmtMonths(median)}</div><div class="where">${rows.length} office${rows.length === 1 ? '' : 's'}</div></div>
      <div class="stat"><div class="label">Slowest</div><div class="value">${fmtMonths(slowest.months)}</div><div class="where" title="${escapeHtml(slowest.info.name)}">${escapeHtml(slowest.info.name)}</div></div>
    </div>`;
}

function renderList(rows, breaks) {
  const q = state.query.toLowerCase();
  const max = Math.max(...rows.map((r) => r.months), 1);
  const visible = rows
    .map((r, i) => ({ ...r, rank: i + 1 }))
    .filter((r) => !q || [r.info.name, r.info.city, r.info.state].some((s) => s && s.toLowerCase().includes(q)));
  els.list.innerHTML = visible
    .map((r) => {
      const color = colorFor(r.months, breaks);
      return `<li><button type="button" data-office="${escapeHtml(r.office)}" aria-current="${r.office === state.office}">
        <span class="rank">${r.rank}</span>
        <span class="swatch" style="background:${color}"></span>
        <span><span class="name">${escapeHtml(r.info.name)}</span>
          <div class="bar"><span style="width:${(r.months / max) * 100}%;background:${color}"></span></div></span>
        <span class="time">${fmtMonths(r.months)}</span>
      </button></li>`;
    })
    .join('') || '<li class="muted small">No matching offices.</li>';

  const unmapped = rows.filter((r) => r.info.lat == null);
  els.unmapped.hidden = !unmapped.length;
  els.unmapped.textContent = unmapped.length
    ? `${unmapped.length} office(s) aren't on the map because their location is unknown: ${unmapped.map((r) => r.info.name).join(', ')}.`
    : '';
}

function renderMarkers(rows, breaks) {
  markerLayer.clearLayers();
  markers.clear();
  for (const r of rows) {
    if (r.info.lat == null) continue;
    const selected = r.office === state.office;
    const m = L.circleMarker([r.info.lat, r.info.lng], {
      radius: selected ? 11 : 8,
      weight: selected ? 3 : 1.5,
      color: selected ? (DARK ? '#fff' : '#111') : DARK ? '#0f141a' : '#ffffff',
      fillColor: colorFor(r.months, breaks),
      fillOpacity: 0.92,
      bubblingMouseEvents: false,
    });
    m.bindTooltip(`<strong>${escapeHtml(r.info.name)}</strong><br>${escapeHtml(r.display ?? fmtMonths(r.months))}`, {
      direction: 'top',
      offset: [0, -6],
    });
    m.on('click', () => selectOffice(r.office, { pan: false }));
    m.addTo(markerLayer);
    markers.set(r.office, m);
  }
  markers.get(state.office)?.bringToFront();
}

function renderDetail() {
  const info = state.office && data.offices[state.office];
  if (!info) {
    els.detail.hidden = true;
    return;
  }
  const rows = data.times
    .filter((t) => t.office === state.office)
    .sort((a, b) => a.form.localeCompare(b.form, undefined, { numeric: true }) || a.months - b.months);
  const describe = (t) => {
    const f = data.forms.find((x) => x.form === t.form);
    return f?.subtypes.find((s) => s.code === t.subtype)?.description ?? t.subtype;
  };
  els.detail.hidden = false;
  els.detail.innerHTML = `
    <button class="close-btn" type="button" aria-label="Close office details">×</button>
    <h2>${escapeHtml(info.name)}</h2>
    <p class="muted small">${escapeHtml(TYPE_LABELS[info.type] ?? 'Office')}${info.city ? ` · ${escapeHtml(info.city)}, ${escapeHtml(info.state)}` : ''}</p>
    <table class="detail-table"><tbody>
      ${rows
        .map(
          (t) => `<tr class="${t.form === state.form && t.subtype === state.subtype ? 'current' : ''}">
            <td><a href="#" data-form="${escapeHtml(t.form)}" data-subtype="${escapeHtml(t.subtype)}">${escapeHtml(t.form)}</a><br><span class="muted">${escapeHtml(describe(t))}</span></td>
            <td>${fmtMonths(t.months)}${t.display ? `<br><span class="muted small">USCIS: ${escapeHtml(t.display)}</span>` : ''}</td></tr>`
        )
        .join('')}
    </tbody></table>
    <p class="small"><a href="${USCIS_URL}" target="_blank" rel="noopener">Check these numbers on USCIS ↗</a></p>`;
}

function render() {
  const rows = currentRows();
  const breaks = quantileBreaks(rows.map((r) => r.months));
  renderLegend(breaks);
  renderSummary(rows);
  renderList(rows, breaks);
  renderMarkers(rows, breaks);
  renderDetail();
  writeHash();
}

// ---------- interactions ----------

function selectOffice(code, { pan = true } = {}) {
  state.office = state.office === code && !pan ? null : code;
  render();
  const info = state.office && data.offices[state.office];
  if (pan && info?.lat != null) map.flyTo([info.lat, info.lng], Math.max(map.getZoom(), 6), { duration: 0.6 });
  if (state.office && window.matchMedia('(max-width: 900px)').matches) {
    els.detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function bindEvents() {
  els.form.addEventListener('change', () => {
    state.form = els.form.value;
    populateSubtypes();
    render();
  });
  els.subtype.addEventListener('change', () => {
    state.subtype = els.subtype.value;
    render();
  });
  els.type.addEventListener('change', () => {
    state.type = els.type.value;
    render();
  });
  els.search.addEventListener('input', () => {
    state.query = els.search.value.trim();
    render();
  });
  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-office]');
    if (btn) selectOffice(btn.dataset.office);
  });
  els.detail.addEventListener('click', (e) => {
    if (e.target.closest('.close-btn')) {
      state.office = null;
      render();
      return;
    }
    const link = e.target.closest('a[data-form]');
    if (link) {
      e.preventDefault();
      state.form = link.dataset.form;
      els.form.value = state.form;
      populateSubtypes();
      state.subtype = link.dataset.subtype;
      els.subtype.value = state.subtype;
      render();
    }
  });
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h.form === state.form && h.subtype === state.subtype && h.office === state.office && (h.type ?? 'all') === state.type) return;
    applyHash(h);
    render();
  });
}

function applyHash(h) {
  if (h.form) state.form = h.form;
  if (h.type && ['all', 'field', 'service', 'asylum'].includes(h.type)) state.type = h.type;
  els.type.value = state.type;
  populateForms();
  if (h.subtype) state.subtype = h.subtype;
  populateSubtypes();
  state.office = h.office && data.offices[h.office] ? h.office : null;
}

function initMap() {
  map = L.map('map', { zoomSnap: 0.5, worldCopyJump: true }).setView([38.5, -96], 4);
  const style = DARK ? 'dark_all' : 'light_all';
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 18,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on('click', () => {
    if (state.office) {
      state.office = null;
      render();
    }
  });
}

async function loadData() {
  const file = SAMPLE_MODE ? 'data/sample-processing-times.json' : 'data/processing-times.json';
  const res = await fetch(file, { cache: 'no-cache' });
  if (res.status === 404 && !SAMPLE_MODE) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${file}`);
  return res.json();
}

function showBanner(html) {
  els.banner.innerHTML = html;
  els.banner.hidden = false;
}

async function main() {
  try {
    data = await loadData();
  } catch (err) {
    els.summary.innerHTML = `<h2>Couldn't load data</h2><p class="muted">${escapeHtml(err.message)}. If you opened this file directly, serve the folder instead (for example <code>npm start</code>).</p>`;
    return;
  }

  initMap();
  if (!data) {
    // Never fall back to made-up numbers: show nothing until real data exists.
    for (const el of [els.form, els.subtype, els.type, els.search]) el.disabled = true;
    els.legend.hidden = true;
    els.summary.innerHTML = `<h2>No USCIS data yet</h2>
      <p class="muted">Processing times appear here after the first successful run of the
      “Update processing times” workflow. Until then, see <a href="${USCIS_URL}" target="_blank" rel="noopener">USCIS</a>
      or preview the layout with <a href="?sample">sample data</a>.</p>`;
    return;
  }

  if (data.sample) {
    showBanner('<strong>Sample data:</strong> these numbers are made up for testing and are not from USCIS. <a href="./">View live data</a>');
  } else if (data.publishedAt && (Date.now() - Date.parse(data.publishedAt)) / 864e5 > STALE_AFTER_DAYS) {
    showBanner(`These times were published by USCIS on ${fmtDate(data.publishedAt)} and may be out of date. <a href="${USCIS_URL}" target="_blank" rel="noopener">Check current times on USCIS ↗</a>`);
  }
  els.updated.textContent = [
    data.publishedAt && `USCIS published ${fmtDate(data.publishedAt)}`,
    `checked ${fmtDate(data.generatedAt)}`,
  ].filter(Boolean).join(' · ') + ' · ';

  applyHash(readHash());
  bindEvents();
  render();
}

main();
