/* finder.js - Report Finder. Live against data.sec.gov/submissions (CORS OK). */
(() => {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const setStatus = (msg, err) => { status.textContent = msg || ""; status.className = "status" + (err ? " err" : ""); };

  const PICKS = ["AMZN", "WMT", "MSFT", "GOOGL", "FDX", "UPS", "TGT"];
  PICKS.forEach((t) => {
    const c = document.createElement("span");
    c.className = "chip"; c.textContent = t;
    c.onclick = () => { $("q").value = t; run(); };
    $("quickPicks").appendChild(c);
  });

  $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); run(); });

  async function run() {
    const q = $("q").value.trim();
    $("candidates").innerHTML = "";
    $("company").classList.add("hidden");
    if (!q) return;
    setStatus("Resolving company …");
    let cands;
    try { cands = await SEC.resolve(q); }
    catch (e) { return setStatus("Could not load the ticker map. " + e.message, true); }
    if (!cands.length) return setStatus(`No company matched "${q}".`, true);
    if (cands.length === 1) return loadCompany(cands[0]);
    setStatus(`${cands.length} possible matches. Pick one:`);
    const box = $("candidates");
    cands.forEach((c) => {
      const d = document.createElement("div");
      d.className = "filing"; d.style.cursor = "pointer";
      d.innerHTML = `<span class="form">${c.ticker}</span><span class="mono">CIK ${c.cik}</span><span>${c.title}</span><span class="links">select &rarr;</span>`;
      d.onclick = () => loadCompany(c);
      box.appendChild(d);
    });
  }

  async function loadCompany(c) {
    $("candidates").innerHTML = "";
    setStatus(`Loading EDGAR filings for ${c.ticker} …`);
    let subs;
    try { subs = await SEC.submissions(c.cik); }
    catch (e) { return setStatus("SEC request failed: " + e.message, true); }
    setStatus("");
    const form = $("formFilter").value;
    const forms = form === "ALL" ? null : [form];
    const filings = SEC.recentFilings(subs, forms);

    $("companyHead").innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:baseline">
        <div><div style="font-size:22px;font-weight:700">${subs.name}</div>
          <div class="small muted mono">CIK ${SEC.cik10(subs.cik)} · ${c.ticker} · ${subs.sicDescription || "—"}</div></div>
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
          ? ` · <a href="dissector.html?ticker=${encodeURIComponent(c.ticker)}&cik=${c.cik}">dissect</a>` : "";
        row.innerHTML = `
          <span class="${tag}">${f.form}</span>
          <span class="mono small">${f.filed}</span>
          <span class="small muted">${f.desc || ("period " + (f.reportDate || "—"))}</span>
          <span class="links">${f.docUrl ? `<a href="${f.docUrl}" target="_blank" rel="noopener">open</a>` : ""}
            <a href="${f.indexUrl}" target="_blank" rel="noopener">index</a>${dissect}</span>`;
        wrap.appendChild(row);
      });
    }
    $("filingHint").innerHTML = `Showing the most recent ${form === "ALL" ? "" : form + " "}filings. ` +
      `<b>open</b> is the filing document, <b>index</b> is the full submission, <b>dissect</b> sends a 10-K to the Filing Dissector. ` +
      `To pull the financials yourself, grab <a href="${SEC.companyFactsUrl(c.cik)}" target="_blank" rel="noopener">this company's companyfacts.json</a> and drop it into the Dissector.`;
    $("company").classList.remove("hidden");
  }

  // Allow ?ticker= deep-link.
  const params = new URLSearchParams(location.search);
  if (params.get("ticker")) { $("q").value = params.get("ticker"); run(); }
})();
