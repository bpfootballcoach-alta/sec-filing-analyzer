const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function resolveEdgarUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "/ix" || parsed.pathname.startsWith("/ix")) {
      const docParam = parsed.searchParams.get("doc");
      if (docParam) {
        if (docParam.startsWith("http")) return docParam;
        return `https://www.sec.gov${docParam}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

const SEC_HEADERS = {
  "User-Agent": "SEC-Filing-Analyzer legal-research@example.com",
  "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

let _lastFetchTime = 0;
const secFetch = async (url: string, opts: RequestInit = {}): Promise<Response> => {
  const now = Date.now();
  const wait = 125 - (now - _lastFetchTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastFetchTime = Date.now();
  return fetch(url, { ...opts, headers: { ...SEC_HEADERS, ...(opts.headers as Record<string, string> || {}) } });
};

async function lookupTickerFilings(ticker: string) {
  const tickerMapRes = await secFetch("https://www.sec.gov/files/company_tickers.json");
  if (!tickerMapRes.ok) throw new Error("Failed to reach SEC EDGAR ticker list");
  const tickerMap = await tickerMapRes.json();

  let cik: string | null = null;
  let companyName: string | null = null;
  for (const entry of Object.values(tickerMap as Record<string, { ticker: string; cik_str: number; title: string }>)) {
    if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
      cik = String(entry.cik_str).padStart(10, "0");
      companyName = entry.title;
      break;
    }
  }
  if (!cik) throw new Error(`Ticker "${ticker}" not found on SEC EDGAR`);

  const filingsRes = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!filingsRes.ok) throw new Error("Failed to fetch filings from EDGAR");
  const filingsData = await filingsRes.json();
  const recent = filingsData.filings?.recent;
  if (!recent?.form?.length) throw new Error(`No recent filings found for ${ticker}`);

  const PRIORITY_FORMS = ["10-K", "10-Q", "8-K", "S-1", "S-3", "20-F", "DEF14A", "S-11", "F-1"];
  const filings: Array<{ form: string; date: string; period: string; accession: string; primaryDocument: string; url: string }> = [];
  const cikInt = parseInt(cik, 10);
  for (let i = 0; i < recent.form.length && filings.length < 20; i++) {
    const form: string = recent.form[i];
    if (PRIORITY_FORMS.some(f => form.startsWith(f))) {
      const accession: string = recent.accessionNumber[i].replace(/-/g, "");
      const primaryDoc: string = recent.primaryDocument[i];
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Mode: ticker lookup
    if (body.ticker && !body.url) {
      const result = await lookupTickerFilings(body.ticker);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { url, cik: bodyCik, accession } = body;
    if (!url) {
      return new Response(JSON.stringify({ error: "url or ticker is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Extract CIK from SEC EDGAR URL if not provided
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

    // --- STRATEGY 1: Try SEC XBRL companyfacts API ---
    let xbrlSummary = "";
    if (cik) {
      try {
        const factsRes = await secFetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`);
        if (factsRes.ok) {
          const facts = await factsRes.json();
          const usgaap = facts.facts?.["us-gaap"] || {};
          const dei = facts.facts?.["dei"] || {};

          const concepts: Array<[string, string]> = [
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
            ["Revenues", "Total Revenues"],
            ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenue"],
            ["SalesRevenueNet", "Net Sales"],
            ["GrossProfit", "Gross Profit"],
            ["OperatingIncomeLoss", "Operating Income"],
            ["NetIncomeLoss", "Net Income"],
            ["EarningsPerShareBasic", "EPS Basic"],
            ["EarningsPerShareDiluted", "EPS Diluted"],
            ["NetCashProvidedByUsedInOperatingActivities", "Operating Cash Flow"],
            ["NetCashProvidedByUsedInInvestingActivities", "Investing Cash Flow"],
            ["NetCashProvidedByUsedInFinancingActivities", "Financing Cash Flow"],
            ["CommonStockSharesOutstanding", "Shares Outstanding"],
          ];

          const lines: string[] = [];

          for (const [concept, label] of concepts) {
            const data = usgaap[concept];
            if (!data?.units) continue;
            const units = data.units;
            const unitKey = Object.keys(units)[0];
            if (!unitKey) continue;
            const entries = units[unitKey];
            if (!entries?.length) continue;

            const annual = entries
              .filter((e: { form?: string }) => e.form && (e.form === "10-K" || e.form === "10-K/A"))
              .sort((a: { end?: string; filed?: string }, b: { end?: string; filed?: string }) => (b.end || b.filed || "").localeCompare(a.end || a.filed || ""));

            const recent = annual[0] || entries.sort((a: { end?: string; filed?: string }, b: { end?: string; filed?: string }) => (b.end || b.filed || "").localeCompare(a.end || a.filed || ""))[0];
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

    // --- STRATEGY 2: Fetch the actual filing HTML ---
    const resolvedUrl = resolveEdgarUrl(url);
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    let res: Response | null = null as unknown as Response;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      res = await secFetch(resolvedUrl);
      if (res.ok) break;
      if (res.status !== 503 && res.status !== 429) break;
    }

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch URL: ${res.status} ${res.statusText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const text = await res.text();
    if (!text || text.length < 100) {
      return new Response(JSON.stringify({ error: "Fetched content is empty or too short" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Strip iXBRL/HTML
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

    const NARRATIVE_LIMIT = xbrlSummary ? 300000 : 600000;
    if (stripped.length > NARRATIVE_LIMIT) {
      stripped = stripped.slice(0, NARRATIVE_LIMIT);
    }

    const combined = xbrlSummary + stripped;

    // Return the text content directly (no file upload — client will handle it)
    return new Response(JSON.stringify({
      content: combined,
      content_length: text.length,
      resolved_url: resolvedUrl,
      has_xbrl: !!xbrlSummary,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
