/* dissector.js - build a time series from a filing and compute instruments. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
  const status = $("status");
  const setStatus = (m, err) => { status.textContent = m || ""; status.className = "status" + (err ? " err" : ""); };
  let chart = null, current = null;

  const PALETTE = { blue: "#2f5d7c", rust: "#b0472b", ink: "#1c1c1c", mid: "#7a7a7a", gray: "#c7c7c7" };

  // bundled chips
  SEC.bundledIndex().then((idx) => {
    idx.forEach((c) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip"; chip.textContent = c.ticker;
      chip.title = c.title;
      chip.onclick = () => loadBundled(c.ticker);
      $("bundled").appendChild(chip);
    });
  }).catch(() => setStatus("Could not load the bundled company index.", true));

  async function loadBundled(ticker) {
    setStatus(`Loading ${ticker}...`);
    try {
      const data = await SEC.loadBundled(ticker);
      render(data.title, ticker, data.rows, "bundled");
      setStatus("");
    } catch (e) { setStatus("Load failed: " + e.message, true); }
  }

  // file drop / picker
  const drop = $("drop"), file = $("file");
  drop.addEventListener("click", (e) => {
    if (e.target === file || e.target.closest("a")) return;
    file.click();
  });
  file.onchange = () => {
    if (file.files[0]) readFile(file.files[0]);
    file.value = "";
  };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove("drag");
  }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  function readFile(f) {
    setStatus(`Parsing ${f.name}...`);
    const reader = new FileReader();
    reader.onload = () => {
      let facts;
      try { facts = JSON.parse(reader.result); }
      catch { return setStatus("That file is not valid JSON.", true); }
      if (!facts.facts || !facts.facts["us-gaap"]) {
        return setStatus("This does not look like a SEC companyfacts.json (no facts.us-gaap).", true);
      }
      let rows;
      try { rows = SEC.extractRows(facts); }
      catch (e) { return setStatus("Could not extract an annual series: " + e.message, true); }
      if (!rows.length) return setStatus("No annual series could be extracted from this file.", true);
      const name = facts.entityName || f.name.replace(/\.json$/i, "");
      render(name, "", rows, "upload");
      setStatus("");
    };
    reader.onerror = () => setStatus(`Could not read ${f.name}.`, true);
    reader.readAsText(f);
  }

  const fmtB = (v) => typeof v !== "number" || !Number.isFinite(v) ? "–" : (v / 1e9).toFixed(1);
  const fmtPct = (v) => typeof v !== "number" || !Number.isFinite(v) ? "–" : (v * 100).toFixed(1) + "%";
  const fmtD = (v) => typeof v !== "number" || !Number.isFinite(v) ? "–" : Math.round(v);

  function render(name, ticker, rawRows, mode) {
    const rows = SEC.withInstruments(rawRows);
    current = { name, ticker, rows, mode };
    $("bridge").classList.add("hidden");      // a file loaded; retire any download prompt
    drop.classList.remove("await");
    $("results").classList.remove("hidden");
    $("resTitle").textContent = name + (ticker ? ` (${ticker})` : "");

    const last = [...rows].reverse().find((r) => r.revenue != null) || rows[rows.length - 1];
    const cards = [
      ["Latest FY", last.fy, false],
      ["Revenue", SEC.fmtUSD(last.revenue), false],
      ["Operating margin", fmtPct(last.op_margin), last.op_margin < 0],
      ["Net income", SEC.fmtUSD(last.net_income), last.net_income < 0],
      ["Capex intensity", fmtPct(last.capex_intensity), false],
      ["Cash conversion cycle", last.ccc != null ? fmtD(last.ccc) + " days" : "–", last.ccc < 0],
    ];
    $("metrics").innerHTML = cards.map(([k, v, neg]) =>
      `<div class="metric"><div class="v${neg ? " neg" : ""}">${v}</div><div class="k">${k}</div></div>`).join("");

    buildTable(rows);
    drawChart($("metricSel").value);
    $("srcNote").textContent = mode === "bundled"
      ? "Source: bundled output from the same extraction rules used for uploaded SEC companyfacts.json files."
      : "Source: the companyfacts.json file loaded in this browser. Annual facts use us-gaap tags and calendar-year frames when available.";
  }

  function buildTable(rows) {
    const head = ["FY", "Revenue", "Op income", "Op margin", "Net income", "Capex", "Capex/Rev", "OCF", "DIO", "DSO", "DPO", "CCC"];
    let h = "<table><thead><tr>" + head.map((x) => `<th>${x}</th>`).join("") + "</tr></thead><tbody>";
    rows.forEach((r) => {
      const cell = (v, cls) => `<td class="${cls || ""}">${v}</td>`;
      const negc = (v) => (v != null && v < 0) ? "neg" : "";
      h += "<tr>" +
        cell(r.fy) +
        cell(SEC.fmtUSD(r.revenue)) +
        cell(SEC.fmtUSD(r.operating_income), negc(r.operating_income)) +
        cell(fmtPct(r.op_margin), negc(r.op_margin)) +
        cell(SEC.fmtUSD(r.net_income), negc(r.net_income)) +
        cell(SEC.fmtUSD(r.capex)) +
        cell(fmtPct(r.capex_intensity)) +
        cell(SEC.fmtUSD(r.operating_cash_flow)) +
        cell(fmtD(r.dio)) + cell(fmtD(r.dso)) + cell(fmtD(r.dpo)) +
        cell(r.ccc != null ? fmtD(r.ccc) : "–", negc(r.ccc)) +
        "</tr>";
    });
    h += "</tbody></table>";
    $("tablewrap").innerHTML = h;
  }

  const METRICS = {
    revenue: { label: "Revenue ($B)", val: (r) => r.revenue == null ? null : r.revenue / 1e9, type: "bar", color: PALETTE.blue },
    op_margin: { label: "Operating margin (%)", val: (r) => r.op_margin == null ? null : r.op_margin * 100, type: "line", color: PALETTE.ink },
    net_income: { label: "Net income ($B)", val: (r) => r.net_income == null ? null : r.net_income / 1e9, type: "bar", color: PALETTE.blue },
    capex_intensity: { label: "Capex intensity (% of revenue)", val: (r) => r.capex_intensity == null ? null : r.capex_intensity * 100, type: "line", color: PALETTE.rust },
    ccc: { label: "Cash conversion cycle (days)", val: (r) => r.ccc == null ? null : r.ccc, type: "bar", color: PALETTE.rust },
  };

  const LESSON = {
    revenue: "Read revenue growth beside margins and cash flow. Growth can improve unit economics, or conceal deterioration.",
    op_margin: "Operating margin shows how much revenue remains after operating costs. Check whether changes persist across several filings.",
    net_income: "Compare net income with operating cash flow. A widening gap deserves a review of accruals and the cash-flow statement.",
    capex_intensity: "Capex intensity shows how much revenue is being reinvested in long-lived assets. The filing is needed to judge what that spending bought.",
    ccc: "A negative cash conversion cycle means the company collects cash before it pays suppliers. Confirm which working-capital line is driving the result.",
  };

  $("metricSel").onchange = () => drawChart($("metricSel").value);

  function drawChart(key) {
    if (!current) return;
    if (!window.Chart) {
      $("lessonNote").textContent = "The chart is unavailable because Chart.js did not load. The table remains available.";
      return;
    }
    const m = METRICS[key], rows = current.rows;
    const labels = rows.map((r) => r.fy);
    const data = rows.map(m.val);
    const colors = data.map((v) => (key === "ccc" || key === "net_income") && v != null && v < 0 ? PALETTE.rust : m.color);
    if (chart) chart.destroy();
    chart = new Chart($("chart"), {
      type: m.type,
      data: { labels, datasets: [{
        label: m.label, data,
        backgroundColor: m.type === "bar" ? colors : "rgba(47,93,124,.08)",
        borderColor: m.color, borderWidth: m.type === "line" ? 2 : 0,
        pointRadius: m.type === "line" ? 3 : 0, tension: .2, spanGaps: true,
      }] },
      options: {
        responsive: true, plugins: { legend: { display: false },
          title: { display: true, text: `${current.name} · ${m.label}`, color: PALETTE.ink, font: { size: 14 } } },
        scales: { x: { grid: { display: false } }, y: { grid: { color: "#eee" }, beginAtZero: false } },
      },
    });
    $("lessonNote").innerHTML = `<b>Reading it:</b> ${esc(LESSON[key])}`;
  }

  // When the Finder hands us a company it doesn't have bundled, we can't fetch it
  // ourselves: the SEC XBRL API sends no CORS header, so the browser blocks it.
  // Turn that dead end into a two-step prompt: download the file, then load it here.
  function showBridge({ ticker, cik, name }) {
    const cleanCik = String(cik || "").trim();
    if (!/^\d{1,10}$/.test(cleanCik)) return setStatus("This link does not contain a valid CIK.", true);
    const label = name || ticker || `CIK ${cleanCik}`;
    const factsUrl = SEC.companyFactsUrl(cleanCik);
    const dl = ticker ? `${ticker}'s` : "the";
    $("bridge").innerHTML = `
      <div class="note warn" style="margin-top:0">
        <b>${esc(label)}</b> is not bundled. The SEC XBRL endpoint does not let this page read
        the response directly:
        <ol class="bridge-steps">
          <li><a class="btn" href="${factsUrl}" target="_blank" rel="noopener">Open ${esc(dl)} companyfacts.json</a>
            <span class="small muted" style="margin-left:8px">Save the JSON file from sec.gov.</span></li>
          <li>Load the saved file below. Parsing stays in your browser.</li>
        </ol>
      </div>`;
    $("bridge").classList.remove("hidden");
    drop.classList.add("await");
    setStatus("");
  }

  // Deep link: ?ticker=AMZN loads a bundled company instantly; anything the Finder sends
  // with a &cik= falls back to the download-and-drop bridge above.
  (async () => {
    const params = new URLSearchParams(location.search);
    const ticker = (params.get("ticker") || "").trim().toUpperCase();
    const cik = (params.get("cik") || "").trim();
    const name = params.get("name");
    if (!ticker && !cik) return;
    if (ticker) {
      try {
        const data = await SEC.loadBundled(ticker);
        render(data.title, ticker, data.rows, "bundled");
        return setStatus("");
      } catch (_) { /* not bundled; fall through to the bridge */ }
    }
    if (cik) showBridge({ ticker, cik, name });
    else setStatus(`${ticker} is not bundled. Find it in the Report Finder, then load its companyfacts.json here.`, true);
  })();
})();
