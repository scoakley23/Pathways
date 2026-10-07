# Pathways: USCIS processing times, mapped

An interactive map of how long USCIS takes to process forms at each office, built from
the data published at <https://egov.uscis.gov/processing-times>.

- Pick a **form** (I-485, N-400, I-130, I-765, …), a **category**, and an **office type**.
- Each office is a dot colored by its processing time compared with the other offices (quintiles).
- Click a dot or a row in the ranked list to see **every form that office processes**.
- The URL updates as you click (`#form=N-400&office=BOS`), so any view can be shared.

## How it works

```
USCIS API ──(GitHub Action, daily)──▶ data/processing-times.json ──▶ static site (Leaflet map)
```

The USCIS site is backed by an undocumented JSON API (`/processing-times/api/...`). It
doesn't allow cross-origin browser requests, so the page can't call it directly. Instead,
`scripts/fetch-processing-times.mjs` downloads every form, category, and office and
saves the results to `data/processing-times.json`, which the static page loads.

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The website (no build step; Leaflet loaded from a CDN) |
| `data/offices.json` | Office names and their coordinates, used to place them on the map |
| `data/processing-times.json` | The generated dataset |
| `scripts/fetch-processing-times.mjs` | Fetcher (Node 18+, no dependencies) |
| `.github/workflows/update-data.yml` | Daily job that runs the fetcher and commits changes |

## Running locally

```bash
npm start          # serves the site at http://localhost:8080
npm run fetch      # pull live data from USCIS (takes a few minutes)
npm run sample     # write labelled sample data (no network needed)
node scripts/fetch-processing-times.mjs --forms I-485,N-400   # fetch only some forms
```

The repo currently ships with **sample data** so the site works out of the box. The page
shows a yellow banner until real data has been fetched.

## Deploying

1. Push to GitHub and enable **Settings → Pages → Deploy from branch** (root of the default branch).
2. Under **Actions**, run **Update processing times** once by hand. After that it runs daily
   and only commits when USCIS has published new numbers.

If the fetcher reports offices without coordinates, add them to `data/offices.json`
(`name` must match the USCIS office name, or list it under `aliases`).

## Caveats

- The USCIS API is undocumented and may change shape or block automated traffic. The
  fetcher parses it defensively and leaves the existing data file unchanged if a run fails.
- USCIS times describe how long it took to complete 80% of cases. They aren't a
  guarantee for any individual case, and this site isn't legal advice.
