import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const EDGAR_BASE = "https://data.sec.gov/submissions";
const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await req.json();
  if (!ticker) return Response.json({ error: "ticker is required" }, { status: 400 });

  // Step 1: Resolve ticker -> CIK via EDGAR company search
  const searchRes = await fetch(
    `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(ticker)}%22&dateRange=custom&startdt=2000-01-01&forms=10-K,20-F,S-1,S-3,F-1,F-3`,
    { headers: HEADERS }
  );

  // Use the tickers.json endpoint which is more reliable
  const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: HEADERS });
  const tickerData = await tickerRes.json();

  let cik = null;
  let companyName = null;
  for (const entry of Object.values(tickerData)) {
    if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
      cik = String(entry.cik_str).padStart(10, "0");
      companyName = entry.title;
      break;
    }
  }

  if (!cik) {
    return Response.json({ error: `Could not find CIK for ticker: ${ticker}` }, { status: 404 });
  }

  // Step 2: Fetch all filings for this CIK
  const subRes = await fetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
  if (!subRes.ok) return Response.json({ error: "Failed to fetch EDGAR submissions" }, { status: 500 });
  const subData = await subRes.json();

  const recent = subData.filings?.recent || {};
  const forms = recent.form || [];
  const dates = recent.filingDate || [];
  const accessions = recent.accessionNumber || [];
  const primaryDocs = recent.primaryDocument || [];

  // Build filing list with type, date, accession
  const filings = forms.map((form, i) => ({
    form,
    date: dates[i],
    accession: accessions[i],
    doc: primaryDocs[i],
  }));

  const today = new Date();

  const findLatest = (formTypes) =>
    filings.find((f) => formTypes.some((t) => f.form?.toUpperCase().startsWith(t.toUpperCase())));

  const findAll = (formTypes) =>
    filings.filter((f) => formTypes.some((t) => f.form?.toUpperCase().startsWith(t.toUpperCase())));

  const daysSince = (dateStr) => {
    if (!dateStr) return null;
    return Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  };

  const edgarUrl = (f) =>
    f ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${f.accession.replace(/-/g, "")}/${f.doc}` : null;

  // Detect issuer type: domestic (10-K/8-K) vs foreign private issuer (20-F/6-K)
  const has10K = filings.some((f) => f.form === "10-K");
  const has20F = filings.some((f) => f.form === "20-F");
  const isFPI = has20F && !has10K;

  const annualFormTypes = isFPI ? ["20-F"] : ["10-K"];
  const periodicFormTypes = isFPI ? ["6-K"] : ["8-K", "10-Q"];
  const prospectusTypes = ["424B", "S-3", "F-3", "S-1/A", "F-1/A", "PROSPECTUS SUPPLEMENT"];

  const latestAnnual = findLatest(annualFormTypes);
  const latestPeriodic = findLatest(periodicFormTypes);
  const latestProspectus = findLatest(prospectusTypes);
  const allRegistrationForms = findAll(["S-1", "S-3", "F-1", "F-3", "S-11"]);
  const latestRegistration = allRegistrationForms[0] || null;

  const annualDays = daysSince(latestAnnual?.date);
  const periodicDays = daysSince(latestPeriodic?.date);
  const prospectusDays = daysSince(latestProspectus?.date);

  // --- Evaluate each check ---

  // 1. Annual report currency (Section 13/15d + 10(a)(3))
  // 10-K: due 60/75/90 days after FYE. 20-F: due 120 days after FYE.
  // We flag if > 365 days since last annual (conservative — means they missed the cycle)
  const annualDeadlineDays = isFPI ? 120 : 90;
  let annualStatus, annualDetail;
  if (!latestAnnual) {
    annualStatus = "fail";
    annualDetail = `No ${annualFormTypes[0]} found on EDGAR. Company may not be current on its Section 13/15(d) annual reporting obligation.`;
  } else if (annualDays > 365 + annualDeadlineDays) {
    annualStatus = "fail";
    annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). This is overdue by more than one annual cycle — the company appears delinquent on its annual reporting obligation.`;
  } else if (annualDays > 365) {
    annualStatus = "warn";
    annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). A new annual report may be coming due soon depending on fiscal year end.`;
  } else {
    annualStatus = "pass";
    annualDetail = `${latestAnnual.form} filed ${annualDays} days ago on ${latestAnnual.date}. Annual reporting appears current.`;
  }

  // 2. Periodic report currency (8-K / 6-K / 10-Q)
  let periodicStatus, periodicDetail;
  if (!latestPeriodic) {
    periodicStatus = "warn";
    periodicDetail = `No ${periodicFormTypes.join("/")} filings found. Cannot confirm periodic reporting is current.`;
  } else if (periodicDays > 180) {
    periodicStatus = "warn";
    periodicDetail = `Last ${latestPeriodic.form} was ${periodicDays} days ago (${latestPeriodic.date}). No recent periodic/current report — material updates may be missing.`;
  } else {
    periodicStatus = "pass";
    periodicDetail = `Most recent ${latestPeriodic.form} filed ${periodicDays} days ago on ${latestPeriodic.date}. Periodic reporting appears current.`;
  }

  // 3. Section 10(a)(3) prospectus staleness
  // A prospectus becomes stale after 9 months (S-1/F-1 issuers) or 16 months (shelf S-3/F-3)
  // Must be updated via annual report incorporation or a new 424B/prospectus supplement
  let prospectusStatus, prospectusDetail;
  if (!latestRegistration) {
    prospectusStatus = "info";
    prospectusDetail = "No registration statement (S-1, S-3, F-1, F-3) found on EDGAR for this issuer.";
  } else {
    const regType = latestRegistration.form.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const stalenessLimit = isShelf ? 480 : 270; // 16 months vs 9 months in days

    if (!latestProspectus) {
      prospectusStatus = "warn";
      prospectusDetail = `Registration statement (${latestRegistration.form}, ${latestRegistration.date}) found but no 424B prospectus supplement on record. Verify whether Section 10(a)(3) update obligations have been met.`;
    } else if (prospectusDays > stalenessLimit) {
      prospectusStatus = "fail";
      prospectusDetail = `Last prospectus/424B was filed ${prospectusDays} days ago (${latestProspectus.date}). Under Section 10(a)(3), a ${isShelf ? "shelf" : ""} prospectus must be updated after ${isShelf ? "16 months" : "9 months"}. This prospectus appears STALE and should have been updated via annual report incorporation or a new prospectus supplement.`;
    } else {
      prospectusStatus = "pass";
      prospectusDetail = `Most recent prospectus/424B filed ${prospectusDays} days ago on ${latestProspectus.date}. Within the Section 10(a)(3) ${isShelf ? "16-month shelf" : "9-month"} currency window.`;
    }
  }

  // 4. Overall Section 13/15(d) reporting obligation
  const has13G15D = filings.some((f) => ["SC 13G", "SC 13D", "13F-HR"].includes(f.form?.toUpperCase()));
  const section13Status = "info";
  const section13Detail = has13G15D
    ? "Section 13(d)/(g) filings detected on record (SC 13G/13D). These are ownership-reporting obligations separate from issuer reporting."
    : "No SC 13G/13D filings detected under this CIK (these would be filed by significant shareholders, not the issuer itself).";

  const overallStatus =
    [annualStatus, periodicStatus, prospectusStatus].includes("fail") ? "fail" :
    [annualStatus, periodicStatus, prospectusStatus].includes("warn") ? "warn" : "pass";

  return Response.json({
    ticker: ticker.toUpperCase(),
    cik,
    companyName,
    isFPI,
    overallStatus,
    checks: [
      {
        id: "annual",
        label: `Annual Report (${annualFormTypes[0]}) — Section 13/15(d)`,
        status: annualStatus,
        detail: annualDetail,
        filingDate: latestAnnual?.date || null,
        filingUrl: edgarUrl(latestAnnual),
        filingForm: latestAnnual?.form || null,
      },
      {
        id: "periodic",
        label: `Periodic Reports (${periodicFormTypes.join("/")})`,
        status: periodicStatus,
        detail: periodicDetail,
        filingDate: latestPeriodic?.date || null,
        filingUrl: edgarUrl(latestPeriodic),
        filingForm: latestPeriodic?.form || null,
      },
      {
        id: "prospectus",
        label: "Prospectus Currency — Section 10(a)(3)",
        status: prospectusStatus,
        detail: prospectusDetail,
        filingDate: latestProspectus?.date || null,
        filingUrl: edgarUrl(latestProspectus),
        filingForm: latestProspectus?.form || null,
      },
      {
        id: "section13",
        label: "Section 13/15(d) Ownership Reporting",
        status: section13Status,
        detail: section13Detail,
        filingDate: null,
        filingUrl: null,
        filingForm: null,
      },
    ],
    checkedAt: today.toISOString(),
  });
});