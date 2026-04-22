import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };
const EDGAR_BASE = "https://data.sec.gov/submissions";

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
};

const REG_FORMS = ["S-1", "S-3", "F-1", "F-3", "F-4", "S-11", "S-4", "S-8"];
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
    // Only show BASE forms that have been declared effective (EDGAR files an "EFFECT" notice)
    // S-8 and S-4 (for mergers) are automatically effective upon filing — no EFFECT notice needed
    const AUTO_EFFECTIVE_FORMS = ["S-8"];

    // Collect all accessions that have an associated EFFECT filing
    const effectNotices = new Set(
      filings
        .filter(f => f.form?.toUpperCase().trim() === "EFFECT")
        .map(f => {
          // EDGAR EFFECT filings reference the original registration accession in their accession number prefix
          // But the most reliable way: EFFECT filings appear in the same sequence; we cross-reference by date proximity
          // Actually EDGAR EFFECT notices carry the same accession number prefix as the reg statement they relate to
          return f.accession;
        })
    );

    // Simpler and more reliable: fetch the filing index for each reg statement to check for EFFECT
    // Too expensive to do for the list view. Instead, flag effectiveness status based on:
    // 1. Auto-effective forms (S-8)
    // 2. Whether a 424B or POS AM has been filed after (strong proxy for effectiveness)
    // 3. Whether an EFFECT form appears in the filing history around the same time

    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    const isLikelyEffective = (regFiling) => {
      const form = regFiling.form?.toUpperCase().trim();
      // S-8 is automatically effective upon filing
      if (AUTO_EFFECTIVE_FORMS.includes(form)) return { effective: true, reason: "Auto-effective upon filing" };

      const regDate = new Date(regFiling.date);

      // Check if an EFFECT notice was filed within 365 days after this reg statement
      const effectAfter = effectFilings.find(e => {
        const eDate = new Date(e.date);
        return eDate >= regDate && (eDate - regDate) < 365 * 24 * 60 * 60 * 1000;
      });
      if (effectAfter) return { effective: true, reason: `EFFECT notice filed ${effectAfter.date}`, effectDate: effectAfter.date };

      // Check if a 424B prospectus was filed after (strong proxy — only filed after effectiveness)
      const prospectusAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p));
      });
      if (prospectusAfter) return { effective: true, reason: `424B prospectus filed ${prospectusAfter.date} (proxy for effectiveness)`, effectDate: prospectusAfter.date };

      // Check if a POS AM was filed after (only filed post-effectiveness)
      const posAmAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim());
      });
      if (posAmAfter) return { effective: true, reason: `POS AM filed ${posAmAfter.date} (proxy for effectiveness)`, effectDate: posAmAfter.date };

      return { effective: false, reason: "No EFFECT notice, 424B, or POS AM found — registration may not have been declared effective" };
    };

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
        registrationStatements: regFilings.map(f => {
          const effectiveness = isLikelyEffective(f);
          return {
            form: f.form,
            date: f.date,
            accession: f.accession,
            doc: f.doc,
            url: edgarUrl(f),
            daysOld: daysSince(f.date),
            effective: effectiveness.effective,
            effectiveReason: effectiveness.reason,
            effectDate: effectiveness.effectDate || null,
          };
        }),
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

    // Helper: check if a POS AM has been declared effective by the SEC.
    // A POS AM requires its own EFFECT notice — merely filing it is not enough.
    // We look for an EFFECT filing within 60 days AFTER the POS AM date.
    const isPosAmEffective = (posAm) => {
      const posDate = new Date(posAm.date);
      return effectFilings.some(e => {
        const eDate = new Date(e.date);
        return eDate >= posDate && (eDate - posDate) <= 60 * 24 * 60 * 60 * 1000;
      });
    };

    // Pre-effective amendments (e.g. S-1/A, S-3/A)
    const baseForm = regType.split("/")[0]; // e.g. S-1 from S-1/A
    const amendments = subsequentFilings.filter(f =>
      f.form?.toUpperCase().startsWith(baseForm + "/A")
    );
    const latestAmendment = amendments[0] || null;

    // Post-effective amendments — EDGAR form type is "POS AM"
    // CRITICAL: A POS AM must itself be declared effective by the SEC to reset the 9-month clock.
    const allPostEffectiveAmendments = subsequentFilings.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim())
    );
    // Only count POS AMs that have their own EFFECT notice
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffective);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffective(f));

    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    // 424B prospectuses filed after reg (424Bs are effective upon filing — no EFFECT notice needed)
    const prospectuses = subsequentFilings.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p))
    );
    const latestProspectus = prospectuses[0] || null;

    // Annual reports filed after reg (domestic and FPI)
    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
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

    // Detect FPI: files 20-F annually (and 6-K for current/interim reports)
    // An issuer is FPI if it has 20-F filings and no 10-K filings
    const has20F = filings.some(f => f.form === "20-F" || f.form === "20-F/A");
    const has10K = filings.some(f => f.form === "10-K");
    const isFPI = has20F && !has10K;

    // Detect if this is an F-form registration (governs which FS age rules apply)
    // Even if the issuer is FPI, if they filed on a domestic form (e.g. S-4), domestic rules apply
    const isFForm = regType.startsWith("F-"); // F-1, F-3, F-4, F-4/A, etc.

    // Detect if this is likely a warrant exercise registration
    // Heuristic: F-4 forms are commonly used for business combinations/warrant registrations
    const isWarrantReg = regType.includes("F-4") || regType.includes("S-4");

    const checks = [];

    // --- CHECK 0: Was this registration statement declared effective? ---
    const effectiveness = isLikelyEffective(selectedReg);
    checks.push({
      id: "effectiveness",
      label: "Registration Statement Declared Effective",
      status: effectiveness.effective ? "pass" : "fail",
      detail: effectiveness.effective
        ? `This registration statement appears to have been declared effective. Reason: ${effectiveness.reason}.`
        : `This registration statement does NOT appear to have been declared effective. ${effectiveness.reason}. An uneffective registration statement cannot be used for offers or sales of securities.`,
      filingDate: effectiveness.effectDate || null,
      filingUrl: null,
      filingForm: null,
    });

    // =============================================================================
    // FINANCIAL STATEMENT AGE FRAMEWORK
    // =============================================================================
    //
    // DOMESTIC ISSUERS (S-1, S-3, S-4):
    //   Non-shelf: 9-month prospectus staleness / 16-month annual FS outer limit (Rule 3-12)
    //   Shelf (S-3): kept current via automatic IBR of annual/quarterly reports
    //
    // FOREIGN PRIVATE ISSUERS on F-forms (F-1, F-3, F-4) — Item 8 of Form 20-F:
    //   Standard:  15-month annual FS / 9-month interim FS at effectiveness
    //   Warrant exercise relaxation: 18-month annual FS / 12-month interim FS
    //   IBR on F-1: NOT automatic — only if prospectus expressly elects under General Instruction VI
    //   F-3 (shelf): automatic IBR of annual/interim reports like S-3
    //
    // If FPI elects to file on a domestic form, domestic rules apply instead.
    // =============================================================================

    // Thresholds in days
    const NINE_MONTHS = 274;
    const FIFTEEN_MONTHS = 456;
    const SIXTEEN_MONTHS = 487;
    const TWELVE_MONTHS = 365;
    const EIGHTEEN_MONTHS = 548;

    // Annual FS age limit: 15 months for F-forms, 16 months for domestic
    // Relaxed to 18 months for warrant exercise F-forms
    const ANNUAL_LIMIT = isFForm
      ? (isWarrantReg ? EIGHTEEN_MONTHS : FIFTEEN_MONTHS)
      : SIXTEEN_MONTHS;

    // Interim FS staleness limit: 9 months standard, 12 months for warrant exercise F-forms
    const INTERIM_LIMIT = (isFForm && isWarrantReg) ? TWELVE_MONTHS : NINE_MONTHS;

    // Hoist variables used in both shelf and non-shelf branches AND in subsequent checks
    const effectiveDate = effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;
    const mostRecentEffectiveUpdate = [latestProspectus, latestPostEffective]
      .filter(Boolean)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

    let fsStatus, fsDetail;
    let annualStatus, annualDetail;

    if (isShelf) {
      // -------------------------------------------------------------------------
      // SHELF (S-3/F-3): kept current via automatic IBR of annual/quarterly reports.
      // Company must be a current Exchange Act filer. Each new annual report auto-incorporates.
      // -------------------------------------------------------------------------
      const annualFormLabel = isFPI ? "20-F" : "10-K";
      if (!latestAnnual) {
        fsStatus = "fail";
        fsDetail = `STALE — No annual report (${annualFormLabel}) found after this shelf registration. A shelf prospectus is kept current via incorporation by reference of annual reports. Without any ${annualFormLabel} filed after the shelf, there are no financials incorporated by reference. Shelf is NOT usable.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        if (annualDays > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsDetail = `STALE — ANNUAL FS AGE VIOLATION: Most recent annual report (${latestAnnual.form}, ${latestAnnual.date}) is ${annualDays} days old — exceeds the ${Math.round(ANNUAL_LIMIT/30)}-month limit under ${isFForm ? "Item 8 of Form 20-F" : "Rule 3-12"}. The audited financials incorporated by reference into this shelf are too old. A new ${annualFormLabel} must be filed and incorporated before the shelf can be used.`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Shelf is kept current via IBR of ${latestAnnual.form} (${latestAnnual.date}, ${annualDays} days ago). Audited financials are within the ${Math.round(ANNUAL_LIMIT/30)}-month limit under ${isFForm ? "Item 8 of Form 20-F" : "Rule 3-12"}. Prospectus is usable under Section 10(a)(3).`;
        }
      }

      annualStatus = fsStatus === "pass" ? "pass" : "fail";
      annualDetail = fsDetail;

    } else {
      // -------------------------------------------------------------------------
      // NON-SHELF (S-1/F-1/F-4): Two-step analysis
      // Domestic: 9-month prospectus staleness + 16-month annual FS outer limit
      // FPI F-form: 9-month (or 12-month for warrants) interim + 15-month (18-month warrants) annual
      // NOTE: F-1 IBR is NOT automatic — only if the prospectus expressly elects it under General Instruction VI
      // -------------------------------------------------------------------------

      const pendingNote = latestPendingPosAm
        ? ` ⚠ POS AM filed ${latestPendingPosAm.date} has NOT been declared effective (no EFFECT notice) — it does NOT update the live prospectus until the SEC issues effectiveness.`
        : "";

      // --- STEP 1: INTERIM STALENESS TEST ---
      // Clock runs from original effective date OR most recent valid update, whichever is later.
      const interimClockBase = mostRecentEffectiveUpdate
        ? new Date(mostRecentEffectiveUpdate.date)
        : effectiveDate;
      const daysSinceInterimClock = Math.floor((new Date() - interimClockBase) / (1000 * 60 * 60 * 24));
      const interimViolation = daysSinceInterimClock > INTERIM_LIMIT;

      const interimClockLabel = mostRecentEffectiveUpdate
        ? `${mostRecentEffectiveUpdate.form} filed ${mostRecentEffectiveUpdate.date}`
        : `original effective date ${interimClockBase.toISOString().split("T")[0]}`;

      // --- STEP 2: ANNUAL FS STALENESS TEST ---
      // For F-forms WITHOUT express IBR election: the annual FS in the live prospectus
      // are those that were in the original reg or last declared-effective POS AM.
      // A 6-K or 20-F filed with the SEC does NOT automatically update an F-1 prospectus
      // unless IBR was expressly elected in the original registration.
      // We cannot reliably detect IBR election from EDGAR metadata alone — we flag it as a note.

      // Annuals filed at or before effective date (what was in the reg at effectiveness)
      const annualsInOriginalReg = annuals.filter(f => new Date(f.date) <= effectiveDate);
      const annualInOriginalReg = annualsInOriginalReg[0] || null;

      // Most recent effective document (POS AM or 424B that is the live prospectus baseline)
      const liveProspectusBaseline = mostRecentEffectiveUpdate;

      // Determine: what annual financials are currently IN the live prospectus?
      let annualInLiveProspectus = null;
      let annualInLiveProspectusSource = "";

      if (liveProspectusBaseline) {
        const baselineDate = new Date(liveProspectusBaseline.date);
        const annualsAtBaseline = annuals.filter(f => new Date(f.date) <= baselineDate);
        annualInLiveProspectus = annualsAtBaseline[0] || null;
        annualInLiveProspectusSource = annualInLiveProspectus
          ? `incorporated via ${liveProspectusBaseline.form} (${liveProspectusBaseline.date})`
          : `no annual available at baseline date ${liveProspectusBaseline.date}`;
      } else {
        annualInLiveProspectus = annualInOriginalReg;
        annualInLiveProspectusSource = annualInLiveProspectus
          ? `in original registration effective ${effectiveDate.toISOString().split("T")[0]}`
          : "no annual found in original registration";
      }

      const annualDaysInLiveProspectus = annualInLiveProspectus ? daysSince(annualInLiveProspectus.date) : null;
      const annualViolation = annualDaysInLiveProspectus !== null && annualDaysInLiveProspectus > ANNUAL_LIMIT;

      // Unincorporated interim reports (10-Qs for domestic; 6-Ks for FPI)
      // FPIs file 6-Ks — but 6-Ks only update the prospectus if they are expressly incorporated
      const interimFilings = isFPI
        ? subsequentFilings.filter(f => f.form === "6-K" || f.form === "6-K/A")
        : quarterlies;
      const unincorporatedInterims = liveProspectusBaseline
        ? interimFilings.filter(f => new Date(f.date) > new Date(liveProspectusBaseline.date))
        : interimFilings;
      const unincorporatedCount = unincorporatedInterims.length;

      const interimFormLabel = isFPI ? "6-K" : "10-Q";
      const annualLimitLabel = `${Math.round(ANNUAL_LIMIT/30)}-month`;
      const interimLimitLabel = `${Math.round(INTERIM_LIMIT/30)}-month`;
      const ruleRef = isFForm ? "Item 8 of Form 20-F" : "Rule 3-12";
      const warrantNote = isWarrantReg ? " (relaxed limit applies for outstanding transferable warrant exercise registrations)" : "";

      // --- COMPOSE THE PROSPECTUS CURRENCY STATUS ---
      if (!effectiveness.effective) {
        fsStatus = "fail";
        fsDetail = `Registration statement not yet declared effective — prospectus cannot be used at all.${pendingNote}`;
      } else if (annualViolation) {
        fsStatus = "fail";
        fsDetail = `STALE — ${ruleRef} ANNUAL FS VIOLATION: The audited annual financials in the live prospectus (${annualInLiveProspectus.form} ${annualInLiveProspectus.date}, ${annualInLiveProspectusSource}) are ${annualDaysInLiveProspectus} days old — exceeding the ${annualLimitLabel} outer limit${warrantNote}. The prospectus CANNOT be used. ${isFForm ? `Note: For F-1/F-4 registrations, later-filed 20-F annual reports do NOT automatically update the live prospectus unless the registration expressly elected IBR under Form 20-F General Instruction VI. ${unincorporatedCount > 0 ? `${unincorporatedCount} ${interimFormLabel}(s) have been filed but are NOT part of the live prospectus unless expressly incorporated.` : ""}` : `Even if interim financials have been filed with the SEC (${unincorporatedCount} unincorporated ${interimFormLabel}(s) on EDGAR), those are NOT part of the live prospectus unless expressly incorporated via a 424B3 supplement or declared-effective POS AM.`} A POS AM with updated AUDITED annual financials must be filed and declared effective.${pendingNote}`;
      } else if (interimViolation) {
        const projectedAnnualExpiry = annualInLiveProspectus
          ? new Date(new Date(annualInLiveProspectus.date).getTime() + ANNUAL_LIMIT * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
          : "unknown";
        fsStatus = "fail";
        fsDetail = `STALE — ${ruleRef} INTERIM STALENESS VIOLATION: The live prospectus has not been updated in ${daysSinceInterimClock} days (clock running from ${interimClockLabel}) — exceeding the ${interimLimitLabel} limit${warrantNote}. The prospectus CANNOT be used. ${isFForm ? `For F-1/F-4 registrations, the clock is reset only by a valid 424B supplement or declared-effective POS AM — NOT by filing a ${interimFormLabel} with the SEC unless expressly incorporated.` : `10-Q filings alone do not update the prospectus.`} The audited annual financials (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) would expire around ${projectedAnnualExpiry} under the ${annualLimitLabel} annual limit.${pendingNote}`;
      } else {
        if (unincorporatedCount > 0) {
          fsStatus = "warn";
          fsDetail = `INTERIM UPDATE GAP — Prospectus is within the ${interimLimitLabel} interim window (${daysSinceInterimClock} days since ${interimClockLabel}), but ${unincorporatedCount} subsequent ${interimFormLabel}(s) have been filed with the SEC and are NOT expressly incorporated into the live prospectus. ${isFForm ? `For F-1/F-4 registrations, 6-K filings do NOT automatically update the prospectus — a 424B3 supplement or declared-effective POS AM is required.` : `A 424B3 supplement or declared-effective POS AM is required to incorporate them.`} Audited annuals in the live prospectus (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) have ${annualDaysInLiveProspectus !== null ? ANNUAL_LIMIT - annualDaysInLiveProspectus : "?"} days before the ${annualLimitLabel} outer limit.${pendingNote}`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Prospectus is within the ${interimLimitLabel} interim window (${daysSinceInterimClock} days since ${interimClockLabel}). Audited annuals in the live prospectus (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) are ${annualDaysInLiveProspectus} days old — within the ${annualLimitLabel} limit under ${ruleRef}${warrantNote}. Prospectus is usable.${pendingNote}`;
        }
      }

      // Annual status check — separate check for annual filing currency
      const annualFormLabel = isFPI ? "20-F" : "10-K";
      if (!latestAnnual) {
        annualStatus = "info";
        annualDetail = `No ${annualFormLabel} filed after this registration statement. If the offering is ongoing, the prospectus cannot be updated with new annual financials until a ${annualFormLabel} is filed.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        const latestAnnualInProspectus = annualInLiveProspectus && annualInLiveProspectus.accession === latestAnnual.accession;
        if (latestAnnualInProspectus) {
          annualStatus = annualDays <= ANNUAL_LIMIT ? "pass" : "fail";
          annualDetail = annualStatus === "pass"
            ? `Most recent ${annualFormLabel} (${latestAnnual.date}, ${annualDays} days ago) is incorporated into the live prospectus (${annualInLiveProspectusSource}). Annual financials are within the ${annualLimitLabel} limit.`
            : `Most recent ${annualFormLabel} (${latestAnnual.date}, ${annualDays} days ago) has exceeded the ${annualLimitLabel} annual FS age limit.`;
        } else {
          annualStatus = "warn";
          annualDetail = `A more recent ${annualFormLabel} (${latestAnnual.form}, ${latestAnnual.date}) has been filed with the SEC but is NOT part of the live prospectus. The live prospectus still contains the older annual financials (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}). ${isFForm ? `For F-1/F-4 registrations, a later-filed 20-F does NOT auto-incorporate unless the prospectus expressly elected IBR under Form 20-F General Instruction VI.` : ""} To update: file a 424B3 supplement or a POS AM (must be declared effective) that expressly incorporates the new ${annualFormLabel}.`;
        }
      }
    }

    checks.push({
      id: "financial_statements",
      label: isFForm
        ? `Prospectus Currency — Item 8 Form 20-F (${Math.round(ANNUAL_LIMIT/30)}-mo annual / ${Math.round(INTERIM_LIMIT/30)}-mo interim)`
        : "Prospectus Currency — Section 10(a)(3) / Rule 427",
      status: fsStatus,
      detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus),
      filingForm: latestPostEffective?.form || latestProspectus?.form || null,
    });

    checks.push({
      id: "annual_reports",
      label: isFPI
        ? `Annual Financials In Live Prospectus (${Math.round(ANNUAL_LIMIT/30)}-Month Limit — Form 20-F)`
        : `Annual Financials In Live Prospectus (16-Month Rule 3-12 Limit)`,
      status: annualStatus,
      detail: annualDetail,
      filingDate: latestAnnual?.date || null,
      filingUrl: edgarUrl(latestAnnual),
      filingForm: latestAnnual?.form || null,
      count: annuals.length,
    });

    // --- CHECK C: Interim Reports — EDGAR Currency + Prospectus Incorporation Gap ---
    // For FPIs: no 10-Q obligation — they file 6-Ks for current/interim information
    // For domestic: 10-Q is required for Q1, Q2, Q3 (no Q4 — covered by 10-K)
    // In either case, filing a periodic report does NOT automatically update a non-shelf prospectus

    let quarterlyStatus, quarterlyDetail;
    const annualDateForQ = latestAnnual ? new Date(latestAnnual.date) : null;
    const annualDaysForQ = latestAnnual ? daysSince(latestAnnual.date) : null;

    if (isFPI) {
      // FPIs have no 10-Q requirement — they furnish 6-Ks
      const sixKs = subsequentFilings.filter(f => f.form === "6-K" || f.form === "6-K/A");
      const latestSixK = sixKs[0] || null;
      const liveProspectusBaselineDate = !isShelf && mostRecentEffectiveUpdate
        ? new Date(mostRecentEffectiveUpdate.date)
        : effectiveDate;
      const unincorporated6Ks = !isShelf
        ? sixKs.filter(f => new Date(f.date) > liveProspectusBaselineDate)
        : [];

      if (!latestSixK) {
        quarterlyStatus = "info";
        quarterlyDetail = `Foreign Private Issuer — no Form 10-Q obligation. FPIs furnish interim material information via Form 6-K. No 6-K filings found since this registration statement.`;
      } else {
        const sixKDays = daysSince(latestSixK.date);
        if (!isShelf && unincorporated6Ks.length > 0) {
          quarterlyStatus = "warn";
          quarterlyDetail = `FPI INTERIM INCORPORATION GAP: ${sixKs.length} 6-K(s) filed since registration (most recent: ${latestSixK.date}, ${sixKDays} days ago). ${unincorporated6Ks.length} 6-K(s) filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. For F-1/F-4 registrations, 6-Ks do NOT automatically update the prospectus — a 424B3 supplement or declared-effective POS AM expressly incorporating the 6-K is required.`;
        } else {
          quarterlyStatus = "pass";
          quarterlyDetail = `Foreign Private Issuer — ${sixKs.length} 6-K(s) filed since registration (most recent: ${latestSixK.date}, ${sixKDays} days ago). Note: No Form 10-Q is required for FPIs.`;
        }
      }
      checks.push({
        id: "quarterly_reports",
        label: "Interim Reports (6-K) — FPI Current Information",
        status: quarterlyStatus,
        detail: quarterlyDetail,
        filingDate: latestSixK?.date || null,
        filingUrl: edgarUrl(latestSixK),
        filingForm: latestSixK?.form || null,
        count: sixKs.length,
      });
    } else {
      // Domestic: 10-Q for Q1, Q2, Q3
      const quartersFiledSinceAnnual = annualDateForQ
        ? quarterlies.filter(f => new Date(f.date) > annualDateForQ).length
        : 0;

      let expectedQ = 0;
      if (annualDaysForQ !== null) {
        if (annualDaysForQ > 270) expectedQ = 3;
        else if (annualDaysForQ > 180) expectedQ = 2;
        else if (annualDaysForQ > 90) expectedQ = 1;
      }

      const liveProspectusBaselineDate = !isShelf && mostRecentEffectiveUpdate
        ? new Date(mostRecentEffectiveUpdate.date)
        : effectiveDate;
      const unincorporatedQuarterlies = !isShelf
        ? quarterlies.filter(f => new Date(f.date) > liveProspectusBaselineDate)
        : [];

      if (!annualDateForQ) {
        quarterlyStatus = "info";
        quarterlyDetail = "No 10-K filed after this registration — cannot assess 10-Q currency without an annual baseline.";
      } else if (expectedQ === 0) {
        quarterlyStatus = "pass";
        quarterlyDetail = `10-K filed ${annualDaysForQ} days ago — no quarterly report is yet due. No quarterly incorporation gap.`;
      } else if (quartersFiledSinceAnnual < expectedQ) {
        const missing = expectedQ - quartersFiledSinceAnnual;
        quarterlyStatus = "fail";
        quarterlyDetail = `EDGAR FILING GAP: Only ${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K (${latestAnnual.date}). ${missing} report(s) missing — company may be delinquent in Exchange Act reporting.`;
      } else if (!isShelf && unincorporatedQuarterlies.length > 0) {
        quarterlyStatus = "warn";
        quarterlyDetail = `PROSPECTUS INCORPORATION GAP: Company is current in filing 10-Qs with the SEC (${quartersFiledSinceAnnual} filed since last 10-K), but ${unincorporatedQuarterlies.length} 10-Q(s) filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. A 10-Q filed with the SEC does NOT update a non-shelf prospectus. To incorporate: file a 424B3 supplement or a declared-effective POS AM. Most recent unincorporated: ${unincorporatedQuarterlies[0].form} ${unincorporatedQuarterlies[0].date}.`;
      } else {
        quarterlyStatus = "pass";
        quarterlyDetail = `${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K. Quarterly Exchange Act reporting is current. (No Q4 10-Q required — covered by 10-K.)`;
      }
      checks.push({
        id: "quarterly_reports",
        label: "Quarterly Reports (10-Q) — EDGAR Currency & Prospectus Incorporation",
        status: quarterlyStatus,
        detail: quarterlyDetail,
        filingDate: latestQuarterly?.date || null,
        filingUrl: edgarUrl(latestQuarterly),
        filingForm: latestQuarterly?.form || null,
        count: quarterlies.length,
      });
    }

    // --- CHECK D: Current Reports (8-K for domestic / 6-K for FPI) ---
    let currentStatus, currentDetail;
    if (isFPI) {
      // FPIs furnish 6-Ks instead of 8-Ks — already handled in the interim reports check above
      // Add an informational note here rather than a separate check
      currentStatus = "info";
      currentDetail = "Foreign Private Issuer — no Form 8-K obligation. Material current information is furnished via Form 6-K (see Interim Reports check above).";
    } else {
      if (!latestCurrent) {
        currentStatus = "warn";
        currentDetail = "No 8-K current reports filed since this registration statement. Verify whether any material events have occurred that required disclosure.";
      } else {
        const cDays = daysSince(latestCurrent.date);
        currentStatus = cDays <= 365 ? "pass" : "warn";
        currentDetail = `Most recent 8-K filed ${cDays} days ago on ${latestCurrent.date}. ${currentReports.length} total 8-K(s) filed since registration.`;
      }
    }
    checks.push({
      id: "current_reports",
      label: isFPI ? "Current Reports — FPI (6-K vs 8-K)" : "Current Reports (8-K) Filed Since Registration",
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
      amendDetail = "Shelf registrations (S-3/F-3) are kept current via annual report incorporation by reference — POS AM filings are not required for Section 10(a)(3) compliance.";
    } else if (allPostEffectiveAmendments.length === 0) {
      amendStatus = "info";
      amendDetail = "No POS AM filings found for this registration statement.";
    } else if (effectivePostEffectiveAmendments.length === 0) {
      amendStatus = "fail";
      amendDetail = `${allPostEffectiveAmendments.length} POS AM(s) filed but NONE have been declared effective by the SEC (no EFFECT notice found). A filed POS AM does NOT satisfy Section 10(a)(3) until the SEC issues an effectiveness order. Most recent filed (not effective): ${latestPendingPosAm.form} on ${latestPendingPosAm.date}.`;
    } else {
      const aDays = daysSince(latestPostEffective.date);
      const pendingNote2 = latestPendingPosAm ? ` Additionally, ${pendingPostEffectiveAmendments.length} POS AM(s) are filed but not yet declared effective.` : "";
      amendStatus = "pass";
      amendDetail = `${effectivePostEffectiveAmendments.length} effective POS AM(s) on record. Most recent effective: ${latestPostEffective.form} on ${latestPostEffective.date} (${aDays} days ago).${pendingNote2}`;
    }
    checks.push({
      id: "amendments",
      label: "Post-Effective Amendments (POS AM)",
      status: amendStatus,
      detail: amendDetail,
      filingDate: latestPostEffective?.date || latestPendingPosAm?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestPendingPosAm),
      filingForm: latestPostEffective?.form || latestPendingPosAm?.form || null,
      count: allPostEffectiveAmendments.length,
      effectiveCount: effectivePostEffectiveAmendments.length,
    });

    const overallStatus =
      checks.some(c => c.status === "fail") ? "fail" :
      checks.some(c => c.status === "warn") ? "warn" : "pass";

    // AI plain-English verdict
    const checkSummary = checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n");

    const fpiFrameworkNote = isFForm
      ? `This is an FPI filing on an F-form (${selectedReg.form}). The governing rules are Item 8 of Form 20-F, NOT the domestic 9-month/16-month framework. Annual FS limit: ${Math.round(ANNUAL_LIMIT/30)} months${isWarrantReg ? " (18-month relaxation for outstanding transferable warrant exercise registrations)" : ""}. Interim FS limit: ${Math.round(INTERIM_LIMIT/30)} months. IBR on F-1/F-4 is NOT automatic — only if the prospectus expressly elected it under General Instruction VI of Form 20-F. FPIs file 20-F (not 10-K) and 6-K (not 10-Q or 8-K).`
      : `Domestic issuer framework: Section 10(a)(3) / Rule 427 — 9-month interim staleness / 16-month annual FS outer limit.`;

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `You are a securities law compliance expert.

${fpiFrameworkNote}

Company: ${companyName} (${ticker.toUpperCase()})
Form: ${selectedReg.form} filed ${selectedReg.date}
Type: ${isShelf ? "Shelf" : "Non-Shelf"} | FPI: ${isFPI ? "Yes" : "No"} | F-form: ${isFForm ? "Yes" : "No"}

Compliance checks:
${checkSummary}

Give a direct answer (2-3 sentences): Can this registration be used TODAY for offers/sales? What is the single most critical reason? What must be done to cure it?`,
      response_json_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] },
          summary: { type: "string" },
          key_issue: { type: "string" },
          required_action: { type: "string" }
        }
      }
    });

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
        isFPI,
        isFForm,
        isWarrantReg,
        annualLimitMonths: Math.round(ANNUAL_LIMIT / 30),
        interimLimitMonths: Math.round(INTERIM_LIMIT / 30),
      },
      overallStatus,
      aiSummary: aiSummary || null,
      checks,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});