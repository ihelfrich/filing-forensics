# Filing Forensics

A static research workbench: the schematic for how a company case study gets built, plus two
working tools for the middle steps. Built around the Amazon (Gallaugher, Chapter 8) case, but
the tools work for any US public company.

- **Schematic** (`index.html`) — the six-phase research pipeline, with the in-scope / out-of-scope fork.
- **Report Finder** (`finder.html`) — type a ticker or name, list a company's SEC filings live from EDGAR.
- **Filing Dissector** (`dissector.html`) — build an annual time series and compute operating margin, capex
  intensity, and the cash conversion cycle. Load a bundled company instantly, or drop in any company's
  `companyfacts.json`.

## Why it's built this way

The SEC `submissions` API sends CORS headers, so the Finder runs live in the browser. The SEC `xbrl`
API does **not** send CORS headers, so the Dissector either uses pre-extracted data (bundled companies)
or parses a `companyfacts.json` you upload. Both paths run the same extraction logic
(`js/sec.js` mirrors `build_site_data.py`). No backend, no build step.

## Data

`data/companies/*.json` are slim annual series for the case-relevant firms (Amazon, Walmart, Microsoft,
Alphabet, FedEx, UPS, Target), extracted by `../build_site_data.py` from SEC companyfacts. `data/tickers.json`
is the EDGAR ticker→CIK map for client-side lookup. All SEC data is public domain.

## Rebuild the data

```
python3 build_site_data.py   # from the repo root; writes into site/data/
```

## Run locally

```
cd site && python3 -m http.server 8765   # then open http://localhost:8765/
```
