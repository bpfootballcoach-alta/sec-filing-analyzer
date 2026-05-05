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

    const { url, cik: bodyCik, accession } = body;
    if (!url) return Response.json({ error: "url or ticker is required" }, { status: 400 });

    // Extract CIK from SEC EDGAR URL if not provided
    // URL pattern: /Archives/edgar/data/{CIK}/{accession}/{file}
    let cik = bodyCik;
    if (!cik) {
      const cikMatch = url.match(/edgar\/data\/(\d+)\//);
      if (cikMatch) cik = cikMatch[1];
    }

    // Extract accession number from URL if not provided
    let accessionNum = accession;
    if (!accessionNum) {
      const accMatch = url.match(/edgar\/data\/\d+\/(\d{18})\//);
      if (accMatch) accessionNum = accMatch[1];
    }

    // --- STRATEGY 1: Try SEC XBRL companyfacts API for clean structured financial data ---
    let xbrlSummary = "";
    if (cik) {
      try {
        const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`, { headers: SEC_HEADERS });
        if (factsRes.ok) {
          const facts = await factsRes.json();
          const usgaap = facts.facts?.["us-gaap"] || {};
          const dei = facts.facts?.["dei"] || {};

          // Extract key financial concepts
          const concepts = [
            // Balance sheet
            ["Assets", "Total Assets"],
            ["Liabilities", "Total Liabilities"],
            ["LiabilitiesAndStockholdersEquity", "Total Liabilities & Equity"],
            ["StockholdersEquity", "Total Stockholders Equity"],
            ["CashAndCashEquivalentsAtCarryingValue", "Cash & Cash Equivalents"],
            ["CashCashEquivalentsAndShortTermInvestments", "Cash & Short-term Investments"],
            ["LongTermDebt", "Long-term Debt"],
            ["LongTermDebtNoncurrent", "Long-term Debt (noncurrent)"],
            ["ShortTermBorrowings", "Short-term Borrowings"],
            ["DebtCurrent", "Current Debt"],
            // Income
            ["Revenues", "Total Revenues"],
            ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenue"],
            ["SalesRevenueNet", "Net Sales"],
            ["GrossProfit", "Gross Profit"],
            ["OperatingIncomeLoss", "Operating Income"],
            ["NetIncomeLoss", "Net Income"],
            ["EarningsPerShareBasic", "EPS Basic"],
            ["EarningsPerShareDiluted", "EPS Diluted"],
            // Cash flow
            ["NetCashProvidedByUsedInOperatingActivities", "Operating Cash Flow"],
            ["NetCashProvidedByUsedInInvestingActivities", "Investing Cash Flow"],
            ["NetCashProvidedByUsedInFinancingActivities", "Financing Cash Flow"],
            // Shares
            ["CommonStockSharesOutstanding", "Shares Outstanding"],
          ];

          const lines = [];
          const currentYear = new Date().getFullYear();

          for (const [concept, label] of concepts) {
            const data = usgaap[concept];
            if (!data?.units) continue;
            const units = data.units;
            const unitKey = Object.keys(units)[0];
            if (!unitKey) continue;
            const entries = units[unitKey];
            if (!entries?.length) continue;

            // Get most recent annual or point-in-time value
            // Prefer 10-K filings (form contains "10-K") and most recent
            const annual = entries
              .filter(e => e.form && (e.form === "10-K" || e.form === "10-K/A"))
              .sort((a, b) => (b.end || b.filed || "").localeCompare(a.end || a.filed || ""));

            const recent = annual[0] || entries.sort((a, b) => (b.end || b.filed || "").localeCompare(a.end || a.filed || ""))[0];
            if (!recent) continue;

            const val = unitKey === "USD"
              ? `$${(recent.val / 1e6).toFixed(2)}M`
              : unitKey === "shares"
              ? `${recent.val.toLocaleString()} shares`
              : `${recent.val} ${unitKey}`;

            lines.push(`${label}: ${val} (period: ${recent.end || recent.filed || "?"}, filed: ${recent.form || "?"})`);
          }

          if (lines.length > 0) {
            xbrlSummary = "=== STRUCTURED FINANCIAL DATA (from SEC XBRL) ===\n" + lines.join("\n") + "\n\n";
          }
        }
      } catch (_e) {
        // XBRL fetch failed — will fall back to HTML text
      }
    }

    // --- STRATEGY 2: Fetch the actual filing HTML for narrative content ---
    const resolvedUrl = resolveEdgarUrl(url);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      res = await fetch(resolvedUrl, { headers: SEC_HEADERS });
      if (res.ok) break;
      if (res.status !== 503 && res.status !== 429) break;
    }

    if (!res.ok) {
      return Response.json({ error: `Failed to fetch URL: ${res.status} ${res.statusText}` }, { status: 502 });
    }

    const text = await res.text();
    if (!text || text.length < 100) {
      return Response.json({ error: "Fetched content is empty or too short" }, { status: 502 });
    }

    // Strip iXBRL/HTML — remove hidden XBRL header block first
    let html = text;
    html = html.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, "");
    html = html.replace(/<div[^>]+style="[^"]*display\s*:\s*none[^"]*"[\s\S]*?<\/div>/gi, "");

    let stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<ix:[^>]*>/gi, "")
      .replace(/<\/ix:[^>]*>/gi, "")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/td>/gi, " | ")
      .replace(/<\/th>/gi, " | ")
      .replace(/<\/p>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Limit narrative text — take preamble + MD&A section (skip deep financial tables since XBRL covers those)
    const NARRATIVE_LIMIT = xbrlSummary ? 300000 : 600000;
    if (stripped.length > NARRATIVE_LIMIT) {
      stripped = stripped.slice(0, NARRATIVE_LIMIT);
    }

    // Combine: XBRL structured financials first (most important), then narrative HTML text
    const combined = xbrlSummary + stripped;

    const file = new File([combined], "filing.txt", { type: "text/plain" });
    const uploaded = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ file_url: uploaded.file_url, content_length: text.length, resolved_url: resolvedUrl, has_xbrl: !!xbrlSummary });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});