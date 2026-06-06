/* finder.js - Report Finder. Live against data.sec.gov/submissions (CORS OK). */
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
  const status = $("status");
  const setStatus = (msg, err) => { status.textContent = msg || ""; status.className = "status" + (err ? " err" : ""); };
  let loaded = null;

  const PICKS = ["AMZN", "WMT", "MSFT", "GOOGL", "FDX", "UPS", "TGT"];
  PICKS.forEach((t) => {
    const c = document.createElement("button");
    c.type = "button";
    c.className = "chip"; c.textContent = t;
    c.onclick = () => { $("q").value = t; run(); };
    $("quickPicks").appendChild(c);
  });

  const submitBtn = $("searchForm").querySelector("button[type=submit]");
  const setBusy = (on) => {
    if (!submitBtn) return;
    submitBtn.disabled = on;
    submitBtn.setAttribute("aria-busy", String(on));
  };

  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  $("formFilter").addEventListener("change", () => {
    if (loaded) renderCompany(loaded.company, loaded.submissions);
  });

  async function run() {
    const q = $("q").value.trim();
    $("candidates").innerHTML = "";
    $("company").classList.add("hidden");
    loaded = null;
    if (!q) return;
    setBusy(true);
    setStatus("Resolving company...");
    let cands;
    try { cands = await SEC.resolve(q); }
    catch (e) { setBusy(false); return setStatus("Could not load the ticker map. " + e.message, true); }
    if (!cands.length) { setBusy(false); return setStatus(`No company matched "${q}".`, true); }
    if (cands.length === 1) return loadCompany(cands[0]);
    setBusy(false);
    setStatus(`${cands.length} possible matches. Pick one:`);
    const box = $("candidates");
    cands.forEach((c) => {
      const d = document.createElement("div");
      d.className = "filing"; d.style.cursor = "pointer";
      d.innerHTML = `<span class="form">${esc(c.ticker)}</span><span class="mono">CIK ${esc(c.cik)}</span><span>${esc(c.title)}</span><span class="links">select</span>`;
      onActivate(d, () => loadCompany(c));
      box.appendChild(d);
    });
  }

  async function loadCompany(c) {
    $("candidates").innerHTML = "";
    setStatus(`Loading EDGAR filings for ${c.ticker}...`);
    let subs;
    try { subs = await SEC.submissions(c.cik); }
    catch (e) { setBusy(false); return setStatus("SEC request failed: " + e.message, true); }
    setBusy(false);
    setStatus("");
    loaded = { company: c, submissions: subs };
    renderCompany(c, subs);
  }

  function renderCompany(c, subs) {
    const form = $("formFilter").value;
    const forms = form === "ALL" ? null : [form];
    const filings = SEC.recentFilings(subs, forms);

    $("companyHead").innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:baseline">
        <div><div style="font-size:22px;font-weight:700">${esc(subs.name || c.title)}</div>
          <div class="small muted mono">CIK ${SEC.cik10(subs.cik)} · ${esc(c.ticker)} · ${esc(subs.sicDescription || "Not listed")}</div></div>
        <div class="small"><a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${SEC.cik10(subs.cik)}&type=&dateb=&owner=include&count=40" target="_blank" rel="noopener">All filings on EDGAR &rarr;</a></div>
      </div>`;

    const wrap = $("filings");
    if (!filings.length) {
      wrap.innerHTML = `<div class="filing"><span></span><span></span><span class="muted">No ${form} filings in the recent set.</span><span></span></div>`;
    } else {
      wrap.innerHTML = "";
      filings.slice(0, 40).forEach((f) => {
        const row = document.createElement("div");
        row.className = "filing";
        const tag = f.form === "10-K" ? "tag tenk" : "tag";
        const dissect = f.form === "10-K"
          ? ` · <a href="app.html?ticker=${encodeURIComponent(c.ticker)}&cik=${encodeURIComponent(c.cik)}&name=${encodeURIComponent(subs.name || c.title)}">analyze</a>` : "";
        row.innerHTML = `
          <span class="${tag}">${esc(f.form)}</span>
          <span class="mono small">${esc(f.filed || "Date not listed")}</span>
          <span class="small muted">${esc(f.desc || ("Period " + (f.reportDate || "not listed")))}</span>
          <span class="links">${f.docUrl ? `<a href="${esc(f.docUrl)}" target="_blank" rel="noopener">open</a>` : ""}
            <a href="${esc(f.indexUrl)}" target="_blank" rel="noopener">index</a>${dissect}</span>`;
        wrap.appendChild(row);
      });
    }
    $("filingHint").innerHTML = `Showing up to 40 recent ${form === "ALL" ? "" : form + " "}filings from the SEC submissions feed. ` +
      `<b>Open</b> loads the filing document. <b>Index</b> opens the submission directory. For a 10-K, <b>analyze</b> sends the company to the Workbench. ` +
      `For the XBRL facts, open <a href="${SEC.companyFactsUrl(c.cik)}" target="_blank" rel="noopener">companyfacts.json</a>.`;
    $("company").classList.remove("hidden");
  }

  // Allow ?ticker= deep-link.
  const params = new URLSearchParams(location.search);
  if (params.get("ticker")) { $("q").value = params.get("ticker"); run(); }
})();
