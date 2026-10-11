import { lookupRegistrationFilings } from "../_shared/registrationFilings.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Mode: ticker lookup
    if ((body.ticker || body.cik) && !body.url) {
      const result = await lookupRegistrationFilings(body.cik || body.ticker, secFetch);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { url, cik: bodyCik, accession } = body;
    if (!url) {
      return new Response(JSON.stringify({ error: "url, ticker or CIK is required" }), {
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
