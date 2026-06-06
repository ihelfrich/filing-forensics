/* sec.js - shared SEC EDGAR helpers for Filing Forensics.
   Two facts about CORS drive this design:
     - data.sec.gov/submissions/* DOES send Access-Control-Allow-Origin:* (live OK)
     - data.sec.gov/api/xbrl/*    does NOT (so we bundle or upload companyfacts)
*/
const SEC = (() => {
  let TICKERS = null; // [[cik, ticker, title], ...]

  const cik10 = (cik) => String(cik).padStart(10, "0");
  const fmtUSD = (v) => {
    if (v == null || isNaN(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(0)}M`;
    return `${s}$${a.toLocaleString()}`;
  };
  const fmtPct = (v, d = 1) => (v == null || isNaN(v) ? "–" : `${(v * 100).toFixed(d)}%`);

  async function loadTickers() {
    if (TICKERS) return TICKERS;
    const base = document.body.dataset.base || ".";
    const r = await fetch(`${base}/data/tickers.json`);
    TICKERS = await r.json();
    return TICKERS;
  }

  // Resolve a query (ticker or name) to candidates [{cik,ticker,title}].
  async function resolve(query) {
    const t = await loadTickers();
    const q = query.trim().toUpperCase();
    if (!q) return [];
    const exact = t.filter((r) => r[1] === q).map(toObj);
    if (exact.length) return exact;
    const starts = t.filter((r) => r[1].startsWith(q)).map(toObj);
    const inName = t.filter((r) => r[2].toUpperCase().includes(q)).map(toObj);
    const seen = new Set();
    return [...starts, ...inName].filter((o) => {
      if (seen.has(o.cik)) return false;
      seen.add(o.cik); return true;
    }).slice(0, 12);
  }
  const toObj = (r) => ({ cik: r[0], ticker: r[1], title: r[2] });

  async function submissions(cik) {
    const url = `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SEC submissions ${r.status}`);
    return r.json();
  }

  // Flatten the "recent filings" arrays into objects, optionally filtered by form.
  function recentFilings(subs, forms) {
    const f = subs.filings.recent;
    const cik = Number(subs.cik);
    const out = [];
    for (let i = 0; i < f.accessionNumber.length; i++) {
      if (forms && !forms.includes(f.form[i])) continue;
      const acc = f.accessionNumber[i];
      const accNoDash = acc.replace(/-/g, "");
      const doc = f.primaryDocument[i];
      out.push({
        form: f.form[i],
        filed: f.filingDate[i],
        reportDate: f.reportDate[i],
        accession: acc,
        desc: f.primaryDocDescription[i] || "",
        indexUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/`,
        docUrl: doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${doc}` : null,
        viewerUrl: `https://www.sec.gov/cgi-bin/viewer?action=view&cik=${cik}&type=${encodeURIComponent(f.form[i])}`,
      });
    }
    return out;
  }

  const companyFactsUrl = (cik) =>
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(cik)}.json`;

  // --- Extraction: mirror of build_site_data.py pick_series, in JS. ---
  const DURATION = {
    revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    operating_income: ["OperatingIncomeLoss"],
    net_income: ["NetIncomeLoss"],
    cogs: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"],
    capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    operating_cash_flow: ["NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  };
  const INSTANT = {
    inventory: ["InventoryNet"],
    receivables: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"],
    payables: ["AccountsPayableCurrent", "AccountsPayableTradeCurrent"],
    ppe_net: ["PropertyPlantAndEquipmentNet"],
  };

  function pickSeries(facts, tags, instant) {
    const out = {};
    const src = (facts.facts && facts.facts["us-gaap"]) || {};
    for (const tag of tags) {
      const node = src[tag];
      if (!node || !node.units || !node.units.USD) continue;
      const usd = node.units.USD;
      for (const f of usd) { // frame points first
        const fr = f.frame;
        if (!fr) continue;
        if (instant) {
          if (fr.length === 9 && fr.startsWith("CY") && fr.endsWith("Q4I")) {
            const yr = +fr.slice(2, 6);
            if (out[yr] == null) out[yr] = f.val;
          }
        } else if (fr.length === 6 && fr.startsWith("CY") && /^\d+$/.test(fr.slice(2))) {
          const yr = +fr.slice(2);
          if (out[yr] == null) out[yr] = f.val;
        }
      }
      for (const f of usd) { // fill gaps from 10-K FY facts
        if (f.frame) continue;
        if (f.form !== "10-K" || f.fp !== "FY") continue;
        const end = f.end || "";
        if (end.length < 4) continue;
        const yr = +end.slice(0, 4);
        if (instant) { if (out[yr] == null) out[yr] = f.val; }
        else {
          const start = f.start || "";
          if (start && (+end.slice(0, 4) - +start.slice(0, 4)) <= 1 && out[yr] == null) out[yr] = f.val;
        }
      }
    }
    return out;
  }

  // Parse a raw companyfacts object into rows [{fy, revenue, ...}].
  function extractRows(facts) {
    const series = {};
    for (const [k, tags] of Object.entries(DURATION)) series[k] = pickSeries(facts, tags, false);
    for (const [k, tags] of Object.entries(INSTANT)) series[k] = pickSeries(facts, tags, true);
    const years = new Set();
    Object.values(series).forEach((s) => Object.keys(s).forEach((y) => years.add(+y)));
    const rows = [...years].sort((a, b) => a - b).filter((y) => y >= 2009).map((y) => {
      const row = { fy: y };
      for (const k of [...Object.keys(DURATION), ...Object.keys(INSTANT)]) {
        if (series[k][y] != null) row[k] = series[k][y];
      }
      return row;
    });
    return rows;
  }

  // Derived instruments per row + a copy with margins/ccc filled.
  function withInstruments(rows) {
    return rows.map((r, i) => {
      const prev = rows[i - 1];
      const out = { ...r };
      if (r.revenue) {
        out.op_margin = r.operating_income != null ? r.operating_income / r.revenue : null;
        out.net_margin = r.net_income != null ? r.net_income / r.revenue : null;
        out.capex_intensity = r.capex != null ? r.capex / r.revenue : null;
      }
      if (prev && prev.revenue && r.revenue) out.rev_growth = r.revenue / prev.revenue - 1;
      if (r.cogs && r.revenue) {
        const dio = r.inventory != null ? (r.inventory / r.cogs) * 365 : null;
        const dso = r.receivables != null ? (r.receivables / r.revenue) * 365 : null;
        const dpo = r.payables != null ? (r.payables / r.cogs) * 365 : null;
        out.dio = dio; out.dso = dso; out.dpo = dpo;
        if (dio != null && dso != null && dpo != null) out.ccc = dio + dso - dpo;
      }
      return out;
    });
  }

  async function loadBundled(ticker) {
    const base = document.body.dataset.base || ".";
    const r = await fetch(`${base}/data/companies/${ticker}.json`);
    if (!r.ok) throw new Error(`no bundled data for ${ticker}`);
    return r.json();
  }
  async function bundledIndex() {
    const base = document.body.dataset.base || ".";
    const r = await fetch(`${base}/data/companies/index.json`);
    return r.json();
  }

  return { cik10, fmtUSD, fmtPct, loadTickers, resolve, submissions, recentFilings,
    companyFactsUrl, extractRows, withInstruments, loadBundled, bundledIndex };
})();
