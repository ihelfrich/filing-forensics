# Filing Forensics

A static SEC-filing research site. It includes a filing finder, a focused time-series view,
and a Workbench for financial screens and XBRL provenance.

- **Workbench** (`app.html`): load annual XBRL facts, calculate the forensic screens, and inspect provenance.
- **Report Finder** (`finder.html`): search recent SEC filings by ticker or company name.
- **Dissector** (`dissector.html`): inspect a smaller set of operating and working-capital measures.
- **Method** (`index.html`): see how the filing tools fit into a sourced company case.

## Why it's built this way

The SEC `submissions` API sends CORS headers, so the Finder runs live in the browser. The SEC `xbrl`
API does **not** send CORS headers, so the Workbench uses bundled data, an optional proxy, or a
`companyfacts.json` loaded in the browser. Each path runs the extraction logic in `js/sec.js`,
which mirrors `build_site_data.py`. The site has no backend or build step.

## Data

`data/companies/*.json` contains the bundled annual series extracted by `../build_site_data.py`
from SEC companyfacts. `data/tickers.json` is the EDGAR ticker-to-CIK map used for client-side lookup.

## Rebuild the data

```
python3 build_site_data.py   # from the repo root; writes into site/data/
```

## Run locally

```
cd site && python3 -m http.server 8765   # then open http://localhost:8765/
```
