# Test fixtures

`api/` holds USCIS API responses, one file per request, named the way
`node scripts/fetch-processing-times.mjs --raw-dir <dir>` saves them
(`processingtime/I-485/BOS/485-FB` → `processingtime__I-485__BOS__485-FB.json`).

The current files are **hand-written** in the format the fetcher expects. They
haven't been checked against real USCIS output yet. To test against real
responses, run a small live fetch and copy what it saved:

```bash
node scripts/fetch-processing-times.mjs --forms I-485,N-400 --raw-dir /tmp/uscis-raw --out /tmp/check.json
rm test/fixtures/api/*.json && cp /tmp/uscis-raw/*.json test/fixtures/api/
```

Then update the expected values in `test/fetch.test.mjs` to match what USCIS
shows for those offices on https://egov.uscis.gov/processing-times.
