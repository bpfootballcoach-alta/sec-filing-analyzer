import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const EDGAR_BASE = "https://data.sec.gov/submissions";
const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { ticker } = await req.json();
  if (!ticker) return Response.json({ error: "ticker is required" }, { status: 400 });

  // Step 1: Resolve ticker -> CIK
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

  // Step 2: Fetch all filings for this CIK (recent + full history if needed)
  const subRes = await fetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
  if (!subRes.ok) return Response.json({ error: "Failed to fetch EDGAR submissions" }, { status: 500 });
  const subData = await subRes.json();

  // Merge recent + any additional filing pages
  let allForms = [], allDates = [], allAccessions = [], allPrimaryDocs = [], allSizes = [];
  const recent = subData.filings?.recent || {};
  allForms = recent.form || [];
  allDates = recent.filingDate || [];
  allAccessions = recent.accessionNumber || [];
  allPrimaryDocs = recent.primaryDocument || [];
  allSizes = recent.size || [];

  // If there are additional filing pages, fetch them too
  const files = subData.filings?.files || [];
  for (const f of files) {
    const pageRes = await fetch(`https://data.sec.gov${f.name}`, { headers: HEADERS });
    if (pageRes.ok) {
      const pageData = await pageRes.json();
      allForms = allForms.concat(pageData.form || []);
      allDates = allDates.concat(pageData.filingDate || []);
      allAccessions = allAccessions.concat(pageData.accessionNumber || []);
      allPrimaryDocs = allPrimaryDocs.concat(pageData.primaryDocument || []);
    }
  }

  const filings = allForms.map((form, i) => ({
    form,
    date: allDates[i],
    accession: allAccessions[i],
    doc: allPrimaryDocs[i],
  })).filter(f => f.form && f.date);

  const today = new Date();

  const daysSince = (dateStr) => {
    if (!dateStr) return null;
    return Math.floor((today - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  };

  const findLatest = (formTypes) =>
    filings.find((f) => formTypes.some((t) => f.form?.toUpperCase() === t.toUpperCase() || f.form?.toUpperCase().startsWith(t.toUpperCase() + "/")));

  const findAll = (formTypes) =>
    filings.filter((f) => formTypes.some((t) => f.form?.toUpperCase() === t.toUpperCase() || f.form?.toUpperCase().startsWith(t.toUpperCase() + "/")));

  const edgarUrl = (f) =>
    f ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${f.accession.replace(/-/g, "")}/${f.doc}` : null;

  // Detect issuer type
  const has10K = filings.some((f) => f.form === "10-K");
  const has20F = filings.some((f) => f.form === "20-F");
  const isFPI = has20F && !has10K;

  const annualFormTypes = isFPI ? ["20-F"] : ["10-K"];
  const quarterlyFormTypes = isFPI ? ["6-K"] : ["10-Q"];
  const currentFormTypes = isFPI ? ["6-K"] : ["8-K"];

  const latestAnnual = findLatest(annualFormTypes);
  const allAnnuals = findAll(annualFormTypes);
  const latestQuarterly = findLatest(quarterlyFormTypes);
  const latestCurrent = findLatest(currentFormTypes);

  const annualDays = daysSince(latestAnnual?.date);
  const quarterlyDays = daysSince(latestQuarterly?.date);
  const currentDays = daysSince(latestCurrent?.date);

  // --- CHECK 1: Annual Report (10-K) current? ---
  // Must have filed within the past 365 days (conservative — companies file annually)
  // 10-K deadlines: Large Accelerated Filer=60d, Accelerated=75d, Non-accelerated=90d after FYE
  let annualStatus, annualDetail;
  if (!latestAnnual) {
    annualStatus = "fail";
    annualDetail = `No ${annualFormTypes[0]} found on EDGAR. Company is not current on its annual reporting obligation.`;
  } else if (annualDays > 455) {
    // >365+90 = clearly missed an entire annual cycle
    annualStatus = "fail";
    annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). Company appears delinquent — missed at least one annual report filing cycle.`;
  } else if (annualDays > 365) {
    annualStatus = "warn";
    annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). A new annual report may be coming due depending on fiscal year end.`;
  } else {
    annualStatus = "pass";
    annualDetail = `${latestAnnual.form} filed ${annualDays} days ago on ${latestAnnual.date}. Annual reporting is current.`;
  }

  // --- CHECK 2: Quarterly Reports (10-Q) current? ---
  let quarterlyStatus, quarterlyDetail;
  if (isFPI) {
    quarterlyStatus = "info";
    quarterlyDetail = "Foreign Private Issuer — quarterly 10-Q not required; 6-K used for interim updates.";
  } else if (!latestQuarterly) {
    quarterlyStatus = "fail";
    quarterlyDetail = "No 10-Q filings found. Company is not current on quarterly reporting.";
  } else if (quarterlyDays > 135) {
    // 10-Q due 40 days (large accel) or 45 days (others) after quarter end. >135 days = missed a quarter
    quarterlyStatus = "fail";
    quarterlyDetail = `Last 10-Q was filed ${quarterlyDays} days ago (${latestQuarterly.date}). Company appears delinquent on quarterly reporting.`;
  } else if (quarterlyDays > 90) {
    quarterlyStatus = "warn";
    quarterlyDetail = `Last 10-Q was filed ${quarterlyDays} days ago (${latestQuarterly.date}). A new quarterly report may be coming due soon.`;
  } else {
    quarterlyStatus = "pass";
    quarterlyDetail = `Most recent 10-Q filed ${quarterlyDays} days ago on ${latestQuarterly.date}. Quarterly reporting is current.`;
  }

  // --- CHECK 3: Current Reports (8-K) — has the company filed recently? ---
  let currentStatus, currentDetail;
  if (!latestCurrent) {
    currentStatus = "warn";
    currentDetail = `No ${currentFormTypes[0]} current reports found on EDGAR.`;
  } else if (currentDays > 365) {
    currentStatus = "warn";
    currentDetail = `Last ${latestCurrent.form} was filed ${currentDays} days ago (${latestCurrent.date}). No recent current event filings — may indicate limited activity.`;
  } else {
    currentStatus = "pass";
    currentDetail = `Most recent ${latestCurrent.form} filed ${currentDays} days ago on ${latestCurrent.date}.`;
  }

  // --- CHECK 4: Section 10(a)(3) Eligibility & Prospectus Currency ---
  // Section 10(a)(3): A prospectus in a registration statement for a continuous offering
  // must be updated (kept current) once it becomes stale.
  //
  // Eligibility to use S-3 (and have annual report auto-incorporate):
  //   - Has been subject to Exchange Act reporting for at least 12 months
  //   - Has filed all required 10-Ks, 10-Qs, 8-Ks on time (current filer)
  //   - Not a shell company or blank check company
  //   - For primary offerings: float >= $75M (WKSI) OR smaller reporting company
  //
  // Prospectus staleness rule (Section 10(a)(3)):
  //   - S-1/F-1 (non-shelf): prospectus stale after 9 months if financial statements
  //     are more than 16 months old; must file post-effective amendment
  //   - S-3/F-3 (shelf): automatically updated by incorporation by reference of annual report
  //     but the base prospectus must be updated / re-filed if it hasn't incorporated the latest 10-K
  //
  // Key: For S-3, the 10-K incorporation keeps it current. For S-1, need a post-effective amendment.

  const allRegistrationForms = findAll(["S-1", "S-3", "F-1", "F-3", "S-11"]);
  const latestRegistration = allRegistrationForms[0] || null;
  const allProspectusForms = findAll(["424B", "PROSPECTUS"]);
  const latestProspectus = allProspectusForms[0] || null;
  const prospectusDays = daysSince(latestProspectus?.date);

  // Check if company has been reporting for 12+ months (required for S-3 eligibility)
  const oldestFiling = filings[filings.length - 1];
  const reportingHistoryDays = daysSince(oldestFiling?.date);
  const hasMinReportingHistory = reportingHistoryDays >= 365;

  // Is the company current in ALL required filings?
  const isCurrentFiler = annualStatus !== "fail" && quarterlyStatus !== "fail";

  // Shell company check — look for NT filings (non-timely), shell-related 8-Ks
  const hasNTFilings = filings.some(f => f.form?.startsWith("NT "));

  // Smaller Reporting Company — inferred from having non-accelerated filer status
  // (We can't determine this precisely without reading the 10-K cover page, but we flag it)

  let prospectusStatus, prospectusDetail;

  if (!latestRegistration) {
    prospectusStatus = "info";
    prospectusDetail = "No registration statement (S-1, S-3, F-1, F-3) found on EDGAR for this issuer. Section 10(a)(3) prospectus currency obligations not applicable.";
  } else {
    const regType = latestRegistration.form.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const regDays = daysSince(latestRegistration.date);

    if (isShelf) {
      // S-3/F-3 shelf: automatically updated by incorporation by reference of annual report.
      // The shelf is current if: (a) the company is a current filer AND (b) has filed a 10-K
      // since the shelf was declared effective (which auto-incorporates into the prospectus).
      if (!isCurrentFiler) {
        prospectusStatus = "fail";
        prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) found, but the company is NOT current in its Exchange Act reporting. Under Section 10(a)(3), a shelf prospectus is kept current by incorporation by reference of annual/quarterly reports — this only works if the company is a current filer. The shelf prospectus is STALE.`;
      } else if (latestAnnual && new Date(latestAnnual.date) > new Date(latestRegistration.date)) {
        prospectusStatus = "pass";
        prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) is automatically updated via incorporation by reference of the latest ${latestAnnual.form} (${latestAnnual.date}). Prospectus is current under Section 10(a)(3).`;
      } else if (!latestAnnual) {
        prospectusStatus = "fail";
        prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) found but no annual report has been filed. Cannot incorporate by reference. Shelf prospectus is STALE.`;
      } else {
        // No 10-K filed after the shelf — shelf may be stale
        prospectusStatus = "warn";
        prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) filed but no subsequent annual report found to auto-incorporate. Shelf prospectus currency under Section 10(a)(3) is uncertain.`;
      }
    } else {
      // S-1/F-1 (non-shelf): prospectus stale after 9 months from effective date
      // OR after financial statements are more than 16 months old.
      // Must file a post-effective amendment (S-1/A) or new 424B to update.
      const nineMonths = 274;
      const latestAmendment = findLatest([`${regType.split("/")[0]}/A`, "424B"]);
      const amendmentDays = daysSince(latestAmendment?.date);

      if (!isCurrentFiler) {
        prospectusStatus = "fail";
        prospectusDetail = `Non-shelf registration (${latestRegistration.form}, ${latestRegistration.date}) found. Company is NOT current in Exchange Act reporting, which is required for Section 10(a)(3) compliance. Prospectus is STALE.`;
      } else if (!latestProspectus && regDays > nineMonths) {
        prospectusStatus = "fail";
        prospectusDetail = `Non-shelf registration (${latestRegistration.form}, ${latestRegistration.date}) is ${regDays} days old with no 424B prospectus or S-1/A amendment on record. Under Section 10(a)(3), a non-shelf prospectus must be updated after 9 months or when financial statements are >16 months old. This prospectus appears STALE.`;
      } else if (latestProspectus && prospectusDays > nineMonths) {
        // Check if a post-effective amendment has been filed more recently
        if (latestAmendment && amendmentDays <= nineMonths) {
          prospectusStatus = "pass";
          prospectusDetail = `Non-shelf registration updated via ${latestAmendment.form} filed ${amendmentDays} days ago (${latestAmendment.date}). Prospectus is current under Section 10(a)(3).`;
        } else {
          prospectusStatus = "fail";
          prospectusDetail = `Last prospectus/424B was ${prospectusDays} days ago (${latestProspectus.date}). Under Section 10(a)(3), a non-shelf prospectus must be updated after 9 months. This prospectus appears STALE — a post-effective amendment (S-1/A) or new 424B is required.`;
        }
      } else if (latestProspectus) {
        prospectusStatus = "pass";
        prospectusDetail = `Most recent prospectus/424B filed ${prospectusDays} days ago on ${latestProspectus.date}. Within the Section 10(a)(3) 9-month non-shelf currency window.`;
      } else {
        prospectusStatus = "warn";
        prospectusDetail = `Registration statement (${latestRegistration.form}, ${latestRegistration.date}) found but no 424B prospectus on record. Verify whether Section 10(a)(3) update obligations have been met.`;
      }
    }
  }

  // --- CHECK 5: S-3 / Shelf Eligibility ---
  // Can this company use an S-3 (and benefit from automatic incorporation by reference)?
  let eligibilityStatus, eligibilityDetail;
  const eligibilityIssues = [];

  if (!hasMinReportingHistory) {
    eligibilityIssues.push(`Has not been an Exchange Act reporting company for 12 months (${reportingHistoryDays} days on record)`);
  }
  if (!isCurrentFiler) {
    eligibilityIssues.push("Is NOT current in all required Exchange Act filings (10-K and/or 10-Q delinquent)");
  }
  if (!latestAnnual) {
    eligibilityIssues.push("Has not filed a 10-K annual report");
  }
  if (hasNTFilings) {
    eligibilityIssues.push("Has NT (non-timely) filings on record, suggesting past reporting delinquency");
  }

  if (eligibilityIssues.length === 0) {
    eligibilityStatus = "pass";
    eligibilityDetail = `Company appears to meet the baseline eligibility requirements for S-3 registration and Section 10(a)(3) automatic prospectus updating: files 10-Ks, 10-Qs, and 8-Ks; is current in all Exchange Act reporting; has filed its latest 10-K. Note: S-3 primary offering eligibility also requires a public float ≥$75M or SRC/WKSI status — verify in the latest 10-K cover page.`;
  } else {
    eligibilityStatus = "fail";
    eligibilityDetail = `Company does NOT fully meet S-3/Section 10(a)(3) eligibility requirements:\n• ${eligibilityIssues.join("\n• ")}`;
  }

  const overallStatus =
    [annualStatus, quarterlyStatus, prospectusStatus, eligibilityStatus].includes("fail") ? "fail" :
    [annualStatus, quarterlyStatus, prospectusStatus, eligibilityStatus].includes("warn") ? "warn" : "pass";

  return Response.json({
    ticker: ticker.toUpperCase(),
    cik,
    companyName,
    isFPI,
    overallStatus,
    checks: [
      {
        id: "annual",
        label: `Annual Report (${annualFormTypes[0]}) — Current Filer Status`,
        status: annualStatus,
        detail: annualDetail,
        filingDate: latestAnnual?.date || null,
        filingUrl: edgarUrl(latestAnnual),
        filingForm: latestAnnual?.form || null,
      },
      {
        id: "quarterly",
        label: `Quarterly Reports (${isFPI ? "6-K" : "10-Q"}) — Current Filer Status`,
        status: quarterlyStatus,
        detail: quarterlyDetail,
        filingDate: latestQuarterly?.date || null,
        filingUrl: edgarUrl(latestQuarterly),
        filingForm: latestQuarterly?.form || null,
      },
      {
        id: "current",
        label: `Current Reports (${currentFormTypes[0]}) — Material Event Disclosure`,
        status: currentStatus,
        detail: currentDetail,
        filingDate: latestCurrent?.date || null,
        filingUrl: edgarUrl(latestCurrent),
        filingForm: latestCurrent?.form || null,
      },
      {
        id: "prospectus",
        label: "Section 10(a)(3) — Prospectus Currency",
        status: prospectusStatus,
        detail: prospectusDetail,
        filingDate: latestProspectus?.date || null,
        filingUrl: edgarUrl(latestProspectus),
        filingForm: latestProspectus?.form || null,
      },
      {
        id: "eligibility",
        label: "S-3 / Shelf Registration Eligibility",
        status: eligibilityStatus,
        detail: eligibilityDetail,
        filingDate: latestAnnual?.date || null,
        filingUrl: edgarUrl(latestAnnual),
        filingForm: null,
      },
    ],
    checkedAt: today.toISOString(),
  });
});