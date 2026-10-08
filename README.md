# Pathways: USCIS processing times, mapped

> The Pathways USA pre-launch website (app sign-ups) lives in [`website/`](website/README.md).

An interactive map of how long USCIS takes to process forms at each office, built from
the data published at <https://egov.uscis.gov/processing-times>.

- Pick a **form** (I-485, N-400, I-130, I-765, …), a **category**, and an **office type**.
- Each office is a dot colored by its processing time compared with the other offices (quintiles).
- Click a dot or a row in the ranked list to see **every form that office processes**.
- The URL updates as you click (`#form=N-400&office=BOS`), so any view can be shared.

## How it works

```
USCIS API ──(npm run fetch, on your computer)──▶ data/processing-times.json ──(git push)──▶ static site
```

The USCIS site is backed by an undocumented JSON API (`/processing-times/api/...`). It
doesn't allow cross-origin browser requests, so the page can't call it directly. Instead,
`scripts/fetch-processing-times.mjs` downloads every form, category, and office and
saves the results to `data/processing-times.json`, which the static page loads.

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The website (no build step; Leaflet loaded from a CDN) |
| `data/offices.json` | Office names and their coordinates, used to place them on the map |
| `data/processing-times.json` | Live dataset (created by the first successful fetch) |
| `data/sample-processing-times.json` | Made-up data for previewing the layout (`?sample`) |
| `scripts/fetch-processing-times.mjs` | Fetcher (Node 18+, no dependencies) |
| `scripts/lib/uscis.mjs` | Strict parsing of USCIS responses |
| `scripts/validate-data.mjs` | Checks run before data is published |
| `test/` | Parser tests, run against saved API responses |
| `.github/workflows/test.yml` | On every push: tests, then validates any committed data |
| `.github/workflows/update-data.yml` | Manual-only cloud fetch (currently blocked by USCIS, see below) |

## Updating the data

USCIS protects its site with a Cloudflare bot check that blocks requests from cloud
servers, including GitHub's, so the data is fetched on your own computer:

```bash
npm install                 # once; uses your installed Google Chrome
npm run fetch               # opens a browser window and downloads every form/office (several minutes)
npm run validate            # optional; the Test workflow also runs this when you push
git add data/processing-times.json
git commit -m "Update USCIS processing times"
git push                    # tests and validation run on GitHub, then Pages redeploys
```

If USCIS shows a "Just a moment..." or "verify you are human" check in the window,
complete it yourself; the script waits up to five minutes and then continues. It never
tries to get around the check. If you don't have Google Chrome, run
`npx playwright install chromium` once. USCIS updates its numbers roughly monthly, so
fetching once a month is enough. The site shows a warning once the data is over 60 days old.

## Running the site locally

```bash
npm start          # serves the site at http://localhost:8080
npm test           # parser tests
npm run sample     # regenerate the made-up sample data
node scripts/fetch-processing-times.mjs --headed --forms I-485,N-400   # fetch only some forms
```

Until real data has been fetched, the site says "No USCIS data yet". To preview the
layout, open it with `?sample` (e.g. `http://localhost:8080/?sample`).

## Making sure the numbers are real

Every number on the site should trace back to a USCIS response. These checks enforce that:

1. **Sample data is kept separate.** Made-up numbers live only in
   `data/sample-processing-times.json` and load only with `?sample`, which shows a
   "Sample data" banner. The validator rejects any file marked as sample data, so it can't be
   published as the real dataset.
2. **The parser fails instead of guessing.** Unknown time units, missing values, or a
   response without the requested category are errors, not defaults
   (`scripts/lib/uscis.mjs`). If more than 10% of lookups fail, the fetch aborts and the
   previous data stays up.
3. **Validation runs on every push** (`scripts/validate-data.mjs`, via the Test workflow). It checks that
   values are plausible (0–120 months), every entry references a real form, category and
   office, there are no duplicates, and USCIS's publication date isn't stale. It also
   compares against the previous release: if more than 30% of times move by more than
   50% at once, that looks like a parsing bug, not a USCIS update, and the publish is blocked.
4. **Raw responses are kept.** `npm run fetch` saves every USCIS response it used to `raw/`
   (not committed). Each published entry also keeps USCIS's exact values (`raw`), and the
   site shows them next to the rounded number.
5. **Provenance is shown on the page.** The footer shows USCIS's publication date, a banner
   warns if it's more than 60 days old, and each office panel links to USCIS to check.

### First-run checklist

The USCIS API is undocumented, and the test fixtures in `test/fixtures/api` are
hand-written in the expected format. After the first `npm run fetch`:

1. Pick 5–10 entries across different forms and office types, look each one up on
   <https://egov.uscis.gov/processing-times>, and confirm the numbers match.
2. Replace the fixtures with real responses from `raw/` (see `test/fixtures/README.md`) so
   the tests cover the real format from then on.

## Caveats

- The USCIS API is undocumented and may change format. If it does, the strict parser makes
  `npm run fetch` fail instead of writing bad data, and the site keeps the last good data
  (with a staleness banner once it's more than 60 days old).
- USCIS times describe how long it took to complete 80% of cases. They aren't a
  guarantee for any individual case, and this site isn't legal advice.
