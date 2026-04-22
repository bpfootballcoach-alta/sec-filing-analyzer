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
    // SECTION 10(a)(3) / RULE 427 CURRENCY FRAMEWORK
    // =============================================================================
    //
    // The correct two-step framework (per ANNA analysis):
    //
    // STEP 1 — 9-MONTH TEST (prospectus staleness):
    //   A prospectus cannot be used more than 9 months after its effective date
    //   UNLESS it has been updated via a valid mechanism.
    //   Valid update mechanisms:
    //     (a) A new 424B3 (or other 424B) prospectus supplement — effective upon filing.
    //     (b) A POS AM declared effective by the SEC (EFFECT notice required).
    //   NOT valid:
    //     - A filed-but-not-yet-effective POS AM. Filing alone does NOT restart the clock.
    //     - A pre-effective /A amendment (S-1/A). This is pre-effectiveness.
    //     - A 10-Q or 10-K filed with the SEC but NOT expressly made part of the live
    //       prospectus via a 424B supplement or declared-effective POS AM.
    //
    //   If a valid 424B3 supplement incorporating interim (quarterly) financials was filed,
    //   it satisfies the 9-month test for that interim period — BUT does NOT extend the
    //   16-month outer limit on the audited annual financials.
    //
    // STEP 2 — 16-MONTH ANNUAL STALENESS TEST (Rule 3-12 outer limit):
    //   Regardless of the 9-month test, the audited annual financials contained in (or
    //   incorporated into) the LIVE prospectus cannot be older than 16 months.
    //   The question is: what is the date of the most recent AUDITED annual financials
    //   that are actually part of the live prospectus?
    //
    //   "Part of the live prospectus" means contained in:
    //     - The original registration statement (if still within 9 months), OR
    //     - The most recent declared-effective POS AM, OR
    //     - The most recent 424B3 supplement that expressly incorporated annual financials, OR
    //     - For S-3: automatically via IBR of the most recent 10-K (if company is current filer).
    //
    //   A 10-K filed with the SEC is NOT automatically part of the live non-shelf prospectus
    //   unless the prospectus itself has forward IBR language, or a 424B/POS AM expressly
    //   incorporates it. For most S-1/non-shelf registrations, there is NO forward IBR.
    //
    //   If a 424B3 with only quarterly (unaudited) financials was the most recent update,
    //   the 16-month clock still runs from the audited annual financials that were last
    //   made part of the live prospectus.
    //
    // =============================================================================

    const NINE_MONTHS = 274;
    const SIXTEEN_MONTHS = 487;

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
      // Company must be a current Exchange Act filer. Each new 10-K auto-incorporates.
      // -------------------------------------------------------------------------
      if (!latestAnnual) {
        fsStatus = "fail";
        fsDetail = `STALE — No annual report (10-K/20-F) found after this shelf registration. A shelf prospectus is kept current via incorporation by reference of annual reports. Without any 10-K filed after the shelf, there are no financials incorporated by reference. Shelf is NOT usable.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        if (annualDays > SIXTEEN_MONTHS) {
          fsStatus = "fail";
          fsDetail = `STALE — RULE 3-12 VIOLATION: Most recent annual report (${latestAnnual.form}, ${latestAnnual.date}) is ${annualDays} days old — exceeds the 16-month outer limit. The audited financials incorporated by reference into this shelf are too old. A new 10-K must be filed and incorporated before the shelf can be used.`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Shelf is kept current via IBR of ${latestAnnual.form} (${latestAnnual.date}, ${annualDays} days ago). Audited financials are within the 16-month Rule 3-12 limit. Prospectus is usable under Section 10(a)(3).`;
        }
      }

      annualStatus = fsStatus === "pass" ? "pass" : "fail";
      annualDetail = fsDetail;

    } else {
      // -------------------------------------------------------------------------
      // NON-SHELF (S-1/F-1): Two-step analysis — 9-month test THEN 16-month test.
      // -------------------------------------------------------------------------

      // (effectiveDate and mostRecentEffectiveUpdate already defined above)

      const pendingNote = latestPendingPosAm
        ? ` ⚠ POS AM filed ${latestPendingPosAm.date} has NOT been declared effective (no EFFECT notice) — it does NOT update the live prospectus until the SEC issues effectiveness.`
        : "";

      // --- STEP 1: 9-MONTH TEST ---
      // Clock runs from original effective date OR most recent valid update, whichever is later.
      const nineMonthClockBase = mostRecentEffectiveUpdate
        ? new Date(mostRecentEffectiveUpdate.date)
        : effectiveDate;
      const daysSinceNineMonthClock = Math.floor((new Date() - nineMonthClockBase) / (1000 * 60 * 60 * 24));
      const nineMonthViolation = daysSinceNineMonthClock > NINE_MONTHS;

      const nineMonthClockLabel = mostRecentEffectiveUpdate
        ? `${mostRecentEffectiveUpdate.form} filed ${mostRecentEffectiveUpdate.date}`
        : `original effective date ${nineMonthClockBase.toISOString().split("T")[0]}`;

      // --- STEP 2: 16-MONTH ANNUAL STALENESS TEST ---
      // What are the most recent AUDITED annual financials actually IN the live prospectus?
      //
      // For a non-shelf S-1, the live prospectus contains the annuals that were in the
      // most recent declared-effective document (original reg or most recent effective POS AM).
      //
      // A 424B3 with ONLY quarterly (unaudited) financials does NOT update the annual staleness
      // clock — the 16-month clock continues to run from the last audited annuals in the prospectus.
      //
      // We determine which annuals are "in" the live prospectus:
      //   1. If there is a declared-effective POS AM that post-dates the most recent 10-K -> that POS AM
      //      likely incorporated updated audited annuals. Use POS AM date as proxy for annual FS date.
      //   2. If the most recent 424B3 post-dates the most recent 10-K -> the 424B3 likely incorporated
      //      annuals. Use 424B3 date as proxy.
      //   3. Otherwise: the annuals in the live prospectus are the ones in the original registration
      //      (or most recent effective POS AM that pre-dates the latest 10-K).
      //      In this case, look at what annual was available at the time of the last effective document.
      //
      // We also check: has a 10-Q been filed with the SEC that is NOT part of the live prospectus?
      // If so, we flag it — the transfer agent may treat this as a deficiency.

      // Annuals filed before or around the original effective date (what was IN the reg at effectiveness)
      const annualsInOriginalReg = annuals.filter(f => new Date(f.date) <= effectiveDate);
      // The annual that was in the original registration
      const annualInOriginalReg = annualsInOriginalReg[0] || null;

      // Most recent effective document (POS AM or 424B that is the live prospectus baseline)
      const liveProspectusBaseline = mostRecentEffectiveUpdate;

      // Determine: what annual financials are currently IN the live prospectus?
      // - If there's a POS AM declared effective after the latest 10-K -> that POS AM likely has new annuals
      // - If there's a 424B3 filed after the latest 10-K -> that 424B3 likely incorporated new annuals
      // - Otherwise -> the most recent 10-K that was available at or before the last effective document date
      let annualInLiveProspectus = null;
      let annualInLiveProspectusSource = "";

      if (liveProspectusBaseline) {
        const baselineDate = new Date(liveProspectusBaseline.date);
        // Annuals available at or before the live baseline — these are what the baseline doc incorporated
        const annualsAtBaseline = annuals.filter(f => new Date(f.date) <= baselineDate);
        annualInLiveProspectus = annualsAtBaseline[0] || null;
        annualInLiveProspectusSource = annualInLiveProspectus
          ? `incorporated via ${liveProspectusBaseline.form} (${liveProspectusBaseline.date})`
          : `no annual available at baseline date ${liveProspectusBaseline.date}`;
      } else {
        // No subsequent effective update — annuals are those in the original reg
        annualInLiveProspectus = annualInOriginalReg;
        annualInLiveProspectusSource = annualInLiveProspectus
          ? `in original registration effective ${effectiveDate.toISOString().split("T")[0]}`
          : "no annual found in original registration";
      }

      const annualDaysInLiveProspectus = annualInLiveProspectus ? daysSince(annualInLiveProspectus.date) : null;
      const sixteenMonthViolation = annualDaysInLiveProspectus !== null && annualDaysInLiveProspectus > SIXTEEN_MONTHS;

      // 10-Qs filed with the SEC but NOT part of the live prospectus
      const tenQsNotInProspectus = latestQuarterly && liveProspectusBaseline
        ? quarterlies.filter(f => new Date(f.date) > new Date(liveProspectusBaseline.date))
        : liveProspectusBaseline === null ? quarterlies : [];
      // Even without a 424B3, if 10-Qs exist after the live prospectus baseline, they are NOT in the prospectus
      const unincorporatedQs = tenQsNotInProspectus.length;

      // --- COMPOSE THE PROSPECTUS CURRENCY STATUS ---
      if (!effectiveness.effective) {
        // Registration not even effective — can't analyze further
        fsStatus = "fail";
        fsDetail = `Registration statement not yet declared effective — prospectus cannot be used at all.${pendingNote}`;
      } else if (sixteenMonthViolation) {
        // 16-month annual staleness — outer limit hit regardless of 9-month status
        fsStatus = "fail";
        fsDetail = `STALE — RULE 3-12 / 16-MONTH ANNUAL VIOLATION: The audited annual financials in the live prospectus (${annualInLiveProspectus.form} ${annualInLiveProspectus.date}, ${annualInLiveProspectusSource}) are ${annualDaysInLiveProspectus} days old — exceeding the 16-month outer limit. The prospectus CANNOT be used. Even if quarterly financials have been filed with the SEC (${unincorporatedQs} unincorporated 10-Q(s) on EDGAR), those 10-Qs are NOT part of the live prospectus unless expressly incorporated via a 424B3 supplement or declared-effective POS AM. A POS AM with updated AUDITED annual financials must be filed and declared effective.${pendingNote}`;
      } else if (nineMonthViolation) {
        // 9-month staleness — prospectus is stale but 16-month limit not yet hit
        const projectedSixteenMonthDate = annualInLiveProspectus
          ? new Date(new Date(annualInLiveProspectus.date).getTime() + SIXTEEN_MONTHS * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
          : "unknown";
        fsStatus = "fail";
        fsDetail = `STALE — SECTION 10(a)(3) 9-MONTH VIOLATION: The live prospectus has not been updated in ${daysSinceNineMonthClock} days (clock running from ${nineMonthClockLabel}). The prospectus CANNOT be used. Note: Even a valid Q3 424B3 supplement would only cure the 9-month staleness for the interim period — the audited annual financials (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) in the live prospectus would still become too old around ${projectedSixteenMonthDate} (16-month outer limit). ${unincorporatedQs > 0 ? `${unincorporatedQs} 10-Q(s) have been filed with the SEC since the last prospectus update but are NOT part of the live prospectus — 10-Q filings alone do not update the prospectus without a 424B3 supplement or declared-effective POS AM.` : ""}${pendingNote}`;
      } else {
        // Within 9-month window — check if there are unincorporated 10-Qs that create a gap
        if (unincorporatedQs > 0) {
          fsStatus = "warn";
          fsDetail = `INTERIM UPDATE GAP — Prospectus is within the 9-month window (${daysSinceNineMonthClock} days since ${nineMonthClockLabel}), but ${unincorporatedQs} subsequent 10-Q(s) have been filed with the SEC and are NOT expressly incorporated into the live prospectus. A transfer agent or broker may flag this as a deficiency. A 424B3 supplement incorporating the latest quarterly financials is advisable to keep the live prospectus current. Audited annuals in the live prospectus (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) have ${annualDaysInLiveProspectus !== null ? SIXTEEN_MONTHS - annualDaysInLiveProspectus : "?"} days before the 16-month outer limit.${pendingNote}`;
        } else {
          fsStatus = "pass";
          fsDetail = `CURRENT: Prospectus is within the 9-month window (${daysSinceNineMonthClock} days since ${nineMonthClockLabel}). Audited annuals in the live prospectus (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}) are ${annualDaysInLiveProspectus} days old — within the 16-month Rule 3-12 limit. Prospectus is usable.${pendingNote}`;
        }
      }

      // Annual status check — separate check for annual filing currency
      if (!latestAnnual) {
        annualStatus = "info";
        annualDetail = "No 10-K filed after this registration statement. If the offering is ongoing, the prospectus cannot be updated with new annual financials until a 10-K is filed.";
      } else {
        const annualDays = daysSince(latestAnnual.date);
        // Is the latest annual ALREADY incorporated into the live prospectus?
        const latestAnnualInProspectus = annualInLiveProspectus && annualInLiveProspectus.accession === latestAnnual.accession;
        if (latestAnnualInProspectus) {
          annualStatus = annualDays <= 455 ? "pass" : "fail";
          annualDetail = annualStatus === "pass"
            ? `Most recent 10-K (${latestAnnual.date}, ${annualDays} days ago) is incorporated into the live prospectus (${annualInLiveProspectusSource}). Annual financials are current.`
            : `Most recent 10-K (${latestAnnual.date}, ${annualDays} days ago) may have missed an annual cycle.`;
        } else {
          // A newer 10-K exists but is NOT yet part of the live prospectus
          annualStatus = "warn";
          annualDetail = `A more recent 10-K (${latestAnnual.form}, ${latestAnnual.date}) has been filed with the SEC but is NOT part of the live prospectus. The live prospectus still contains the older annual financials (${annualInLiveProspectus?.form || "unknown"} ${annualInLiveProspectus?.date || ""}). To update: file a 424B3 supplement or a POS AM (must be declared effective) that expressly incorporates the new 10-K.`;
        }
      }
    }

    checks.push({
      id: "financial_statements",
      label: "Prospectus Currency — Section 10(a)(3) / Rule 427",
      status: fsStatus,
      detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus),
      filingForm: latestPostEffective?.form || latestProspectus?.form || null,
    });

    checks.push({
      id: "annual_reports",
      label: "Annual Financials In Live Prospectus (16-Month Rule 3-12 Limit)",
      status: annualStatus,
      detail: annualDetail,
      filingDate: latestAnnual?.date || null,
      filingUrl: edgarUrl(latestAnnual),
      filingForm: latestAnnual?.form || null,
      count: annuals.length,
    });

    // --- CHECK C: Quarterly Reports — EDGAR Currency + Prospectus Incorporation Gap ---
    // Two distinct questions:
    //   (1) Is the company current in filing 10-Qs with the SEC? (Exchange Act obligation)
    //   (2) Are those 10-Qs actually PART OF the live prospectus?
    //       Filing a 10-Q with the SEC does NOT automatically update a non-shelf prospectus.
    //       For the prospectus to reflect interim financials, the issuer must file either:
    //         (a) a 424B3 supplement expressly incorporating the 10-Q, OR
    //         (b) a POS AM that is declared effective by the SEC.
    //       The 9-month and 16-month rules do NOT treat a bare 10-Q as a prospectus update.

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

    // For non-shelf: how many 10-Qs are unincorporated into the live prospectus?
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
      // Company is current on 10-Qs but they are not in the live prospectus
      quarterlyStatus = "warn";
      quarterlyDetail = `PROSPECTUS INCORPORATION GAP: Company is current in filing 10-Qs with the SEC (${quartersFiledSinceAnnual} filed since last 10-K), but ${unincorporatedQuarterlies.length} 10-Q(s) filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. A 10-Q filed with the SEC does NOT update a non-shelf prospectus. To incorporate: file a 424B3 supplement or a declared-effective POS AM. Most recent unincorporated: ${unincorporatedQuarterlies[0].form} ${unincorporatedQuarterlies[0].date}.`;
    } else {
      quarterlyStatus = "pass";
      quarterlyDetail = `${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K. Quarterly Exchange Act reporting is current. (No Q4 10-Q required — covered by 10-K.)`;
    }
    checks.push({
      id: "quarterly_reports",
      label: "Quarterly Reports — EDGAR Currency & Prospectus Incorporation",
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
    // CRITICAL: A POS AM must be declared effective by the SEC (EFFECT notice) to count.
    // A filed-but-not-yet-effective POS AM does NOT satisfy Section 10(a)(3).
    let amendStatus, amendDetail;
    if (isShelf) {
      amendStatus = "info";
      amendDetail = "Shelf registrations (S-3/F-3) are kept current via annual report incorporation by reference — POS AM filings are not required for Section 10(a)(3) compliance.";
    } else if (allPostEffectiveAmendments.length === 0) {
      amendStatus = "info";
      amendDetail = "No POS AM filings found for this registration statement.";
    } else if (effectivePostEffectiveAmendments.length === 0) {
      // POS AMs exist but NONE have been declared effective
      amendStatus = "fail";
      amendDetail = `${allPostEffectiveAmendments.length} POS AM(s) filed but NONE have been declared effective by the SEC (no EFFECT notice found). A filed POS AM does NOT satisfy Section 10(a)(3) until the SEC issues an effectiveness order. Most recent filed (not effective): ${latestPendingPosAm.form} on ${latestPendingPosAm.date}.`;
    } else {
      const aDays = daysSince(latestPostEffective.date);
      const pendingNote = latestPendingPosAm ? ` Additionally, ${pendingPostEffectiveAmendments.length} POS AM(s) are filed but not yet declared effective.` : "";
      amendStatus = "pass";
      amendDetail = `${effectivePostEffectiveAmendments.length} effective POS AM(s) on record. Most recent effective: ${latestPostEffective.form} on ${latestPostEffective.date} (${aDays} days ago).${pendingNote}`;
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

    // AI plain-English verdict: look at ALL checks holistically and deliver a definitive answer
    const checkSummary = checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n");

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `You are a securities law compliance expert applying the Section 10(a)(3) / Rule 427 two-step framework.

The correct framework is:
STEP 1 (9-month test): A prospectus cannot be used more than 9 months from its effective date unless updated via a valid 424B supplement (effective on filing) or a declared-effective POS AM. A POS AM that has NOT been declared effective does NOT reset the clock. A bare 10-Q or 10-K filed with the SEC does NOT update the live prospectus.
STEP 2 (16-month outer limit): Regardless of the 9-month test, the audited annual financials actually IN the live prospectus cannot be older than 16 months. A 424B3 with only quarterly/interim financials cures the 9-month test but does NOT extend the 16-month annual limit — the annuals still age from when they were last made part of the live prospectus.

Company: ${companyName} (${ticker.toUpperCase()})
Form: ${selectedReg.form} filed ${selectedReg.date}
Type: ${isShelf ? "Shelf (S-3/F-3)" : "Non-Shelf (S-1/F-1)"}

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