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

    // Warrant exercise relaxation applies ONLY to FPI F-forms (F-4), not domestic S-4.
    // Domestic S-4 always uses 16-month annual / 9-month interim limits.
    const isWarrantReg = isFForm && (regType.includes("F-4"));

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
    // DOMESTIC ISSUERS (S-1, S-3, S-4) — Rule 3-12 / Rule 427:
    //   9-MONTH CLOCK: Measured from reg_effective_date (NOT from any POS AM or 424B supplement).
    //     A 424B supplement or effective POS AM does NOT reset the 9-month clock for domestic issuers.
    //     After 9 months, the prospectus can still be used IF the audited annual FS are within 16 months.
    //     Rule 3-12 interim test: live prospectus must include financials at least as current as the
    //     most recent 10-Q filed with the SEC (i.e., if a 10-Q exists post-prospectus-baseline, a
    //     424B supplement incorporating it is required to cure the interim gap).
    //   16-MONTH ANNUAL HARD STOP: If today > last_audited_fs_date_in_live_prospectus + 16 months → NOT CURRENT.
    //   SHELF (S-3): automatic IBR of annual/quarterly reports; each new 10-K auto-incorporates.
    //
    // FOREIGN PRIVATE ISSUERS on F-forms (F-1, F-3, F-4) — Item 8 of Form 20-F:
    //   Standard:  15-month annual FS / 9-month interim FS
    //   Warrant exercise relaxation: 18-month annual FS / 12-month interim FS
    //   IBR on F-1/F-4: NOT automatic — only if prospectus expressly elects under General Instruction VI
    //   F-3 (shelf): automatic IBR of annual/interim reports like S-3
    //   6-Ks do NOT update the prospectus unless expressly incorporated.
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

    const effectiveDate = effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;

    // Most recent valid prospectus update (424B or effective POS AM) — used to determine
    // what annuals/interims are IN the live prospectus. Does NOT reset the 9-month clock for domestic.
    const mostRecentEffectiveUpdate = [latestProspectus, latestPostEffective]
      .filter(Boolean)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

    let fsStatus, fsDetail, fsFailCode;
    let annualStatus, annualDetail, annualFailCode;

    const annualFormLabel = isFPI ? "20-F" : "10-K";
    const interimFormLabel = isFPI ? "6-K" : "10-Q";
    const annualLimitLabel = `${Math.round(ANNUAL_LIMIT/30)}-month`;
    const interimLimitLabel = `${Math.round(INTERIM_LIMIT/30)}-month`;
    const ruleRef = isFForm ? "Item 8 of Form 20-F" : "Rule 3-12 / Rule 427";
    const warrantNote = isWarrantReg ? " (relaxed limits for outstanding transferable warrant exercise)" : "";

    if (isShelf) {
      // -------------------------------------------------------------------------
      // SHELF (S-3/F-3): automatic IBR keeps it current.
      // Each new annual report auto-incorporates into the shelf prospectus.
      // -------------------------------------------------------------------------
      if (!latestAnnual) {
        fsStatus = "fail";
        fsFailCode = "later_filing_not_incorporated";
        fsDetail = `STALE — No ${annualFormLabel} found after this shelf registration. A shelf prospectus is kept current via IBR of annual reports. Without any ${annualFormLabel} filed after the shelf, there are no financials incorporated by reference. Shelf is NOT usable.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        if (annualDays > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
          fsDetail = `STALE — ANNUAL FS AGE VIOLATION (${ruleRef}): Most recent ${annualFormLabel} (${latestAnnual.date}) is ${annualDays} days old — exceeds the ${annualLimitLabel} limit${warrantNote}. A new ${annualFormLabel} must be filed before the shelf can be used.`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Shelf kept current via IBR of ${latestAnnual.form} (${latestAnnual.date}, ${annualDays} days ago). Within ${annualLimitLabel} limit under ${ruleRef}. Prospectus is usable.`;
        }
      }

      annualStatus = fsStatus;
      annualDetail = fsDetail;
      annualFailCode = fsFailCode;

    } else {
      // -------------------------------------------------------------------------
      // NON-SHELF (S-1/F-1/F-4)
      //
      // DOMESTIC 9-MONTH CLOCK: Always measured from reg_effective_date.
      //   A 424B or effective POS AM does NOT reset the 9-month clock.
      //   After 9 months, the prospectus is stale unless annual FS in the live
      //   prospectus are within the 16-month hard stop.
      //
      // FPI INTERIM CLOCK: Measured from the most recent valid update that
      //   included interim financials (424B supplement or effective POS AM),
      //   since the FPI rules test the age of the interim FS themselves,
      //   not the elapsed time since effectiveness.
      //
      // BOTH: The live prospectus baseline (for determining what FS are "in" it)
      //   is the most recent 424B or effective POS AM (or original effective date).
      // -------------------------------------------------------------------------

      const pendingNote = latestPendingPosAm
        ? ` ⚠ POS AM filed ${latestPendingPosAm.date} has NOT been declared effective (no EFFECT notice) — it does NOT update the live prospectus.`
        : "";

      // Live prospectus baseline — determines what FS are currently IN the prospectus
      const liveProspectusBaseline = mostRecentEffectiveUpdate;
      const liveBaselineDate = liveProspectusBaseline ? new Date(liveProspectusBaseline.date) : effectiveDate;

      // ANNUAL FS IN LIVE PROSPECTUS
      // Look at ALL filings (including pre-reg) at or before the live baseline date.
      // The audited FS were filed WITH the registration statement itself, so we must
      // search the full filing history — not just subsequentFilings.
      const allAnnuals = filings.filter(f =>
        f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
      );
      const annualsAtBaseline = allAnnuals.filter(f => new Date(f.date) <= liveBaselineDate);
      const annualInLiveProspectus = annualsAtBaseline[0] || null;
      const annualInLiveProspectusSource = annualInLiveProspectus
        ? (liveProspectusBaseline
            ? `incorporated via ${liveProspectusBaseline.form} (${liveProspectusBaseline.date})`
            : `in original registration effective ${effectiveDate.toISOString().split("T")[0]}`)
        : "no annual found in original registration";

      // If no standalone annual filing found, the audited FS were embedded in the registration
      // statement itself. Use the reg filing date as a conservative proxy for the FS age.
      const annualFsProxyDate = annualInLiveProspectus ? annualInLiveProspectus.date : selectedReg.date;
      const annualFsProxySource = annualInLiveProspectus
        ? annualInLiveProspectusSource
        : `embedded in original registration statement (${selectedReg.form} filed ${selectedReg.date})`;

      const annualDaysInLiveProspectus = daysSince(annualFsProxyDate);
      const annualViolation = annualDaysInLiveProspectus > ANNUAL_LIMIT;

      // A newer annual exists on EDGAR but NOT yet in the live prospectus?
      const newerAnnualNotIncorporated = latestAnnual && annualInLiveProspectus
        && latestAnnual.accession !== annualInLiveProspectus.accession;
      const newerAnnualExists = latestAnnual && (!annualInLiveProspectus || newerAnnualNotIncorporated);

      // DOMESTIC 9-MONTH TEST — clock always from reg_effective_date, never reset by POS AM/424B
      const daysSinceEffective = Math.floor((new Date() - effectiveDate) / (1000 * 60 * 60 * 24));
      const domesticNineMonthViolation = !isFForm && daysSinceEffective > NINE_MONTHS;

      // INTERIM STALENESS TEST
      // For domestic: after 9 months, the Rule 3-12 interim test applies — the live prospectus
      //   must include FS at least as current as the most recent 10-Q filed on EDGAR.
      //   A 424B supplement incorporating the 10-Q satisfies this; a bare 10-Q does not.
      // For FPI: the interim FS in the live prospectus must not be older than INTERIM_LIMIT.
      //   The relevant date is the date of the most recent interim FS that is in the prospectus,
      //   i.e., the date of the liveBaselineDate (proxy for when interim FS were last updated).
      const unincorporatedInterims = isFPI
        ? subsequentFilings.filter(f => (f.form === "6-K" || f.form === "6-K/A") && new Date(f.date) > liveBaselineDate)
        : quarterlies.filter(f => new Date(f.date) > liveBaselineDate);
      const unincorporatedCount = unincorporatedInterims.length;

      // For FPI, the interim staleness clock runs from liveBaselineDate (date of last valid update)
      // For domestic, the interim gap is measured by whether unincorporated 10-Qs exist (Rule 3-12)
      const daysSinceLiveBaseline = Math.floor((new Date() - liveBaselineDate) / (1000 * 60 * 60 * 24));
      const fpiInterimViolation = isFForm && daysSinceLiveBaseline > INTERIM_LIMIT;

      // --- COMPOSE PROSPECTUS CURRENCY STATUS ---
      if (!effectiveness.effective) {
        fsStatus = "fail";
        fsFailCode = "registration_not_effective";
        fsDetail = `Registration statement not yet declared effective — prospectus cannot be used at all.${pendingNote}`;
      } else if (annualViolation) {
        fsStatus = "fail";
        fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
        fsDetail = `STALE — ${ruleRef} ANNUAL FS VIOLATION: Audited annual financials in the live prospectus (${annualFsProxySource}) are ${annualDaysInLiveProspectus} days old — exceeding the ${annualLimitLabel} outer limit${warrantNote}. ${isFForm ? `For F-1/F-4, later-filed 20-Fs do NOT auto-update the prospectus unless IBR was elected under Form 20-F General Instruction VI. ` : ""}A POS AM with updated audited annual financials must be declared effective.${pendingNote}`;
      } else if (fpiInterimViolation) {
        fsStatus = "fail";
        fsFailCode = "fpi_interim_financials_older_than_9_or_12_months";
        const projectedAnnualExpiry = annualInLiveProspectus
          ? new Date(new Date(annualInLiveProspectus.date).getTime() + ANNUAL_LIMIT * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
          : "unknown";
        fsDetail = `STALE — ${ruleRef} FPI INTERIM STALENESS: Live prospectus last updated ${daysSinceLiveBaseline} days ago (${liveProspectusBaseline ? `${liveProspectusBaseline.form} ${liveProspectusBaseline.date}` : `effective date ${effectiveDate.toISOString().split("T")[0]}`}) — exceeds the ${interimLimitLabel} interim FS limit${warrantNote}. For F-1/F-4, the clock resets only via a valid 424B supplement or declared-effective POS AM — NOT by filing a 6-K unless expressly incorporated. Annual FS expire around ${projectedAnnualExpiry}.${pendingNote}`;
      } else if (domesticNineMonthViolation && unincorporatedCount > 0) {
        // After 9 months, Rule 3-12 requires the live prospectus to be as current as the latest 10-Q
        fsStatus = "fail";
        fsFailCode = "later_filing_not_incorporated";
        fsDetail = `STALE — Rule 3-12 INTERIM GAP: Registration is ${daysSinceEffective} days past effective date (${effectiveDate.toISOString().split("T")[0]}) — beyond the 9-month window. ${unincorporatedCount} 10-Q(s) have been filed with the SEC since the last prospectus update but are NOT incorporated into the live prospectus. Under Rule 3-12, the live prospectus must include financials at least as current as the most recently filed 10-Q. A 424B3 supplement incorporating the latest 10-Q or a declared-effective POS AM is required.${pendingNote}`;
      } else if (!isFForm && domesticNineMonthViolation) {
        // Beyond 9 months, but no unincorporated 10-Qs — check annual FS age
        if (annualDaysInLiveProspectus <= ANNUAL_LIMIT) {
          fsStatus = "warn";
          fsDetail = `APPROACHING LIMIT — Beyond 9 months since effectiveness (${daysSinceEffective} days). No unincorporated 10-Qs detected. Audited FS (${annualFsProxySource}) are ${annualDaysInLiveProspectus} days old — ${ANNUAL_LIMIT - annualDaysInLiveProspectus} days remaining before the ${annualLimitLabel} hard stop. Monitor closely.${pendingNote}`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Beyond 9 months since effectiveness but no interim update gap detected. Audited FS (${annualFsProxySource}) are within the ${annualLimitLabel} limit.${pendingNote}`;
        }
      } else if (unincorporatedCount > 0) {
        // Within interim window but unincorporated interims exist — flag as warning
        fsStatus = "warn";
        fsFailCode = "later_filing_not_incorporated";
        fsDetail = `INTERIM GAP — ${unincorporatedCount} ${interimFormLabel}(s) filed with the SEC after the last valid prospectus update (${liveProspectusBaseline ? `${liveProspectusBaseline.form} ${liveProspectusBaseline.date}` : effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. ${isFForm ? `For F-1/F-4, 6-Ks do NOT auto-update the prospectus — a 424B3 or declared-effective POS AM is required.` : `A 424B3 supplement or declared-effective POS AM is required.`} Audited FS (${annualFsProxySource}) are ${annualDaysInLiveProspectus} days old — ${ANNUAL_LIMIT - annualDaysInLiveProspectus} days before the ${annualLimitLabel} hard stop.${pendingNote}`;
      } else {
        fsStatus = "pass";
        fsDetail = `CURRENT: Live prospectus is up to date. ${liveProspectusBaseline ? `Last valid update: ${liveProspectusBaseline.form} (${liveProspectusBaseline.date}).` : `No subsequent update — original registration effective ${effectiveDate.toISOString().split("T")[0]}.`} Audited FS (${annualFsProxySource}) are ${annualDaysInLiveProspectus} days old — within ${annualLimitLabel} limit. No unincorporated interim reports.${pendingNote}`;
      }

      // ANNUAL STATUS — separate check on the age of audited FS and whether a newer annual exists
      if (annualViolation) {
        annualStatus = "fail";
        annualFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
        annualDetail = `Audited FS (${annualFsProxySource}) are ${annualDaysInLiveProspectus} days old — exceeds the ${annualLimitLabel} hard stop under ${ruleRef}${warrantNote}. Registration cannot be used.`;
      } else if (newerAnnualExists) {
        annualStatus = "warn";
        annualFailCode = "later_filing_not_incorporated";
        annualDetail = `A more recent ${annualFormLabel} (${latestAnnual.form}, ${latestAnnual.date}) has been filed with the SEC but is NOT part of the live prospectus. ${isFForm ? `For F-1/F-4, a later-filed 20-F does NOT auto-incorporate unless the prospectus expressly elected IBR under Form 20-F General Instruction VI. ` : ""}To update: file a 424B3 supplement or a declared-effective POS AM.`;
      } else if (!latestAnnual) {
        annualStatus = "info";
        annualDetail = `No standalone ${annualFormLabel} filed after this registration. Audited FS are embedded in the original registration (${annualFsProxySource}, ${annualDaysInLiveProspectus} days old). ${annualLimitLabel} hard stop applies.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        annualStatus = "pass";
        annualDetail = `Most recent ${annualFormLabel} (${latestAnnual.date}, ${annualDays} days ago) is in the live prospectus (${annualFsProxySource}). Within ${annualLimitLabel} limit.`;
      }
    }

    checks.push({
      id: "financial_statements",
      label: isFForm
        ? `Prospectus Currency — Item 8 Form 20-F (${Math.round(ANNUAL_LIMIT/30)}-mo annual / ${Math.round(INTERIM_LIMIT/30)}-mo interim)`
        : "Prospectus Currency — Rule 3-12 / Rule 427 (9-mo interim / 16-mo annual)",
      status: fsStatus,
      failCode: fsFailCode || null,
      detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus),
      filingForm: latestPostEffective?.form || latestProspectus?.form || null,
    });

    checks.push({
      id: "annual_reports",
      label: isFPI
        ? `Annual Financials In Live Prospectus (${Math.round(ANNUAL_LIMIT/30)}-Month Limit — ${ruleRef})`
        : `Annual Financials In Live Prospectus (16-Month Rule 3-12 Hard Stop)`,
      status: annualStatus,
      failCode: annualFailCode || null,
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

    const frameworkNote = isFForm
      ? `F-form (${selectedReg.form}) — governed by Item 8 of Form 20-F. Annual FS limit: ${Math.round(ANNUAL_LIMIT/30)} months${isWarrantReg ? " (18-month relaxation for warrant exercise)" : ""}. Interim FS limit: ${Math.round(INTERIM_LIMIT/30)} months. IBR on F-1/F-4 is NOT automatic — only if expressly elected under General Instruction VI. FPIs file 20-F (not 10-K) and furnish 6-K (not 10-Q/8-K). A 6-K does NOT update the prospectus unless expressly incorporated.`
      : `Domestic form (${selectedReg.form}) — Rule 3-12 / Rule 427. The 9-month clock runs from reg_effective_date ONLY — it is NEVER reset by a POS AM or 424B supplement. After 9 months, the prospectus may still be used IF: (a) the audited annual FS in the live prospectus are within 16 months AND (b) the live prospectus includes FS at least as current as the most recently filed 10-Q. A bare 10-Q filing does NOT update the prospectus — a 424B3 supplement or declared-effective POS AM is required.`;

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `You are a securities law compliance expert applying SEC registration statement currency rules.

Framework: ${frameworkNote}

CURRENT = effective AND live prospectus validly updated AND interim age rule satisfied AND audited annual age rule satisfied.
Failure codes: registration_not_effective | later_filing_not_incorporated | interim_financials_outdated | audited_financials_older_than_16_months | fpi_audited_financials_older_than_15_or_18_months | fpi_interim_financials_older_than_9_or_12_months

Company: ${companyName} (${ticker.toUpperCase()})
Form: ${selectedReg.form} filed ${selectedReg.date}
Type: ${isShelf ? "Shelf" : "Non-Shelf"} | FPI: ${isFPI ? "Yes" : "No"} | F-form: ${isFForm ? "Yes" : "No"}

Compliance checks:
${checkSummary}

Overall computed status: ${overallStatus.toUpperCase()} (pass=CURRENT, warn=CURRENT WITH CAVEATS, fail=NOT CURRENT).

A "warn" means the registration CAN be used but has gaps that should be remediated. Only a "fail" means NOT CURRENT. Reflect this correctly in your verdict.

Provide a direct 2-3 sentence verdict reflecting the overall status. State the primary issue code. What must be done?`,
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