// Registration statements only: exclude reports, prospectus supplements and
// effectiveness notices. Amendments retain their /A form designation.
const REGISTRATION_FORMS = new Set([
  "S-1", "S-1MEF", "S-3", "S-3ASR", "S-3D", "S-3DP", "S-3MEF",
  "S-4", "S-4EF", "S-4MEF", "S-6", "S-8", "S-8POS", "S-11", "S-11MEF", "S-20",
  "F-1", "F-1MEF", "F-3", "F-3ASR", "F-3D", "F-3DP", "F-3MEF",
  "F-4", "F-4EF", "F-4MEF", "F-6", "F-6EF", "F-6POS",
  "F-7", "F-8", "F-9", "F-9EF", "F-10", "F-10EF", "F-80",
]);

export function isRegistrationForm(form: string): boolean {
  return typeof form === "string" && REGISTRATION_FORMS.has(form.replace(/\/A$/, ""));
}

type FilingColumns = {
  form?: string[];
  filingDate?: string[];
  reportDate?: string[];
  accessionNumber?: string[];
  primaryDocument?: string[];
};

export function registrationFilings(recent: FilingColumns, cik: string) {
  return (recent.form || []).flatMap((form, i) => {
    if (!isRegistrationForm(form)) return [];
    const accession = recent.accessionNumber?.[i];
    const date = recent.filingDate?.[i];
    if (!accession || !date) return [];
    const directory = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}`;
    const primaryDocument = recent.primaryDocument?.[i] || "";
    return [{
      form, date, accession, primaryDocument,
      period: recent.reportDate?.[i] || "",
      url: primaryDocument
        ? `${directory}/${primaryDocument}`
        : `${directory}/${accession}-index.html`,
    }];
  });
}

export async function lookupRegistrationFilings(
  input: string,
  secFetch: (url: string) => Promise<Response>,
  limit = 20,
) {
  const query = String(input).trim().toUpperCase();
  let cik: string;
  let ticker = query;
  if (/^\d{1,10}$/.test(query) && Number(query) > 0) {
    cik = query.padStart(10, "0");
  } else {
    const response = await secFetch("https://www.sec.gov/files/company_tickers.json");
    if (!response.ok) throw new Error("Failed to reach SEC EDGAR ticker list");
    const entries = Object.values(await response.json()) as Array<{ ticker: string; cik_str: number }>;
    const entry = entries.find(entry => entry.ticker?.toUpperCase() === query);
    if (!entry) throw new Error(`Ticker "${query}" not found on SEC EDGAR`);
    cik = String(entry.cik_str).padStart(10, "0");
  }

  const response = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (!response.ok) throw new Error("Failed to fetch filings from EDGAR");
  const data = await response.json();
  if (/^\d+$/.test(query)) ticker = data.tickers?.[0] || "";
  const byAccession = new Map(
    registrationFilings(data.filings?.recent || {}, cik).map(filing => [filing.accession, filing]),
  );
  // The recent submissions window can contain only reports. Read older SEC
  // submission files until we have the most recent registration statements.
  const archives = [...(data.filings?.files || [])].sort((a, b) =>
    (b.filingTo || "").localeCompare(a.filingTo || ""));
  for (const archive of archives) {
    if (byAccession.size >= limit) break;
    const olderResponse = await secFetch(`https://data.sec.gov/submissions/${archive.name}`);
    if (!olderResponse.ok) throw new Error("Failed to fetch older filings from EDGAR");
    for (const filing of registrationFilings(await olderResponse.json(), cik)) {
      byAccession.set(filing.accession, filing);
    }
  }
  const filings = [...byAccession.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || b.accession.localeCompare(a.accession))
    .slice(0, limit);
  return { ticker, companyName: data.name || query, cik, filings };
}
