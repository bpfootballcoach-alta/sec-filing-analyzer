import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Resolve the real document URL from SEC EDGAR inline viewer URLs
// e.g. https://www.sec.gov/ix?doc=/Archives/edgar/data/.../file.htm
//   -> https://www.sec.gov/Archives/edgar/data/.../file.htm
function resolveEdgarUrl(url) {
  try {
    const parsed = new URL(url);
    // Handle inline XBRL viewer: /ix?doc=...
    if (parsed.pathname === '/ix' || parsed.pathname.startsWith('/ix')) {
      const docParam = parsed.searchParams.get('doc');
      if (docParam) {
        // docParam may be relative (starts with /) or absolute
        if (docParam.startsWith('http')) return docParam;
        return `https://www.sec.gov${docParam}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

const SEC_HEADERS = {
  "User-Agent": "Research Tool legal-research@example.com",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
};

async function lookupTickerFilings(ticker) {
  // Resolve ticker -> CIK
  const tickerMapRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
  if (!tickerMapRes.ok) throw new Error("Failed to reach SEC EDGAR ticker list");
  const tickerMap = await tickerMapRes.json();

  let cik = null, companyName = null;
  for (const entry of Object.values(tickerMap)) {
    if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
      cik = String(entry.cik_str).padStart(10, "0");
      companyName = entry.title;
      break;
    }
  }
  if (!cik) throw new Error(`Ticker "${ticker}" not found on SEC EDGAR`);

  // Fetch recent filings
  const filingsRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_HEADERS });
  if (!filingsRes.ok) throw new Error("Failed to fetch filings from EDGAR");
  const filingsData = await filingsRes.json();
  const recent = filingsData.filings?.recent;
  if (!recent?.form?.length) throw new Error(`No recent filings found for ${ticker}`);

  const PRIORITY_FORMS = ["10-K", "10-Q", "8-K", "S-1", "S-3", "20-F", "DEF14A", "S-11", "F-1"];
  const filings = [];
  const cikInt = parseInt(cik, 10);
  for (let i = 0; i < recent.form.length && filings.length < 20; i++) {
    const form = recent.form[i];
    if (PRIORITY_FORMS.some(f => form.startsWith(f))) {
      const accession = recent.accessionNumber[i].replace(/-/g, "");
      const primaryDoc = recent.primaryDocument[i];
      filings.push({
        form,
        date: recent.filingDate[i],
        period: recent.reportDate?.[i] || "",
        accession,
        primaryDocument: primaryDoc,
        url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accession}/${primaryDoc}`,
      });
    }
  }
  if (!filings.length) throw new Error(`No relevant filings found for ${ticker}`);

  return { ticker: ticker.toUpperCase(), companyName: filingsData.name || companyName, cik, filings };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();

    // Mode: ticker lookup
    if (body.ticker && !body.url) {
      const result = await lookupTickerFilings(body.ticker);
      return Response.json(result);
    }

    const { url } = body;
    if (!url) return Response.json({ error: "url or ticker is required" }, { status: 400 });

    // Resolve the actual document URL (handles SEC EDGAR /ix?doc= viewer URLs)
    const resolvedUrl = resolveEdgarUrl(url);

    // Fetch the filing from SEC EDGAR with retries (SEC can 503 on first hit)
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt); // 2s, then 4s
      res = await fetch(resolvedUrl, { headers: SEC_HEADERS });
      if (res.ok) break;
      if (res.status !== 503 && res.status !== 429) break; // only retry on rate-limit errors
    }

    if (!res.ok) {
      return Response.json({ error: `Failed to fetch URL: ${res.status} ${res.statusText}` }, { status: 502 });
    }

    const text = await res.text();

    if (!text || text.length < 100) {
      return Response.json({ error: "Fetched content is empty or too short" }, { status: 502 });
    }

    // Strip HTML/XBRL aggressively, preserving financial table content
    // SEC filings with inline XBRL can be 4MB+ of raw HTML
    let html = text;

    // Remove the hidden XBRL data block at the top of iXBRL documents
    // This block appears as <ix:header>...</ix:header> or a <div style="display:none"> before the visible content
    html = html.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, "");
    html = html.replace(/<div[^>]+style="[^"]*display\s*:\s*none[^"]*"[\s\S]*?<\/div>/gi, "");

    let stripped = html
      // Remove scripts and styles
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      // Remove inline XBRL ix: tags but keep their text content
      .replace(/<ix:[^>]*>/gi, "")
      .replace(/<\/ix:[^>]*>/gi, "")
      // Preserve table/paragraph structure with newlines
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " | ")
      .replace(/<\/th>/gi, " | ")
      .replace(/<\/p>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, " ")
      // Collapse whitespace but preserve newlines
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // For large documents, find and prioritize the financial statements section
    const TOTAL_LIMIT = 600000;
    if (stripped.length > TOTAL_LIMIT) {
      const markers = [
        /CONSOLIDATED BALANCE SHEET/i,
        /BALANCE SHEETS/i,
        /STATEMENTS? OF OPERATIONS/i,
        /STATEMENTS? OF CASH FLOW/i,
        /FINANCIAL STATEMENTS/i,
        /ITEM\s*8[\.\s]/i,
      ];

      let financialStart = -1;
      for (const marker of markers) {
        const idx = stripped.search(marker);
        if (idx !== -1 && (financialStart === -1 || idx < financialStart)) {
          financialStart = idx;
        }
      }

      if (financialStart > 0) {
        // Preamble (business description etc.) + full financials section
        const preamble = stripped.slice(0, Math.min(financialStart, 100000));
        const financials = stripped.slice(financialStart, financialStart + 500000);
        stripped = preamble + "\n\n" + financials;
      } else {
        stripped = stripped.slice(0, TOTAL_LIMIT);
      }
    }

    // Upload as plain text so the LLM gets clean readable content (not raw HTML)
    const file = new File([stripped], "filing.txt", { type: "text/plain" });
    const uploaded = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ file_url: uploaded.file_url, content_length: text.length, resolved_url: resolvedUrl });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});