import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };
const EDGAR_BASE = "https://data.sec.gov/submissions";

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
};

const REG_FORMS = ["S-1", "S-3", "F-1", "F-3", "S-11", "S-4", "S-8"];
const AMENDMENT_FORMS = ["S-1/A", "S-3/A", "F-1/A", "F-3/A", "S-4/A", "S-11/A"];
const POST_EFFECTIVE_FORMS = ["POS AM", "POS AM/A"];
const PROSPECTUS_FORMS = ["424B1", "424B2", "424B3", "424B4", "424B5", "424B7", "424B8", "PROSPECTUS"];

// Check if a form string is a registration statement (base or amendment)
const isRegForm = (form) => {
  if (!form) return false;
  const f = form.toUpperCase().trim();
  // Match base forms and their /A amendments
  return REG_FORMS.some(r => f === r || f === r + "/A" || f.startsWith(r + "/"));
};

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { ticker, accession } = body;

    if (!ticker) return Response.json({ error: "ticker is required" }, { status: 400 });

    // Step 1: Resolve ticker -> CIK
    const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: HEADERS });
    const tickerData = await tickerRes.json();

    let cik = null, companyName = null;
    for (const entry of Object.values(tickerData)) {
      if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title;
        break;
      }
    }
    if (!cik) return Response.json({ error: `Could not find CIK for ticker: ${ticker}` }, { status: 404 });

    // Step 2: Fetch ALL filings — recent page + all historical pagination files
    const subRes = await fetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
    if (!subRes.ok) return Response.json({ error: "Failed to fetch EDGAR submissions" }, { status: 500 });
    const subData = await subRes.json();

    const mergeFilingPage = (acc, page) => {
      const forms = page.form || [];
      const dates = page.filingDate || [];
      const accessions = page.accessionNumber || [];
      const docs = page.primaryDocument || [];
      for (let i = 0; i < forms.length; i++) {
        if (forms[i] && dates[i]) {
          acc.push({ form: forms[i], date: dates[i], accession: accessions[i], doc: docs[i] });
        }
      }
      return acc;
    };

    let filings = [];
    mergeFilingPage(filings, subData.filings?.recent || {});

    // Fetch ALL additional historical pages in parallel
    const additionalFiles = subData.filings?.files || [];
    if (additionalFiles.length > 0) {
      const pageResponses = await Promise.all(
        additionalFiles.map(f => fetch(`https://data.sec.gov${f.name}`, { headers: HEADERS }))
      );
      for (const pageRes of pageResponses) {
        if (pageRes.ok) {
          const p = await pageRes.json();
          mergeFilingPage(filings, p);
        }
      }
    }

    const edgarUrl = (f) => f
      ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${f.accession.replace(/-/g, "")}/${f.doc}`
      : null;

    const edgarIndexUrl = (f) => f
      ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${parseInt(cik)}&type=${f.form}&dateb=&owner=include&count=40`
      : null;

    // Step 3: If no accession selected, return list of all registration statements
    // Only show BASE forms (not /A amendments) in the list — user picks the original filing
    const regFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      return REG_FORMS.some(r => form === r);
    });

    if (!accession) {
      // Return list of registration statements for user to pick from
      return Response.json({
        mode: "list",
        ticker: ticker.toUpperCase(),
        cik,
        companyName,
        registrationStatements: regFilings.map(f => ({
          form: f.form,
          date: f.date,
          accession: f.accession,
          doc: f.doc,
          url: edgarUrl(f),
          daysOld: daysSince(f.date),
        })),
      });
    }

    // Step 4: Deep-check the selected registration statement
    const selectedReg = filings.find(f => f.accession === accession);
    if (!selectedReg) return Response.json({ error: "Registration statement not found" }, { status: 404 });

    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isAmendment = AMENDMENT_FORMS.some(a => regType === a);

    // All filings AFTER the registration date
    const subsequentFilings = filings.filter(f => new Date(f.date) > regDate);

    // Pre-effective amendments (e.g. S-1/A, S-3/A)
    const baseForm = regType.split("/")[0]; // e.g. S-1 from S-1/A
    const amendments = subsequentFilings.filter(f =>
      f.form?.toUpperCase().startsWith(baseForm + "/A")
    );
    const latestAmendment = amendments[0] || null;

    // Post-effective amendments — EDGAR form type is "POS AM" (not /A)
    const postEffectiveAmendments = subsequentFilings.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim())
    );
    const latestPostEffective = postEffectiveAmendments[0] || null;

    // 424B prospectuses filed after reg
    const prospectuses = subsequentFilings.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p))
    );
    const latestProspectus = prospectuses[0] || null;

    // Annual reports filed after reg
    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A"
    );
    const latestAnnual = annuals[0] || null;

    // Quarterly reports filed after reg
    const quarterlies = subsequentFilings.filter(f =>
      f.form === "10-Q" || f.form === "10-Q/A"
    );
    const latestQuarterly = quarterlies[0] || null;

    // 8-Ks filed after reg
    const currentReports = subsequentFilings.filter(f => f.form?.startsWith("8-K"));
    const latestCurrent = currentReports[0] || null;

    const checks = [];

    // --- CHECK A: Financial Statement Currency (Rule 3-12) ---
    // Financial statements in a registration statement must not be more than 135 days old
    // at effectiveness. After that, under Section 10(a)(3), annual updates are required.
    let fsStatus, fsDetail;
    if (isShelf) {
      if (latestAnnual) {
        const annualDays = daysSince(latestAnnual.date);
        if (annualDays <= 365) {
          fsStatus = "pass";
          fsDetail = `Shelf registration automatically updated via incorporation by reference of ${latestAnnual.form} filed ${annualDays} days ago (${latestAnnual.date}). Financial statements are current under Rule 3-12.`;
        } else {
          fsStatus = "fail";
          fsDetail = `Last incorporated annual report (${latestAnnual.form}, ${latestAnnual.date}) is ${annualDays} days old. A new annual report must have been filed and incorporated to keep this shelf current under Section 10(a)(3).`;
        }
      } else {
        fsStatus = "fail";
        fsDetail = "No annual report found after this shelf registration. Financial statements cannot be incorporated by reference — shelf is stale under Section 10(a)(3).";
      }
    } else {
      // S-1/F-1: financial statements must not be older than 135 days at effectiveness
      // After 9 months from filing, need a post-effective amendment (S-1/A) or new 424B
      const nineMonths = 274;
      const sixteenMonths = 487;

      // Find the most recent update — 424B, pre-effective amendment, or POS AM
      const mostRecentUpdate = [latestAmendment, latestProspectus, latestPostEffective]
        .filter(Boolean)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

      const updateDays = mostRecentUpdate ? daysSince(mostRecentUpdate.date) : null;
      const effectiveDays = updateDays !== null ? updateDays : regDays;

      if (effectiveDays <= nineMonths) {
        fsStatus = "pass";
        fsDetail = mostRecentUpdate
          ? `Most recent prospectus/amendment (${mostRecentUpdate.form}, ${mostRecentUpdate.date}) is ${effectiveDays} days old — within the Section 10(a)(3) 9-month window. Financial statements are current.`
          : `Registration statement is ${regDays} days old — within the 9-month Section 10(a)(3) window. Financial statements are current.`;
      } else if (effectiveDays <= sixteenMonths) {
        fsStatus = "warn";
        fsDetail = `Most recent document (${mostRecentUpdate?.form || selectedReg.form}, ${mostRecentUpdate?.date || selectedReg.date}) is ${effectiveDays} days old — past the 9-month Section 10(a)(3) threshold. A post-effective amendment (${baseForm}/A) or updated 424B is required to keep financial statements current. Financial statements may be stale.`;
      } else {
        fsStatus = "fail";
        fsDetail = `Most recent document (${mostRecentUpdate?.form || selectedReg.form}, ${mostRecentUpdate?.date || selectedReg.date}) is ${effectiveDays} days old — past the 16-month Rule 3-12 financial statement age limit. Financial statements are STALE. A post-effective amendment with updated financials is required.`;
      }
    }
    checks.push({
      id: "financial_statements",
      label: "Financial Statement Currency (Rule 3-12 / Section 10(a)(3))",
      status: fsStatus,
      detail: fsDetail,
      filingDate: latestAmendment?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestAmendment || latestProspectus),
      filingForm: latestAmendment?.form || latestProspectus?.form || null,
    });

    // --- CHECK B: Annual Report Updates ---
    let annualStatus, annualDetail;
    if (!latestAnnual) {
      annualStatus = isShelf ? "fail" : "info";
      annualDetail = isShelf
        ? "No 10-K filed after this shelf registration. A shelf prospectus requires incorporation by reference of subsequent annual reports."
        : "No 10-K filed after this registration statement. If this is an ongoing offering, annual updates are required under Section 10(a)(3).";
    } else {
      const annualDays = daysSince(latestAnnual.date);
      annualStatus = annualDays <= 455 ? "pass" : "fail";
      annualDetail = annualStatus === "pass"
        ? `${latestAnnual.form} filed ${annualDays} days ago on ${latestAnnual.date}. Annual reporting is current since registration.`
        : `Last ${latestAnnual.form} was ${annualDays} days ago (${latestAnnual.date}). Company may have missed an annual reporting cycle since this registration was filed.`;
    }
    checks.push({
      id: "annual_reports",
      label: `Annual Reports (10-K) Filed Since Registration`,
      status: annualStatus,
      detail: annualDetail,
      filingDate: latestAnnual?.date || null,
      filingUrl: edgarUrl(latestAnnual),
      filingForm: latestAnnual?.form || null,
      count: annuals.length,
    });

    // --- CHECK C: Quarterly Reports (10-Q) ---
    // Determine expected Q count based on how long since last 10-K (no Q4 rule)
    let quarterlyStatus, quarterlyDetail;
    const annualDateForQ = latestAnnual ? new Date(latestAnnual.date) : null;
    const annualDaysForQ = latestAnnual ? daysSince(latestAnnual.date) : null;
    const quartersFiledSinceAnnual = annualDateForQ
      ? quarterlies.filter(f => new Date(f.date) > annualDateForQ).length
      : 0;

    let expectedQ = 0;
    if (annualDaysForQ !== null) {
      if (annualDaysForQ > 270) expectedQ = 3;
      else if (annualDaysForQ > 180) expectedQ = 2;
      else if (annualDaysForQ > 90) expectedQ = 1;
    }

    if (!annualDateForQ) {
      quarterlyStatus = "info";
      quarterlyDetail = "No 10-K filed after this registration — cannot assess 10-Q currency without an annual baseline.";
    } else if (expectedQ === 0) {
      quarterlyStatus = "pass";
      quarterlyDetail = `10-K was filed ${annualDaysForQ} days ago — no quarterly report is due yet (within the Q1 window).`;
    } else if (quartersFiledSinceAnnual >= expectedQ) {
      quarterlyStatus = "pass";
      quarterlyDetail = `${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since the last 10-K. Quarterly reporting is current. (No Q4 10-Q required — covered by the 10-K.)`;
    } else {
      const missing = expectedQ - quartersFiledSinceAnnual;
      quarterlyStatus = "fail";
      quarterlyDetail = `Only ${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since the last 10-K (${latestAnnual.date}). ${missing} report(s) appear missing.`;
    }
    checks.push({
      id: "quarterly_reports",
      label: "Quarterly Reports (10-Q) Current Since Last 10-K",
      status: quarterlyStatus,
      detail: quarterlyDetail,
      filingDate: latestQuarterly?.date || null,
      filingUrl: edgarUrl(latestQuarterly),
      filingForm: latestQuarterly?.form || null,
      count: quarterlies.length,
    });

    // --- CHECK D: Current Reports (8-K) ---
    let currentStatus, currentDetail;
    if (!latestCurrent) {
      currentStatus = "warn";
      currentDetail = "No 8-K current reports filed since this registration statement. Verify whether any material events have occurred that required disclosure.";
    } else {
      const cDays = daysSince(latestCurrent.date);
      currentStatus = cDays <= 365 ? "pass" : "warn";
      currentDetail = `Most recent 8-K filed ${cDays} days ago on ${latestCurrent.date}. ${currentReports.length} total 8-K(s) filed since registration.`;
    }
    checks.push({
      id: "current_reports",
      label: "Current Reports (8-K) Filed Since Registration",
      status: currentStatus,
      detail: currentDetail,
      filingDate: latestCurrent?.date || null,
      filingUrl: edgarUrl(latestCurrent),
      filingForm: latestCurrent?.form || null,
      count: currentReports.length,
    });

    // --- CHECK E: Post-Effective Amendments (POS AM) ---
    let amendStatus, amendDetail;
    if (isShelf) {
      amendStatus = "info";
      amendDetail = "Shelf registrations (S-3/F-3) are kept current via annual report incorporation by reference — post-effective amendments (POS AM) are not required annually, though they may be filed for other updates.";
    } else if (postEffectiveAmendments.length === 0 && regDays > 274) {
      amendStatus = "warn";
      amendDetail = `No post-effective amendments (POS AM) found after this registration statement, which is now ${regDays} days old. For ongoing offerings past 9 months, a POS AM with updated financial statements is generally required under Section 10(a)(3).`;
    } else if (postEffectiveAmendments.length > 0) {
      const aDays = daysSince(latestPostEffective.date);
      amendStatus = aDays <= 274 ? "pass" : "warn";
      amendDetail = `${postEffectiveAmendments.length} post-effective amendment(s) (POS AM) filed. Most recent: ${latestPostEffective.form} on ${latestPostEffective.date} (${aDays} days ago).`;
    } else {
      amendStatus = "pass";
      amendDetail = `Registration is ${regDays} days old — still within the 9-month Section 10(a)(3) window. No POS AM required yet.`;
    }
    checks.push({
      id: "amendments",
      label: "Post-Effective Amendments (POS AM)",
      status: amendStatus,
      detail: amendDetail,
      filingDate: latestPostEffective?.date || null,
      filingUrl: edgarUrl(latestPostEffective),
      filingForm: latestPostEffective?.form || null,
      count: postEffectiveAmendments.length,
    });

    const overallStatus =
      checks.some(c => c.status === "fail") ? "fail" :
      checks.some(c => c.status === "warn") ? "warn" : "pass";

    return Response.json({
      mode: "detail",
      ticker: ticker.toUpperCase(),
      cik,
      companyName,
      registration: {
        form: selectedReg.form,
        date: selectedReg.date,
        accession: selectedReg.accession,
        daysOld: regDays,
        url: edgarUrl(selectedReg),
        isShelf,
      },
      overallStatus,
      checks,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});