/* app.js - the Filing Forensics Workbench.
   One console: resolve a company, load its numbers (bundled / proxy / uploaded
   companyfacts.json), and read the full forensic stack with per-cell provenance.
   All math lives in sec.js so a bundled number and an uploaded number agree. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
  const onActivate = (el, fn) => {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.addEventListener("click", fn);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      fn();
    });
  };
  const normalizeCik = (v) => {
    const cik = String(v == null ? "" : v).trim();
    return /^\d{1,10}$/.test(cik) ? cik : "";
  };
  const status = $("status");
  const setStatus = (m, err) => { status.textContent = m || ""; status.className = "status" + (err ? " err" : ""); };
  const PALETTE = { blue: "#2f5d7c", rust: "#b0472b", ink: "#1c1c1c", green: "#3f6b54", gold: "#9a7a2e", gray: "#c7c7c7", teal: "#2f7c74", violet: "#6b4e7c" };
  let current = null;     // { meta:{ticker,cik,title,sector}, rows, prov, mode }
  let chart = null;
  const fcharts = { altman: null, beneish: null, piotroski: null };

  // Chart.js plugin: paint horizontal threshold bands behind a series. Used by
  // the forensic trajectory charts (Altman safe/grey/distress, Beneish flag line).
  if (window.Chart) Chart.register({
    id: "bands",
    beforeDatasetsDraw(c) {
      const cfg = c.options.plugins && c.options.plugins.bands;
      if (!cfg || !cfg.ranges) return;
      const a = c.chartArea, y = c.scales.y, ctx = c.ctx;
      ctx.save();
      cfg.ranges.forEach((b) => {
        const top = Math.max(a.top, Math.min(y.getPixelForValue(b.from), y.getPixelForValue(b.to)));
        const bot = Math.min(a.bottom, Math.max(y.getPixelForValue(b.from), y.getPixelForValue(b.to)));
        if (bot <= top) return;
        ctx.fillStyle = b.color;
        ctx.fillRect(a.left, top, a.right - a.left, bot - top);
      });
      ctx.restore();
    },
  });

  // ---- restore a saved proxy, wire the advanced box ------------------------
  let savedProxy = "";
  try { savedProxy = localStorage.getItem("ff_proxy") || ""; } catch (_) { /* storage may be disabled */ }
  if (savedProxy) { SEC.setProxy(savedProxy); }
  const proxyInput = $("proxyUrl");
  if (proxyInput) {
    proxyInput.value = savedProxy;
    $("proxySave").onclick = () => {
      const v = proxyInput.value.trim();
      if (v && !/^https?:\/\//i.test(v)) {
        return setStatus("Enter a proxy URL that starts with http:// or https://.", true);
      }
      SEC.setProxy(v);
      try {
        if (v) localStorage.setItem("ff_proxy", v); else localStorage.removeItem("ff_proxy");
      } catch (_) { /* the proxy still applies for this page load */ }
      setStatus(v ? "Proxy saved. Non-bundled companies will load live." : "Proxy cleared.");
    };
  }

  // ---- bundled catalog: chips grouped by sector ----------------------------
  let currentIndex = [];
  const indexReady = SEC.bundledIndex().then((idx) => {
    currentIndex = idx;
    const bySector = Object.create(null);
    idx.forEach((c) => (bySector[c.sector] = bySector[c.sector] || []).push(c));
    const wrap = $("bundled");
    Object.keys(bySector).sort().forEach((sec) => {
      const g = document.createElement("div");
      g.className = "chipgroup";
      g.innerHTML = `<span class="small muted" style="display:block;margin:6px 0 2px">${esc(sec)}</span>`;
      const row = document.createElement("div"); row.className = "chips";
      bySector[sec].forEach((c) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip"; chip.textContent = c.ticker; chip.title = c.title;
        chip.onclick = () => loadBundled(c);
        row.appendChild(chip);
      });
      g.appendChild(row); wrap.appendChild(g);
    });
    return idx;
  }).catch((e) => {
    setStatus("Could not load the bundled company index. " + e.message, true);
    return [];
  });

  // ---- search --------------------------------------------------------------
  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  const searchButton = $("searchForm").querySelector("button[type=submit]");
  const setSearchBusy = (on) => {
    if (!searchButton) return;
    searchButton.disabled = on;
    searchButton.setAttribute("aria-busy", String(on));
  };
  async function runSearch() {
    const q = $("q").value.trim();
    $("candidates").innerHTML = "";
    if (!q) return;
    $("bridge").classList.add("hidden");
    drop.classList.remove("await");
    setSearchBusy(true);
    setStatus("Resolving company...");
    let cands;
    try { cands = await SEC.resolve(q); }
    catch (e) {
      setSearchBusy(false);
      return setStatus("Could not load the ticker map. " + e.message, true);
    }
    await indexReady;
    setSearchBusy(false);
    if (!cands.length) return setStatus(`No company matched "${q}".`, true);
    const bundled = (t) => currentIndex.find((c) => c.ticker === t);
    if (cands.length === 1) return resolveAndLoad(cands[0]);
    setStatus(`${cands.length} matches. Pick one:`);
    const box = $("candidates");
    cands.forEach((c) => {
      const isB = bundled(c.ticker);
      const d = document.createElement("div");
      d.className = "filing"; d.style.cursor = "pointer";
      d.innerHTML = `<span class="form">${esc(c.ticker)}</span><span class="mono small">CIK ${esc(c.cik)}</span>
        <span class="small">${esc(c.title)}</span>
        <span class="links">${isB ? '<span class="mode-tag bundled">bundled</span>' : "load"}</span>`;
      onActivate(d, () => resolveAndLoad(c));
      box.appendChild(d);
    });
  }

  // Decide how to source a resolved company: bundled, else proxy, else bridge.
  async function resolveAndLoad(c) {
    $("candidates").innerHTML = "";
    await indexReady;
    const b = currentIndex.find((x) => x.ticker === c.ticker);
    if (b) return loadBundled(b);
    const cik = normalizeCik(c.cik);
    if (!cik) return setStatus("This company does not have a valid CIK.", true);
    if (SEC.getProxy()) {
      setStatus(`Loading ${c.ticker} through the proxy...`);
      try {
        const facts = await SEC.loadViaProxy(cik);
        return ingestFacts(facts, { ticker: c.ticker, cik, title: c.title, sector: "" }, "proxy");
      } catch (e) {
        showBridge({ ...c, cik });
        return setStatus("Proxy request failed: " + e.message + ". You can still load the SEC file below.", true);
      }
    }
    showBridge({ ...c, cik });
  }

  async function loadBundled(c) {
    setStatus(`Loading ${c.ticker}...`);
    try {
      const data = await SEC.loadBundled(c.ticker);
      render({ ticker: data.ticker, cik: data.cik, title: data.title, sector: data.sector },
        data.rows, data.prov || {}, "bundled");
      setStatus("");
    } catch (bundledError) {
      const cik = normalizeCik(c.cik);
      if (cik && SEC.getProxy()) {
        setStatus(`Bundled data failed. Trying ${c.ticker} through the proxy...`);
        try {
          const facts = await SEC.loadViaProxy(cik);
          return ingestFacts(facts, { ticker: c.ticker, cik, title: c.title, sector: c.sector || "" }, "proxy");
        } catch (proxyError) {
          showBridge({ ...c, cik });
          return setStatus(`Bundled load failed (${bundledError.message}); proxy request failed (${proxyError.message}). Load the SEC file below.`, true);
        }
      }
      if (cik) {
        showBridge({ ...c, cik });
        return setStatus("Bundled data could not be loaded. You can still load the SEC file below.", true);
      }
      setStatus("Load failed: " + bundledError.message, true);
    }
  }

  // ---- file drop / upload --------------------------------------------------
  const drop = $("drop"), file = $("file");
  drop.addEventListener("click", (e) => {
    if (e.target === file || e.target.closest("a")) return;
    file.click();
  });
  file.onchange = () => {
    if (file.files[0]) readFile(file.files[0]);
    file.value = "";
  };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) readFile(f); });

  function readFile(f) {
    setStatus(`Parsing ${f.name}...`);
    const reader = new FileReader();
    reader.onload = () => {
      let facts;
      try { facts = JSON.parse(reader.result); }
      catch { return setStatus("That file is not valid JSON.", true); }
      if (!facts.facts || !facts.facts["us-gaap"]) return setStatus("This is not an SEC companyfacts.json file (facts.us-gaap is missing).", true);
      const meta = { ticker: "", cik: facts.cik || "", title: facts.entityName || f.name.replace(/\.json$/i, ""), sector: "" };
      ingestFacts(facts, meta, "upload");
    };
    reader.onerror = () => setStatus(`Could not read ${f.name}.`, true);
    reader.readAsText(f);
  }

  function ingestFacts(facts, meta, mode) {
    let rows, prov;
    try {
      ({ rows, prov } = SEC.extractSeries(facts));
    } catch (e) {
      return setStatus("Could not extract an annual series: " + e.message, true);
    }
    if (!rows.length) return setStatus("No annual series could be extracted.", true);
    render(meta, rows, prov, mode);
    setStatus("");
  }

  // ---- non-bundled, no-proxy: download-and-drop bridge ---------------------
  function showBridge(c) {
    const url = SEC.companyFactsUrl(c.cik);
    $("bridge").innerHTML = `
      <div class="note warn" style="margin-top:0">
        <b>${esc(c.title || c.ticker)}</b> is not bundled. The SEC XBRL endpoint does not let this page read
        the response directly, so choose one of these routes:
        <ol class="bridge-steps">
          <li><a class="btn" href="${url}" target="_blank" rel="noopener">Open companyfacts.json</a>
            <span class="small muted" style="margin-left:8px">Save the file, then load it below. Parsing stays in your browser.</span></li>
          <li>Set a CORS proxy under <b>Advanced</b> to load non-bundled filers directly.</li>
        </ol>
      </div>`;
    $("bridge").classList.remove("hidden");
    drop.classList.add("await");
    setStatus("");
  }

  // ---- formatting ----------------------------------------------------------
  const U = SEC.fmtUSD, P = SEC.fmtPct, N = SEC.fmtNum, D = SEC.fmtDays;
  const signCls = (v) => (v != null && v < 0) ? "neg" : "";

  // tiny inline SVG sparkline for a per-row trend; nulls break the line, a zero
  // baseline is drawn when the series crosses it. Normalised per row, so it shows
  // shape (rising / falling / volatile), not level.
  function spark(values, color) {
    const n = values.length;
    const pts = values.map((v, i) => [i, (v == null || !isFinite(v)) ? null : v]);
    const present = pts.filter((p) => p[1] != null);
    if (present.length < 2) return '<span class="small muted">–</span>';
    let mn = Math.min(...present.map((p) => p[1])), mx = Math.max(...present.map((p) => p[1]));
    if (mn === mx) { mn -= 1; mx += 1; }
    const w = 90, h = 24, pad = 3;
    const X = (i) => n <= 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
    const Y = (v) => h - pad - ((v - mn) / (mx - mn)) * (h - 2 * pad);
    let d = "", pen = false;
    pts.forEach(([i, v]) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; pen = true; });
    const last = present[present.length - 1];
    let base = "";
    if (mn < 0 && mx > 0) { const z = Y(0).toFixed(1); base = `<line x1="${pad}" y1="${z}" x2="${w - pad}" y2="${z}" stroke="#e3e3e3" stroke-width="1"/>`; }
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${base}` +
      `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="2" fill="${color}"/></svg>`;
  }

  // ================= RENDER =================================================
  function render(meta, rawRows, prov, mode) {
    const rows = SEC.withInstruments(rawRows);
    current = { meta, rows, prov, mode, raw: rawRows };
    $("bridge").classList.add("hidden");
    drop.classList.remove("await");
    $("results").classList.remove("hidden");

    // headline scorecard features the latest *complete* year (has revenue); a
    // balance-only trailing row (off-December fiscal years) shouldn't blank it.
    const complete = [...rows].reverse().find((r) => r.revenue != null) || rows[rows.length - 1];
    const last = complete;
    const yr = `${rows[0].fy}-${rows[rows.length - 1].fy}`;
    const cik = normalizeCik(meta.cik);
    const edgar = cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${SEC.cik10(cik)}&type=10-K` : null;
    $("companyHead").innerHTML = `
      <div class="companyhead">
        <div>
          <div class="name">${esc(meta.title)}${meta.ticker ? ` <span class="muted">(${esc(meta.ticker)})</span>` : ""}</div>
          <div class="sub">
            ${meta.sector ? `<span class="pill">${esc(meta.sector)}</span>` : ""}
            ${cik ? `<span class="mono">CIK ${SEC.cik10(cik)}</span> · ` : ""}FY ${yr} · ${rows.length} years
            · <span class="mode-tag ${esc(mode)}">${esc(mode)}</span>
          </div>
        </div>
        <div class="links">
          ${edgar ? `<a href="${edgar}" target="_blank" rel="noopener">10-Ks on EDGAR</a>` : ""}
          ${cik ? `<a href="${SEC.companyFactsUrl(cik)}" target="_blank" rel="noopener">companyfacts.json</a>` : ""}
        </div>
      </div>`;

    buildScorecard(last, rows);
    buildStatements(rows, prov, meta);
    buildInstruments(rows);
    buildForensics(rows);
    buildProvenance(prov, { ...meta, cik }, rows);
    initChart();
    showTab("statements");
  }

  // ---- scorecard: latest-year forensic verdicts ----------------------------
  function buildScorecard(last, rows) {
    const cards = [];
    const card = (k, v, label, tone, note) => cards.push(
      `<div class="verdict ${tone}"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="label">${label}</div><div class="vnote">${note}</div></div>`);

    const a = last.altman || {};
    card("Altman Z″", a.z != null ? N(a.z) : "–",
      a.zone ? a.zone + " zone" : "n/a", a.zone || "",
      a.z != null ? "Distress screen. >2.6 safe, 1.1–2.6 grey, &lt;1.1 distress." : "Needs balance-sheet items.");

    const b = last.beneish || {};
    card("Beneish M", b.m != null ? N(b.m) : "–",
      b.m != null ? (b.flag ? "manipulation risk" : "no flag") : "n/a",
      b.m == null ? "" : (b.flag ? "bad" : "good"),
      b.m != null ? "Earnings-manipulation score. Above −1.78 is a flag." : "Needs a prior year.");

    const f = last.piotroski || {};
    const fComplete = f.scored === 9;
    const fTone = f.f == null || !fComplete ? "" : (f.f >= 7 ? "good" : f.f <= 2 ? "bad" : "warn");
    card("Piotroski F", f.f != null ? `${f.f}/${f.scored}` : "–",
      f.f == null ? "n/a" : fComplete ? SEC.piotroskiVerdict(f.f) : "partial score", fTone,
      fComplete ? "Nine filing-based checks. Scores of 7+ are strong; 2 or less are weak." : "Some required inputs or the prior year are missing.");

    const ar = last.accruals_ratio;
    const arTone = ar == null ? "" : (ar <= 0 ? "good" : ar < 0.1 ? "warn" : "bad");
    card("Sloan accruals", ar != null ? P(ar) : "–",
      ar == null ? "n/a" : (ar <= 0 ? "cash-backed" : ar < 0.1 ? "positive accruals" : "high"), arTone,
      "(Net income − operating cash) ÷ average assets when a prior year is available.");

    card("FCF margin", last.fcf_margin != null ? P(last.fcf_margin) : "–",
      last.fcf != null ? U(last.fcf) + " free cash flow" : "n/a",
      last.fcf_margin == null ? "" : (last.fcf_margin >= 0 ? "good" : "bad"),
      "Operating cash flow minus capex, over revenue.");

    const investedCapital = last.equity != null
      ? last.equity + (last.total_debt || 0) - (last.cash || 0) : null;
    const roicComparable = investedCapital == null || investedCapital > 0;
    card("ROIC", last.roic != null ? P(last.roic) : "–",
      !roicComparable ? "negative invested capital" : last.roe != null ? "ROE " + P(last.roe) : "return on capital",
      last.roic == null ? "" : !roicComparable ? "warn" : (last.roic >= 0.1 ? "good" : last.roic >= 0 ? "warn" : "bad"),
      roicComparable ? "NOPAT ÷ invested capital. Compare it with the company's cost of capital."
        : "A negative denominator reverses the ratio's sign, so the percentage needs balance-sheet context.");

    $("scorecard").innerHTML = cards.join("");
    $("scoreLead").innerHTML =
      `Latest fiscal year with revenue: <b>FY ${last.fy}</b>. Open <b>Forensics</b> for the history and component
       breakdowns. Use <b>Provenance</b> to trace each reported input to its XBRL fact.`;
  }

  // ---- statements: raw line items, provenance on the cells -----------------
  const STMT = [
    ["Income statement", [
      ["revenue", "Revenue", U], ["cogs", "Cost of revenue", U], ["gross_profit", "Gross profit (reported)", U],
      ["sga", "SG&A", U], ["operating_income", "Operating income", U], ["dep_amort", "Depreciation & amort.", U],
      ["interest_expense", "Interest expense", U], ["pretax_income", "Pretax income", U],
      ["income_tax", "Income tax", U], ["net_income", "Net income", U],
    ]],
    ["Cash flow", [["operating_cash_flow", "Operating cash flow", U], ["capex", "Capex", U]]],
    ["Balance sheet", [
      ["cash", "Cash & equivalents", U], ["receivables", "Receivables", U], ["inventory", "Inventory", U],
      ["current_assets", "Current assets", U], ["ppe_net", "PP&E, net", U], ["total_assets", "Total assets", U],
      ["payables", "Payables", U], ["current_liabilities", "Current liabilities", U],
      ["short_term_debt", "Short-term debt", U], ["long_term_debt", "Long-term debt", U],
      ["total_liabilities", "Total liabilities", U], ["retained_earnings", "Retained earnings", U],
      ["equity", "Stockholders' equity", U],
    ]],
    ["Shares", [["shares_diluted", "Diluted shares (wtd)", (v) => v == null ? "–" : (v / 1e6).toFixed(0) + "M"],
      ["shares_out", "Shares outstanding", (v) => v == null ? "–" : (v / 1e6).toFixed(0) + "M"]]],
  ];

  function buildStatements(rows, prov, meta) {
    const years = rows.map((r) => r.fy);
    let h = `<div class="tablewrap"><table class="dense"><thead><tr><th>Line item</th>${years.map((y) => `<th>${y}</th>`).join("")}<th class="sparkhead">Trend</th></tr></thead><tbody>`;
    STMT.forEach(([group, items]) => {
      h += `<tr class="rowgroup"><th>${group}</th>${years.map(() => "<td></td>").join("")}<td></td></tr>`;
      items.forEach(([key, label, fmt]) => {
        h += `<tr><th>${label}</th>`;
        rows.forEach((r) => {
          const v = r[key];
          const pm = prov[key] && prov[key][r.fy];
          const cls = "prov " + signCls(v);
          const tip = pm ? `${pm.tag} · ${pm.frame || pm.form || ""} · ${pm.end || ""}` : "Not reported for this year";
          h += `<td class="${cls}" title="${esc(tip)}">${fmt(v)}</td>`;
        });
        h += `<td class="sparkcell">${spark(rows.map((r) => r[key]), PALETTE.blue)}</td></tr>`;
      });
    });
    h += "</tbody></table></div>";
    $("stmtWrap").innerHTML = h;
    $("stmtNote").innerHTML = `Reported line items, organized by calendar-year frame. Hover a populated cell to see
      its us-gaap tag, frame or form, and period end. "Gross profit (reported)" stays blank when the filer does not
      report that tag; calculated gross margin can still use revenue minus cost of revenue.`;
  }

  // ---- instruments: the computed analytics ---------------------------------
  const INST = [
    ["Growth & margin", [
      ["rev_growth", "Revenue growth", P], ["gross_margin", "Gross margin", P], ["op_margin", "Operating margin", P],
      ["net_margin", "Net margin", P], ["fcf_margin", "FCF margin", P], ["capex_intensity", "Capex / revenue", P],
    ]],
    ["Returns", [["roa", "Return on assets", P], ["roe", "Return on equity", P], ["roic", "ROIC", P]]],
    ["Liquidity & leverage", [
      ["current_ratio", "Current ratio", N], ["debt_to_equity", "Debt / equity", N], ["total_debt", "Total debt", U],
    ]],
    ["Working capital (days)", [
      ["dio", "Days inventory (DIO)", D], ["dso", "Days sales out. (DSO)", D],
      ["dpo", "Days payable (DPO)", D], ["ccc", "Cash conversion cycle", D],
    ]],
    ["Cash", [["fcf", "Free cash flow", U], ["operating_cash_flow", "Operating cash flow", U]]],
  ];

  function buildInstruments(rows) {
    const years = rows.map((r) => r.fy);
    let h = `<div class="tablewrap"><table class="dense"><thead><tr><th>Instrument</th>${years.map((y) => `<th>${y}</th>`).join("")}<th class="sparkhead">Trend</th></tr></thead><tbody>`;
    INST.forEach(([group, items]) => {
      h += `<tr class="rowgroup"><th>${group}</th>${years.map(() => "<td></td>").join("")}<td></td></tr>`;
      items.forEach(([key, label, fmt]) => {
        h += `<tr><th>${label}</th>`;
        rows.forEach((r) => { const v = r[key]; h += `<td class="${signCls(v)}">${fmt(v)}</td>`; });
        h += `<td class="sparkcell">${spark(rows.map((r) => r[key]), PALETTE.teal)}</td></tr>`;
      });
    });
    h += "</tbody></table></div>";
    $("instWrap").innerHTML = h;
  }

  // ---- forensics: the screens over time, with components -------------------
  function buildForensics(rows) {
    const years = rows.map((r) => r.fy);
    const flag = (txt, tone) => `<span class="flagcell ${tone}">${txt}</span>`;

    // Altman Z'' table
    let za = `<h3 class="fsub">Altman Z″: distance to distress</h3>
      <div class="tablewrap"><table class="dense"><thead><tr><th>Component</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr></thead><tbody>`;
    const arows = [
      ["x1 · working capital / assets", (r) => r.altman && r.altman.x1 != null ? N(r.altman.x1) : "–"],
      ["x2 · retained earnings / assets", (r) => r.altman && r.altman.x2 != null ? N(r.altman.x2) : "–"],
      ["x3 · EBIT / assets", (r) => r.altman && r.altman.x3 != null ? N(r.altman.x3) : "–"],
      ["x4 · equity / liabilities", (r) => r.altman && r.altman.x4 != null ? N(r.altman.x4) : "–"],
    ];
    arows.forEach(([lab, fn]) => { za += `<tr><th>${lab}</th>${rows.map((r) => `<td>${fn(r)}</td>`).join("")}</tr>`; });
    za += `<tr><th>Z″ score</th>${rows.map((r) => `<td><b>${r.altman && r.altman.z != null ? N(r.altman.z) : "–"}</b></td>`).join("")}</tr>`;
    za += `<tr><th>Zone</th>${rows.map((r) => {
      const z = r.altman || {}; const t = z.zone === "safe" ? "good" : z.zone === "grey" ? "warn" : z.zone === "distress" ? "bad" : "";
      return `<td>${z.zone ? flag(z.zone, t) : "–"}</td>`; }).join("")}</tr></tbody></table></div>`;

    // Beneish M table
    let bm = `<h3 class="fsub">Beneish M: earnings-manipulation screen</h3>
      <div class="tablewrap"><table class="dense"><thead><tr><th>Index</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr></thead><tbody>`;
    const bkeys = [["DSRI", "Days sales in receivables"], ["GMI", "Gross margin"], ["AQI", "Asset quality"],
      ["SGI", "Sales growth"], ["DEPI", "Depreciation"], ["SGAI", "SG&A"], ["LVGI", "Leverage"], ["TATA", "Total accruals"]];
    bkeys.forEach(([k, lab]) => {
      bm += `<tr><th>${k} · ${lab}</th>${rows.map((r) => {
        const p = r.beneish && r.beneish.parts; return `<td>${p && p[k] != null ? N(p[k]) : "–"}</td>`; }).join("")}</tr>`;
    });
    bm += `<tr><th>M score</th>${rows.map((r) => `<td><b>${r.beneish && r.beneish.m != null ? N(r.beneish.m) : "–"}</b></td>`).join("")}</tr>`;
    bm += `<tr><th>Verdict</th>${rows.map((r) => {
      const m = r.beneish || {}; if (m.m == null) return "<td>–</td>";
      return `<td>${flag(m.flag ? "flag" : "clean", m.flag ? "bad" : "good")}</td>`; }).join("")}</tr></tbody></table></div>`;

    // Piotroski + Sloan summary
    let pf = `<h3 class="fsub">Piotroski F &amp; Sloan accruals</h3>
      <div class="tablewrap"><table class="dense"><thead><tr><th>Metric</th>${years.map((y) => `<th>${y}</th>`).join("")}</tr></thead><tbody>`;
    pf += `<tr><th>Piotroski F (0–9)</th>${rows.map((r) => {
      const f = r.piotroski || {}; if (f.f == null) return "<td>–</td>";
      const t = f.scored !== 9 ? "partial" : f.f >= 7 ? "good" : f.f <= 2 ? "bad" : "warn";
      return `<td>${flag(f.f + "/" + f.scored, t)}</td>`; }).join("")}</tr>`;
    pf += `<tr><th>Accruals ratio</th>${rows.map((r) => {
      const v = r.accruals_ratio; if (v == null) return "<td>–</td>";
      const t = v <= 0 ? "good" : v < 0.1 ? "warn" : "bad"; return `<td>${flag(P(v), t)}</td>`; }).join("")}</tr>`;
    pf += "</tbody></table></div>";

    $("forensicsWrap").innerHTML = za + bm + pf +
      `<p class="small muted" style="margin-top:12px">Z″ uses the four-factor model based on book equity, so it does
       not require market capitalization. Beneish needs a prior year. Piotroski shows a partial denominator when prior-year
       or filing inputs are missing. These are screening tools. A flag identifies a question to investigate, not a conclusion.</p>`;
    buildForensicCharts(rows);
  }

  // ---- forensic trajectory mini-charts (with threshold bands) --------------
  function miniChart(canvasId, label, labels, data, opts) {
    if (!window.Chart) return;
    const key = canvasId.replace("Chart", "");
    if (fcharts[key]) fcharts[key].destroy();
    fcharts[key] = new Chart($(canvasId), {
      type: opts.type || "line",
      data: { labels, datasets: [Object.assign({ label, data, spanGaps: true }, opts.dataset || {})] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: opts.title, color: PALETTE.ink, font: { size: 11.5 } },
          tooltip: { callbacks: { label: (ctx) => " " + label + ": " + (ctx.parsed.y == null ? "–" : ctx.parsed.y.toFixed(2)) } },
          bands: opts.bands ? { ranges: opts.bands } : undefined,
        },
        scales: { x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0, autoSkipPadding: 8 } },
          y: Object.assign({ grid: { color: "#eee" }, ticks: { font: { size: 10 } } }, opts.y || {}) },
      },
    });
  }

  function buildForensicCharts(rows) {
    const labels = rows.map((r) => r.fy);
    const z = rows.map((r) => (r.altman && r.altman.z != null) ? +r.altman.z.toFixed(2) : null);
    const zv = z.filter((v) => v != null);
    miniChart("altmanChart", "Altman Z″", labels, z, {
      title: "Altman Z″: green safe, amber grey, red distress",
      dataset: { borderColor: PALETTE.ink, backgroundColor: "transparent", borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: PALETTE.ink, tension: 0.2 },
      bands: [
        { from: -1000, to: 1.1, color: "rgba(176,71,43,.10)" },
        { from: 1.1, to: 2.6, color: "rgba(154,122,46,.11)" },
        { from: 2.6, to: 1000, color: "rgba(63,107,84,.12)" },
      ],
      y: { suggestedMin: Math.min(0, ...zv), suggestedMax: Math.max(3, ...zv) },
    });
    const m = rows.map((r) => (r.beneish && r.beneish.m != null) ? +r.beneish.m.toFixed(2) : null);
    const mv = m.filter((v) => v != null);
    miniChart("beneishChart", "Beneish M", labels, m, {
      title: "Beneish M: above −1.78 enters the flagged range",
      dataset: { borderColor: PALETTE.rust, backgroundColor: "transparent", borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: PALETTE.rust, tension: 0.2 },
      bands: [
        { from: -1.78, to: 1000, color: "rgba(176,71,43,.10)" },
        { from: -1000, to: -1.78, color: "rgba(63,107,84,.08)" },
      ],
      y: { suggestedMin: Math.min(-3, ...mv), suggestedMax: Math.max(0, ...mv) },
    });
    const f = rows.map((r) => (r.piotroski && r.piotroski.f != null) ? r.piotroski.f : null);
    const fc = rows.map((r) => {
      const f = r.piotroski || {};
      return f.f == null || f.scored !== 9 ? PALETTE.gray : f.f >= 7 ? PALETTE.green : f.f <= 2 ? PALETTE.rust : PALETTE.gold;
    });
    miniChart("piotroskiChart", "Piotroski F", labels, f, {
      type: "bar",
      title: "Piotroski F: filing-based signals, 0–9",
      dataset: { backgroundColor: fc, borderWidth: 0 },
      y: { min: 0, max: 9, ticks: { stepSize: 3, font: { size: 10 } } },
    });
  }

  // ---- provenance audit ----------------------------------------------------
  function buildProvenance(prov, meta, rows) {
    const visibleYears = new Set(rows.map((r) => String(r.fy)));
    const concepts = Object.keys(prov).filter((c) =>
      Object.keys(prov[c] || {}).some((y) => visibleYears.has(y)));
    const sel = $("provSel");
    sel.innerHTML = concepts.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    sel.disabled = !concepts.length;
    const draw = () => {
      if (!concepts.length) {
        $("provWrap").innerHTML = '<p class="small muted" style="padding:12px">No provenance records were extracted.</p>';
        return;
      }
      const key = sel.value, map = prov[key] || {};
      const yrs = Object.keys(map).filter((y) => visibleYears.has(y)).sort();
      let h = `<table class="dense provtable"><thead><tr><th>FY</th><th>us-gaap tag</th><th>Frame</th><th>Form</th><th>Period end</th><th>Filing</th></tr></thead><tbody>`;
      yrs.forEach((y) => {
        const m = map[y];
        const accession = String(m.accn || "");
        const validAccession = /^\d{10}-\d{2}-\d{6}$/.test(accession);
        const accNoDash = validAccession ? accession.replace(/-/g, "") : "";
        const link = (validAccession && meta.cik)
          ? `<a href="https://www.sec.gov/Archives/edgar/data/${Number(meta.cik)}/${accNoDash}/" target="_blank" rel="noopener">${esc(m.accn)}</a>`
          : esc(m.accn || "–");
        h += `<tr><th>${esc(y)}</th><td class="xtag">${esc(m.tag)}</td><td class="frame">${esc(m.frame || "–")}</td>
          <td class="form">${esc(m.form || "–")}</td><td class="frame">${esc(m.end || "–")}</td><td class="small">${link}</td></tr>`;
      });
      h += "</tbody></table>";
      $("provWrap").innerHTML = h;
    };
    sel.onchange = draw;
    draw();
  }

  // ---- chart: interactive multi-metric overlay -----------------------------
  // Each metric declares a unit; the chart puts the first two distinct units on
  // a left and right axis, draws dollars as bars and rates/ratios as lines, and
  // hides any metric whose unit isn't on either axis (so a plot never mixes
  // three incomparable scales). All values come from current.rows (instruments
  // already computed in sec.js); nothing is recomputed here.
  const METRICS = {
    revenue:            { label: "Revenue",              unit: "usd",  kind: "bar",  color: PALETTE.blue,   v: (r) => r.revenue },
    operating_income:   { label: "Operating income",     unit: "usd",  kind: "bar",  color: PALETTE.ink,    v: (r) => r.operating_income },
    net_income:         { label: "Net income",           unit: "usd",  kind: "bar",  color: PALETTE.green,  v: (r) => r.net_income },
    fcf:                { label: "Free cash flow",        unit: "usd",  kind: "bar",  color: PALETTE.gold,   v: (r) => r.fcf },
    operating_cash_flow:{ label: "Operating cash flow",   unit: "usd",  kind: "bar",  color: PALETTE.teal,   v: (r) => r.operating_cash_flow },
    rev_growth:         { label: "Revenue growth",        unit: "pct",  kind: "line", color: PALETTE.blue,   v: (r) => r.rev_growth },
    gross_margin:       { label: "Gross margin",          unit: "pct",  kind: "line", color: PALETTE.teal,   v: (r) => r.gross_margin },
    op_margin:          { label: "Operating margin",      unit: "pct",  kind: "line", color: PALETTE.ink,    v: (r) => r.op_margin },
    net_margin:         { label: "Net margin",            unit: "pct",  kind: "line", color: PALETTE.rust,   v: (r) => r.net_margin },
    fcf_margin:         { label: "FCF margin",            unit: "pct",  kind: "line", color: PALETTE.gold,   v: (r) => r.fcf_margin },
    capex_intensity:    { label: "Capex / revenue",       unit: "pct",  kind: "line", color: PALETTE.violet, v: (r) => r.capex_intensity },
    roa:                { label: "ROA",                   unit: "pct",  kind: "line", color: PALETTE.teal,   v: (r) => r.roa },
    roe:                { label: "ROE",                   unit: "pct",  kind: "line", color: PALETTE.violet, v: (r) => r.roe },
    roic:               { label: "ROIC",                  unit: "pct",  kind: "line", color: PALETTE.green,  v: (r) => r.roic },
    ccc:                { label: "Cash conversion cycle", unit: "days", kind: "bar",  color: PALETTE.rust,   v: (r) => r.ccc },
    current_ratio:      { label: "Current ratio",         unit: "x",    kind: "line", color: PALETTE.blue,   v: (r) => r.current_ratio },
    debt_to_equity:     { label: "Debt / equity",         unit: "x",    kind: "line", color: PALETTE.ink,    v: (r) => r.debt_to_equity },
  };
  const PRESETS = {
    growth:        ["revenue", "rev_growth"],
    profitability: ["gross_margin", "op_margin", "net_margin"],
    returns:       ["roic", "roe", "roa"],
    cash:          ["fcf", "operating_cash_flow", "fcf_margin"],
    leverage:      ["debt_to_equity", "current_ratio"],
  };
  const UNIT_NAME = { usd: "US$ billions", pct: "percent", days: "days", x: "ratio (×)" };
  const scaleU = (u, v) => (v == null || !isFinite(v)) ? null : (u === "usd" ? v / 1e9 : u === "pct" ? v * 100 : v);
  const tickU = (u) => (u === "usd") ? ((v) => "$" + v + "B") : (u === "pct") ? ((v) => v + "%") : (u === "days") ? ((v) => v + "d") : ((v) => v + "×");
  const fmtU = (u, v) => (v == null) ? "–" : (u === "usd") ? "$" + v.toFixed(1) + "B" : (u === "pct") ? v.toFixed(1) + "%" : (u === "days") ? Math.round(v) + " days" : v.toFixed(2) + "×";
  let activeMetrics = new Set(PRESETS.growth);

  function initChart() {
    document.querySelectorAll("#chartModes .seg").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll("#chartModes .seg").forEach((b) => {
          const active = b === btn;
          b.classList.toggle("active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        activeMetrics = new Set(PRESETS[btn.dataset.preset]);
        renderChips(); drawChart();
      };
      btn.setAttribute("aria-pressed", String(btn.classList.contains("active")));
    });
    renderChips();
    drawChart();
  }

  function renderChips() {
    const wrap = $("metricChips");
    wrap.innerHTML = "";
    Object.entries(METRICS).forEach(([key, m]) => {
      const c = document.createElement("span");
      c.className = "mchip" + (activeMetrics.has(key) ? " on" : "");
      c.dataset.key = key;
      c.innerHTML = `<span class="dot" style="background:${m.color}"></span>${m.label}`;
      c.title = m.label + " · " + UNIT_NAME[m.unit];
      c.setAttribute("aria-pressed", String(activeMetrics.has(key)));
      onActivate(c, () => {
        if (activeMetrics.has(key)) activeMetrics.delete(key); else activeMetrics.add(key);
        document.querySelectorAll("#chartModes .seg").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-pressed", "false");
        });
        renderChips(); drawChart();
      });
      wrap.appendChild(c);
    });
  }

  function drawChart() {
    if (!current) return;
    if (!window.Chart) {
      $("chartHint").textContent = "Charts are unavailable because Chart.js did not load. Tables remain available.";
      return;
    }
    const rows = current.rows, labels = rows.map((r) => r.fy);
    const active = Object.keys(METRICS).filter((k) => activeMetrics.has(k));
    const units = [];
    active.forEach((k) => { const u = METRICS[k].unit; if (!units.includes(u)) units.push(u); });
    const leftU = units[0], rightU = units[1];
    const blocked = new Set(), datasets = [];
    active.forEach((k) => {
      const m = METRICS[k], u = m.unit;
      if (u !== leftU && u !== rightU) { blocked.add(k); return; }
      const ds = { label: m.label, data: rows.map((r) => scaleU(u, m.v(r))), yAxisID: (u === leftU ? "yL" : "yR"), _unit: u, borderColor: m.color, spanGaps: true };
      if (m.kind === "bar") { ds.type = "bar"; ds.backgroundColor = m.color + "cc"; ds.borderWidth = 0; ds.categoryPercentage = 0.82; ds.barPercentage = 0.92; }
      else { ds.type = "line"; ds.backgroundColor = "transparent"; ds.borderWidth = 2; ds.pointRadius = 2.4; ds.pointBackgroundColor = m.color; ds.tension = 0.25; }
      datasets.push(ds);
    });
    document.querySelectorAll("#metricChips .mchip").forEach((chip) => chip.classList.toggle("blocked", blocked.has(chip.dataset.key)));

    const hint = $("chartHint");
    if (!leftU) hint.textContent = "Pick one or more metrics to plot.";
    else hint.innerHTML = `Left axis: <b>${UNIT_NAME[leftU]}</b>` + (rightU ? ` · right axis: <b>${UNIT_NAME[rightU]}</b>` : "") +
      (blocked.size ? ` · <span style="color:var(--rust)">${blocked.size} hidden because the chart supports two unit types at once</span>` : "");

    const scales = {
      x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 10 } },
      yL: { type: "linear", position: "left", grid: { color: "#eee" },
        title: { display: !!leftU, text: leftU ? UNIT_NAME[leftU] : "" },
        ticks: { font: { size: 11 }, callback: (v) => leftU ? tickU(leftU)(v) : v } },
    };
    if (rightU) scales.yR = { type: "linear", position: "right", grid: { drawOnChartArea: false },
      title: { display: true, text: UNIT_NAME[rightU] }, ticks: { font: { size: 11 }, callback: (v) => tickU(rightU)(v) } };

    if (chart) chart.destroy();
    chart = new Chart($("chart"), {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 12 } } },
          tooltip: { callbacks: { label: (ctx) => " " + ctx.dataset.label + ": " + fmtU(ctx.dataset._unit, ctx.parsed.y) } },
          title: { display: true, text: (current.meta.ticker || current.meta.title) + " · financial trends", color: PALETTE.ink, font: { size: 13 } },
        },
        scales,
      },
    });
  }

  // ---- tabs ----------------------------------------------------------------
  function showTab(name) {
    document.querySelectorAll(".tabpanel").forEach((p) => {
      const active = p.dataset.tab === name;
      p.classList.toggle("active", active);
      p.hidden = !active;
    });
    document.querySelectorAll(".tabbar button").forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
      b.tabIndex = active ? 0 : -1;
    });
    // the forensic charts are built while their panel is hidden (zero-size canvas);
    // resize once the panel is visible so Chart.js lays them out correctly.
    if (name === "forensics") setTimeout(() => Object.values(fcharts).forEach((c) => c && c.resize()), 30);
  }
  const tabButtons = [...document.querySelectorAll(".tabbar button")];
  tabButtons.forEach((b, i) => {
    b.onclick = () => showTab(b.dataset.tab);
    b.onkeydown = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      let next = i;
      if (e.key === "ArrowLeft") next = (i - 1 + tabButtons.length) % tabButtons.length;
      if (e.key === "ArrowRight") next = (i + 1) % tabButtons.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = tabButtons.length - 1;
      showTab(tabButtons[next].dataset.tab);
      tabButtons[next].focus();
    };
  });

  // ---- deep link: ?ticker= / ?cik= -----------------------------------------
  (async () => {
    const params = new URLSearchParams(location.search);
    const ticker = (params.get("ticker") || "").trim().toUpperCase();
    const cik = (params.get("cik") || "").trim();
    const name = params.get("name");
    if (!ticker && !cik) return;
    await indexReady;
    if (ticker) {
      const b = currentIndex.find((c) => c.ticker === ticker);
      if (b) return loadBundled(b);
    }
    if (cik) return resolveAndLoad({ ticker, cik, title: name || ticker });
    setStatus(`${ticker} is not bundled. Search for it, or load its companyfacts.json below.`, true);
  })();
})();
