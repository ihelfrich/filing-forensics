/* dissector.js - build a time series from a filing and compute instruments. */
(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const setStatus = (m, err) => { status.textContent = m || ""; status.className = "status" + (err ? " err" : ""); };
  let chart = null, current = null;

  const PALETTE = { blue: "#2f5d7c", rust: "#b0472b", ink: "#1c1c1c", mid: "#7a7a7a", gray: "#c7c7c7" };

  // bundled chips
  SEC.bundledIndex().then((idx) => {
    idx.forEach((c) => {
      const chip = document.createElement("span");
      chip.className = "chip"; chip.textContent = c.ticker;
      chip.title = c.title;
      chip.onclick = () => loadBundled(c.ticker);
      $("bundled").appendChild(chip);
    });
  }).catch(() => setStatus("Could not load the bundled company index.", true));

  async function loadBundled(ticker) {
    setStatus(`Loading ${ticker} …`);
    try {
      const data = await SEC.loadBundled(ticker);
      render(data.title, ticker, data.rows, "bundled");
      setStatus("");
    } catch (e) { setStatus("Load failed: " + e.message, true); }
  }

  // file drop / picker
  const drop = $("drop"), file = $("file");
  drop.onclick = () => file.click();
  file.onchange = () => file.files[0] && readFile(file.files[0]);
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
    setStatus(`Parsing ${f.name} …`);
    const reader = new FileReader();
    reader.onload = () => {
      let facts;
      try { facts = JSON.parse(reader.result); }
      catch { return setStatus("That file is not valid JSON.", true); }
      if (!facts.facts || !facts.facts["us-gaap"]) {
        return setStatus("This does not look like a SEC companyfacts.json (no facts.us-gaap).", true);
      }
      const rows = SEC.extractRows(facts);
      if (!rows.length) return setStatus("No annual series could be extracted from this file.", true);
      const name = facts.entityName || f.name.replace(/\.json$/i, "");
      render(name, "", rows, "upload");
      setStatus("");
    };
    reader.readAsText(f);
  }

  const fmtB = (v) => v == null ? "–" : (v / 1e9).toFixed(1);
  const fmtPct = (v) => v == null ? "–" : (v * 100).toFixed(1) + "%";
  const fmtD = (v) => v == null ? "–" : Math.round(v);

  function render(name, ticker, rawRows, mode) {
    const rows = SEC.withInstruments(rawRows);
    current = { name, ticker, rows, mode };
    $("results").classList.remove("hidden");
    $("resTitle").textContent = name + (ticker ? ` (${ticker})` : "");

    const last = rows[rows.length - 1];
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
    $("srcNote").innerHTML = mode === "bundled"
      ? "Source: pre-extracted from this company's SEC companyfacts.json (us-gaap concepts, calendar-year frames). Same logic the upload mode runs in your browser."
      : "Source: the companyfacts.json you loaded, parsed in your browser. Concepts mapped to us-gaap tags; calendar-year frames used to dedupe restatements.";
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
    revenue: "Revenue growth is the flywheel made visible (lesson 4). Compounding scale is what makes the loop hard to copy.",
    op_margin: "Thin, steady operating margins are lesson 3: Amazon ran near breakeven on purpose for years to buy share, betting on the long term.",
    net_income: "Net income that dips and recovers (the 2022 loss, then the snap back) is lesson 3: losses by design, with owners who sit through them.",
    capex_intensity: "Heavy, rising capex is lesson 1: the cost of building capabilities (warehouses, AWS, chips) before renting them out.",
    ccc: "A negative cash conversion cycle is the engine under lesson 3: customers pay first, suppliers are paid later, so growth funds itself.",
  };

  $("metricSel").onchange = () => drawChart($("metricSel").value);

  function drawChart(key) {
    if (!current) return;
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
    $("lessonNote").innerHTML = `<b>Reading it:</b> ${LESSON[key]}`;
  }

  // deep link ?ticker=AMZN
  const params = new URLSearchParams(location.search);
  const t = params.get("ticker");
  if (t) loadBundled(t.toUpperCase());
})();
