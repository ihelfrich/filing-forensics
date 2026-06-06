/* sec.js - shared SEC EDGAR engine for Filing Forensics.
   Two facts about CORS drive this design:
     - data.sec.gov/submissions/*  DOES send Access-Control-Allow-Origin:* (live OK)
     - data.sec.gov/api/xbrl/*     sends it only on the OPTIONS preflight, never on
       the GET, so a browser cannot read the body. We get company financials three ways:
         1. bundled (pre-extracted server-side, shipped as static JSON),
         2. an optional CORS proxy worker (live, any filer),
         3. a user-dropped companyfacts.json (parsed in-browser).
   All three feed the SAME extraction + instrument logic below, mirrored in
   build_site_data.py so a bundled number and an uploaded number are computed identically.
*/
const SEC = (() => {
  let TICKERS = null;            // [[cik, ticker, title], ...]
  let TICKERS_PROMISE = null;
  let PROXY = null;             // optional CORS proxy base, e.g. https://x.workers.dev

  const base = () => (document.body && document.body.dataset.base) || ".";
  const cik10 = (cik) => String(cik).padStart(10, "0");

  // ---- formatting ----------------------------------------------------------
  const fmtUSD = (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "–";
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(0)}M`;
    return `${s}$${a.toLocaleString()}`;
  };
  const fmtPct = (v, d = 1) => (typeof v !== "number" || !Number.isFinite(v) ? "–" : `${(v * 100).toFixed(d)}%`);
  const fmtNum = (v, d = 2) => (typeof v !== "number" || !Number.isFinite(v) ? "–" : v.toFixed(d));
  const fmtDays = (v) => (typeof v !== "number" || !Number.isFinite(v) ? "–" : Math.round(v).toString());

  // ---- ticker resolution ---------------------------------------------------
  async function loadTickers() {
    if (TICKERS) return TICKERS;
    if (!TICKERS_PROMISE) {
      TICKERS_PROMISE = fetch(`${base()}/data/tickers.json`).then(async (r) => {
        if (!r.ok) throw new Error(`ticker map ${r.status}`);
        const rows = await r.json();
        if (!Array.isArray(rows)) throw new Error("ticker map has an unexpected format");
        TICKERS = rows;
        return rows;
      }).catch((e) => {
        TICKERS_PROMISE = null;
        throw e;
      });
    }
    return TICKERS_PROMISE;
  }
  const toObj = (r) => ({ cik: r[0], ticker: r[1], title: r[2] });

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

  // ---- submissions (live; CORS OK) ----------------------------------------
  async function submissions(cik) {
    const url = `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SEC submissions ${r.status}`);
    return r.json();
  }

  function recentFilings(subs, forms) {
    const f = subs && subs.filings && subs.filings.recent;
    if (!f || !Array.isArray(f.accessionNumber)) return [];
    const cik = Number(subs.cik);
    const out = [];
    for (let i = 0; i < f.accessionNumber.length; i++) {
      const form = f.form && f.form[i];
      if (forms && !forms.includes(form)) continue;
      const acc = f.accessionNumber[i];
      if (!acc) continue;
      const accNoDash = acc.replace(/-/g, "");
      const doc = f.primaryDocument && f.primaryDocument[i];
      out.push({
        form: form || "",
        filed: (f.filingDate && f.filingDate[i]) || "",
        reportDate: (f.reportDate && f.reportDate[i]) || "",
        accession: acc,
        desc: (f.primaryDocDescription && f.primaryDocDescription[i]) || "",
        indexUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/`,
        docUrl: doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${doc}` : null,
      });
    }
    return out;
  }

  const companyFactsUrl = (cik) =>
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(cik)}.json`;

  // ---- extraction schema ---------------------------------------------------
  // Each concept: ordered candidate us-gaap tags (first hit per year wins),
  // kind (duration flow vs instant balance), and unit.
  const CONCEPTS = {
    // income statement (flows)
    revenue:            { kind: "d", tags: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"] },
    cogs:               { kind: "d", tags: ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"] },
    gross_profit:       { kind: "d", tags: ["GrossProfit"] },
    sga:                { kind: "d", tags: ["SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"] },
    operating_income:   { kind: "d", tags: ["OperatingIncomeLoss"] },
    pretax_income:      { kind: "d", tags: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"] },
    income_tax:         { kind: "d", tags: ["IncomeTaxExpenseBenefit"] },
    net_income:         { kind: "d", tags: ["NetIncomeLoss"] },
    interest_expense:   { kind: "d", tags: ["InterestExpense", "InterestExpenseNonoperating"] },
    dep_amort:          { kind: "d", tags: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization", "Depreciation"] },
    // cash flow (flows)
    operating_cash_flow:{ kind: "d", tags: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"] },
    capex:              { kind: "d", tags: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"] },
    // balance sheet (instant)
    cash:               { kind: "i", tags: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"] },
    receivables:        { kind: "i", tags: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"] },
    inventory:          { kind: "i", tags: ["InventoryNet"] },
    current_assets:     { kind: "i", tags: ["AssetsCurrent"] },
    ppe_net:            { kind: "i", tags: ["PropertyPlantAndEquipmentNet", "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization"] },
    total_assets:       { kind: "i", tags: ["Assets"] },
    payables:           { kind: "i", tags: ["AccountsPayableCurrent", "AccountsPayableTradeCurrent"] },
    current_liabilities:{ kind: "i", tags: ["LiabilitiesCurrent"] },
    long_term_debt:     { kind: "i", tags: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"] },
    short_term_debt:    { kind: "i", tags: ["DebtCurrent", "LongTermDebtCurrent", "ShortTermBorrowings"] },
    total_liabilities:  { kind: "i", tags: ["Liabilities"] },
    retained_earnings:  { kind: "i", tags: ["RetainedEarningsAccumulatedDeficit"] },
    equity:             { kind: "i", tags: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"] },
    // shares (unit = "shares")
    shares_diluted:     { kind: "d", unit: "shares", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
    shares_out:         { kind: "i", unit: "shares", tags: ["CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"] },
  };

  // pick {year -> {val, tag, frame, form, accn, end}} for one concept.
  function pickSeries(facts, def) {
    const out = {};
    const src = (facts.facts && facts.facts["us-gaap"]) || {};
    const dei = (facts.facts && facts.facts["dei"]) || {};
    const unit = def.unit || "USD";
    const instant = def.kind === "i";
    for (const tag of def.tags) {
      const node = src[tag] || dei[tag];
      if (!node || !node.units || !node.units[unit]) continue;
      const pts = node.units[unit];
      // pass 1: clean calendar-year frame points (dedupes restatements)
      for (const f of pts) {
        const fr = f.frame;
        if (!fr) continue;
        if (instant) {
          if (fr.length === 9 && fr.startsWith("CY") && fr.endsWith("Q4I")) {
            const yr = +fr.slice(2, 6);
            if (out[yr] == null) out[yr] = meta(f, tag);
          }
        } else if (fr.length === 6 && fr.startsWith("CY") && /^\d+$/.test(fr.slice(2))) {
          const yr = +fr.slice(2);
          if (out[yr] == null) out[yr] = meta(f, tag);
        }
      }
      // pass 2: fill gaps from latest 10-K FY facts lacking a frame
      for (const f of pts) {
        if (f.frame) continue;
        if (f.form !== "10-K" || f.fp !== "FY") continue;
        const end = f.end || "";
        if (end.length < 4) continue;
        const yr = +end.slice(0, 4);
        if (instant) { if (out[yr] == null) out[yr] = meta(f, tag); }
        else {
          const start = f.start || "";
          if (start && (+end.slice(0, 4) - +start.slice(0, 4)) <= 1 && out[yr] == null) out[yr] = meta(f, tag);
        }
      }
    }
    return out;
  }
  const meta = (f, tag) => ({ val: f.val, tag, frame: f.frame || null, form: f.form || null, accn: f.accn || null, end: f.end || null });

  // Build flat rows + a provenance map from a raw companyfacts object.
  function extractSeries(facts) {
    const series = {};
    for (const [k, def] of Object.entries(CONCEPTS)) series[k] = pickSeries(facts, def);
    const years = new Set();
    Object.values(series).forEach((s) => Object.keys(s).forEach((y) => years.add(+y)));
    const sorted = [...years].sort((a, b) => a - b).filter((y) => y >= 2008);
    const rows = [], prov = {};
    for (const y of sorted) {
      const row = { fy: y };
      for (const k of Object.keys(CONCEPTS)) {
        const m = series[k][y];
        if (m && m.val != null) {
          row[k] = m.val;
          (prov[k] = prov[k] || {})[y] = { tag: m.tag, frame: m.frame, form: m.form, accn: m.accn, end: m.end };
        }
      }
      rows.push(row);
    }
    // Drop non-statement years: a 10-K cover page tags shares outstanding as of a
    // date in the *next* calendar year, which would otherwise create a phantom row
    // holding only a share count. A real fiscal year has revenue or total assets.
    const clean = rows.filter((r) => r.revenue != null || r.total_assets != null);
    return { rows: clean, prov };
  }
  // back-compat: old callers want just the rows
  const extractRows = (facts) => extractSeries(facts).rows;

  // ---- instruments ---------------------------------------------------------
  const div = (a, b) => (a != null && b != null && b !== 0 ? a / b : null);

  function withInstruments(rows) {
    return rows.map((r, i) => {
      const p = rows[i - 1] || {};
      const o = { ...r };
      const totalDebt = (r.long_term_debt || 0) + (r.short_term_debt || 0);
      o.total_debt = (r.long_term_debt != null || r.short_term_debt != null) ? totalDebt : null;
      const gp = r.gross_profit != null ? r.gross_profit
                : (r.revenue != null && r.cogs != null ? r.revenue - r.cogs : null);
      o.gross_profit_c = gp;

      // margins & returns
      o.op_margin      = div(r.operating_income, r.revenue);
      o.net_margin     = div(r.net_income, r.revenue);
      o.gross_margin   = div(gp, r.revenue);
      o.capex_intensity = div(r.capex, r.revenue);
      o.fcf            = (r.operating_cash_flow != null && r.capex != null) ? r.operating_cash_flow - r.capex : null;
      o.fcf_margin     = div(o.fcf, r.revenue);
      o.rev_growth     = div(r.revenue, p.revenue) != null ? r.revenue / p.revenue - 1 : null;
      o.roa            = div(r.net_income, r.total_assets);
      o.roe            = div(r.net_income, r.equity);
      // ROIC ~ NOPAT / invested capital
      const taxRate = (r.income_tax != null && r.pretax_income && r.pretax_income > 0)
        ? Math.min(0.45, Math.max(0, r.income_tax / r.pretax_income)) : 0.21;
      const nopat = r.operating_income != null ? r.operating_income * (1 - taxRate) : null;
      const investedCap = (r.equity != null) ? r.equity + (o.total_debt || 0) - (r.cash || 0) : null;
      o.roic = div(nopat, investedCap);

      // liquidity / leverage
      o.current_ratio  = div(r.current_assets, r.current_liabilities);
      o.debt_to_equity = div(o.total_debt, r.equity);

      // working capital cycle
      if (r.cogs && r.revenue) {
        o.dio = r.inventory != null ? (r.inventory / r.cogs) * 365 : null;
        o.dso = r.receivables != null ? (r.receivables / r.revenue) * 365 : null;
        o.dpo = r.payables != null ? (r.payables / r.cogs) * 365 : null;
        if (o.dio != null && o.dso != null && o.dpo != null) o.ccc = o.dio + o.dso - o.dpo;
      }

      // Sloan accruals ratio = (NI - CFO) / avg total assets  (high = lower earnings quality)
      if (r.net_income != null && r.operating_cash_flow != null && r.total_assets) {
        const avgTA = p.total_assets ? (r.total_assets + p.total_assets) / 2 : r.total_assets;
        o.accruals_ratio = (r.net_income - r.operating_cash_flow) / avgTA;
      }

      // Altman Z'' (no market value; valid across sectors)
      o.altman = altmanZ(r);
      // Beneish M-score (needs prior year)
      o.beneish = beneishM(r, p, gp, p.gross_profit != null ? p.gross_profit : (p.revenue != null && p.cogs != null ? p.revenue - p.cogs : null));
      // Piotroski F-score (needs prior year)
      o.piotroski = piotroskiF(o, r, p);
      return o;
    });
  }

  function altmanZ(r) {
    const TA = r.total_assets;
    // Many filers omit a total "Liabilities" line; derive it from assets - equity.
    const liab = r.total_liabilities != null ? r.total_liabilities
               : (TA != null && r.equity != null ? TA - r.equity : null);
    if (!TA || r.current_assets == null || r.current_liabilities == null
        || r.retained_earnings == null || r.operating_income == null
        || r.equity == null || liab == null || liab === 0) return { z: null };
    const x1 = (r.current_assets - r.current_liabilities) / TA;
    const x2 = r.retained_earnings / TA;
    const x3 = r.operating_income / TA;        // EBIT proxy
    const x4 = r.equity / liab;                // book value of equity / total liabilities
    const z = 6.56 * x1 + 3.26 * x2 + 6.72 * x3 + 1.05 * x4;
    const zone = z > 2.6 ? "safe" : z >= 1.1 ? "grey" : "distress";
    return { z, zone, x1, x2, x3, x4 };
  }

  function beneishM(r, p, gp, gpPrev) {
    const need = [r.revenue, p.revenue, r.receivables, p.receivables, r.total_assets, p.total_assets,
                  r.current_assets, p.current_assets, r.ppe_net, p.ppe_net, r.net_income,
                  r.operating_cash_flow];
    if (need.some((v) => v == null) || !p.revenue || !r.revenue) return { m: null };
    const DSRI = (r.receivables / r.revenue) / (p.receivables / p.revenue);
    const gmT = gp != null ? gp / r.revenue : null;
    const gmP = gpPrev != null ? gpPrev / p.revenue : null;
    const GMI = (gmP != null && gmT) ? gmP / gmT : 1;
    const aqiT = 1 - (r.current_assets + r.ppe_net) / r.total_assets;
    const aqiP = 1 - (p.current_assets + p.ppe_net) / p.total_assets;
    const AQI = aqiP !== 0 ? aqiT / aqiP : 1;
    const SGI = r.revenue / p.revenue;
    let DEPI = 1;
    if (r.dep_amort != null && p.dep_amort != null && r.ppe_net && p.ppe_net) {
      const dT = p.dep_amort / (p.dep_amort + p.ppe_net);
      const dC = r.dep_amort / (r.dep_amort + r.ppe_net);
      if (dC) DEPI = dT / dC;
    }
    let SGAI = 1;
    if (r.sga != null && p.sga != null) SGAI = (r.sga / r.revenue) / (p.sga / p.revenue);
    const levT = ((r.current_liabilities || 0) + (r.long_term_debt || 0)) / r.total_assets;
    const levP = ((p.current_liabilities || 0) + (p.long_term_debt || 0)) / p.total_assets;
    const LVGI = levP ? levT / levP : 1;
    const TATA = (r.net_income - r.operating_cash_flow) / r.total_assets;
    const m = -4.84 + 0.92 * DSRI + 0.528 * GMI + 0.404 * AQI + 0.892 * SGI
            + 0.115 * DEPI - 0.172 * SGAI + 4.679 * TATA - 0.327 * LVGI;
    return { m, flag: m > -1.78, parts: { DSRI, GMI, AQI, SGI, DEPI, SGAI, LVGI, TATA } };
  }

  function piotroskiF(o, r, p) {
    const signals = {};
    let score = 0, scored = 0;
    const add = (key, cond) => {
      if (cond == null) { signals[key] = null; return; }
      signals[key] = cond ? 1 : 0; score += cond ? 1 : 0; scored++;
    };
    const roa = div(r.net_income, r.total_assets);
    const roaP = div(p.net_income, p.total_assets);
    add("roa_pos", roa != null ? roa > 0 : null);
    add("cfo_pos", r.operating_cash_flow != null ? r.operating_cash_flow > 0 : null);
    add("droa", (roa != null && roaP != null) ? roa > roaP : null);
    add("accrual", (r.operating_cash_flow != null && r.net_income != null && r.total_assets) ? r.operating_cash_flow > r.net_income : null);
    const levT = div(r.long_term_debt, r.total_assets), levP = div(p.long_term_debt, p.total_assets);
    add("dlever", (levT != null && levP != null) ? levT < levP : null);
    const crT = div(r.current_assets, r.current_liabilities), crP = div(p.current_assets, p.current_liabilities);
    add("dcurrent", (crT != null && crP != null) ? crT > crP : null);
    add("dshares", (r.shares_diluted != null && p.shares_diluted != null) ? r.shares_diluted <= p.shares_diluted : null);
    const gmT = o.gross_margin, gmP = (p.gross_profit != null ? p.gross_profit : (p.revenue != null && p.cogs != null ? p.revenue - p.cogs : null));
    const gmPr = gmP != null && p.revenue ? gmP / p.revenue : null;
    add("dmargin", (gmT != null && gmPr != null) ? gmT > gmPr : null);
    const atoT = div(r.revenue, r.total_assets), atoP = div(p.revenue, p.total_assets);
    add("dturn", (atoT != null && atoP != null) ? atoT > atoP : null);
    return { f: scored ? score : null, scored, signals };
  }

  // verdict helpers for the UI
  const beneishVerdict = (m) => m == null ? null : (m > -1.78 ? "manipulation risk" : "no flag");
  const altmanVerdict = (z) => z == null ? null : (z > 2.6 ? "safe zone" : z >= 1.1 ? "grey zone" : "distress zone");
  const piotroskiVerdict = (f) => f == null ? null : (f >= 7 ? "strong" : f <= 2 ? "weak" : "middling");

  // ---- data loading (bundled / proxy / upload) -----------------------------
  function setProxy(url) { PROXY = url && url.trim() ? url.replace(/\/$/, "") : null; }
  function getProxy() { return PROXY; }

  async function loadBundled(ticker) {
    const symbol = String(ticker || "").trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,20}$/.test(symbol)) throw new Error("invalid bundled ticker");
    const r = await fetch(`${base()}/data/companies/${symbol}.json`);
    if (!r.ok) throw new Error(`no bundled data for ${symbol}`);
    return r.json();
  }
  async function bundledIndex() {
    const r = await fetch(`${base()}/data/companies/index.json`);
    if (!r.ok) throw new Error(`bundled index ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error("bundled index has an unexpected format");
    return rows;
  }
  // live fetch of companyfacts via the optional proxy (throws if no proxy)
  async function loadViaProxy(cik) {
    if (!PROXY) throw new Error("no proxy configured");
    const r = await fetch(`${PROXY}/api/xbrl/companyfacts/CIK${cik10(cik)}.json`);
    if (!r.ok) throw new Error(`proxy ${r.status}`);
    return r.json();
  }

  return {
    cik10, fmtUSD, fmtPct, fmtNum, fmtDays,
    loadTickers, resolve, submissions, recentFilings, companyFactsUrl,
    CONCEPTS, extractSeries, extractRows, withInstruments,
    altmanZ, beneishM, piotroskiF, beneishVerdict, altmanVerdict, piotroskiVerdict,
    loadBundled, bundledIndex, setProxy, getProxy, loadViaProxy,
  };
})();
