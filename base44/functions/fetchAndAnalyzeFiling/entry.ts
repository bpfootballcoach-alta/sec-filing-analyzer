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

    // Strip HTML tags, collapse whitespace, and truncate to 400k chars
    // SEC filings with inline XBRL can be 4MB+ of raw HTML; the LLM only needs readable text.
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400000);

    // Upload as plain text so the LLM gets clean readable content (not raw HTML)
    const file = new File([stripped], "filing.txt", { type: "text/plain" });
    const uploaded = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ file_url: uploaded.file_url, content_length: text.length, resolved_url: resolvedUrl });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});