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

    // --- CHECK A: Section 10(a)(3) Prospectus Currency ---
    //
    // Section 10(a)(3): A prospectus included in a registration statement CANNOT be used
    // after 9 months from its effective date unless it has been updated.
    // Rule 3-12: Financial statements in the prospectus cannot be older than 16 months.
    //
    // For S-3/F-3 (shelf): automatically kept current via IBR of annual/quarterly reports.
    //   Stale if: most recent 10-K is > 16 months old, OR company is not a current filer.
    //
    // For S-1/F-1 (non-shelf): prospectus stale after 9 months from effective date
    //   UNLESS a POS AM, new 424B, or /A amendment has been filed that restarts the clock.
    //   The clock runs from the effective date of the most recent update (POS AM/424B),
    //   not from the original filing date.
    //   Additionally, financial statements in the prospectus cannot be > 16 months old (Rule 3-12).

    const NINE_MONTHS = 274;
    const SIXTEEN_MONTHS = 487;

    let fsStatus, fsDetail;

    if (isShelf) {
      // S-3/F-3: kept current via IBR of annual reports
      if (!latestAnnual) {
        fsStatus = "fail";
        fsDetail = `No annual report (10-K/20-F) filed after this shelf registration. A shelf prospectus requires at least one annual report incorporated by reference to remain current under Section 10(a)(3). Shelf is STALE.`;
      } else {
        const annualDays = daysSince(latestAnnual.date);
        if (annualDays > SIXTEEN_MONTHS) {
          fsStatus = "fail";
          fsDetail = `Most recent annual report (${latestAnnual.form}, ${latestAnnual.date}) is ${annualDays} days old — exceeding the 16-month Rule 3-12 limit. This shelf prospectus is STALE under Section 10(a)(3). A new 10-K must be filed and incorporated by reference.`;
        } else {
          fsStatus = "pass";
          fsDetail = `Shelf registration is kept current via incorporation by reference of ${latestAnnual.form} filed ${annualDays} days ago (${latestAnnual.date}). Financial statements are within the 16-month Rule 3-12 window. Prospectus is current under Section 10(a)(3).`;
        }
      }
    } else {
      // S-1/F-1 non-shelf:
      // The 9-month clock runs from the effective date of the prospectus (or most recent update).
      // A POS AM or new 424B resets the clock from its own effective/filing date.

      const effectiveDate = effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;

      // Most recent EFFECTIVE update that resets the 9-month clock.
      // CRITICAL RULES:
      // 1. A POS AM ONLY resets the clock if it has been declared effective by the SEC (EFFECT notice).
      //    A filed-but-not-yet-effective POS AM does NOT reset the clock.
      // 2. A 424B prospectus IS effective upon filing — no EFFECT notice needed.
      // 3. A pre-effective amendment (S-1/A, F-1/A) does NOT reset the 9-month clock — it is
      //    a pre-effectiveness amendment, not a post-effective prospectus update.
      //    Only POS AM (declared effective) or 424B resets the clock.
      const mostRecentEffectiveUpdate = [latestProspectus, latestPostEffective]
        .filter(Boolean)
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;

      // The clock baseline: most recent effective update date, or the original effective date
      // If there is NO effective update at all, the clock runs from the original registration's
      // effective date (effectiveDate). If effectiveDate equals regDate (no EFFECT notice found),
      // we conservatively use the registration filing date as the clock start.
      const clockBaseDate = mostRecentEffectiveUpdate ? new Date(mostRecentEffectiveUpdate.date) : effectiveDate;
      const daysSinceClock = Math.floor((new Date() - clockBaseDate) / (1000 * 60 * 60 * 24));

      // Build a note if there's a pending POS AM that hasn't been declared effective yet
      const pendingNote = latestPendingPosAm
        ? ` NOTE: A POS AM was filed on ${latestPendingPosAm.date} but has NOT yet been declared effective by the SEC — it does NOT reset the 9-month clock until the SEC issues an EFFECT notice.`
        : "";

      // Clock explanation string for use in detail messages
      const clockExplanation = mostRecentEffectiveUpdate
        ? `The 9-month clock is running from the most recent declared-effective update: ${mostRecentEffectiveUpdate.form} on ${mostRecentEffectiveUpdate.date} (${daysSinceClock} days ago).`
        : `The 9-month clock is running from the original registration effective date: ${clockBaseDate.toISOString().split("T")[0]} (${daysSinceClock} days ago). No subsequent effective prospectus update (declared-effective POS AM or 424B) has been found.`;

      if (daysSinceClock > SIXTEEN_MONTHS) {
        fsStatus = "fail";
        fsDetail = `STALE — RULE 3-12 VIOLATION: ${clockExplanation} This exceeds the 16-month Rule 3-12 financial statement age limit. The prospectus CANNOT be used. A new POS AM with updated audited financials must be filed and declared effective immediately.${pendingNote}`;
      } else if (daysSinceClock > NINE_MONTHS) {
        fsStatus = "fail";
        fsDetail = `STALE — SECTION 10(a)(3) VIOLATION: ${clockExplanation} This exceeds the 9-month limit under Section 10(a)(3). The prospectus CANNOT be used for offers or sales until a new prospectus update (POS AM declared effective, or new 424B) resets the clock. A pre-effective /A amendment does NOT satisfy this requirement — only a declared-effective POS AM or 424B counts.${pendingNote}`;
      } else {
        fsStatus = "pass";
        fsDetail = mostRecentEffectiveUpdate
          ? `Within 9-month window: ${clockExplanation}${pendingNote}`
          : `Within 9-month window: ${clockExplanation}`;
      }
    }

    checks.push({
      id: "financial_statements",
      label: "Prospectus Currency — Section 10(a)(3) (9-Month Rule)",
      status: fsStatus,
      detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || latestAmendment?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus || latestAmendment),
      filingForm: latestPostEffective?.form || latestProspectus?.form || latestAmendment?.form || null,
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
      prompt: `You are a securities law compliance expert. A user wants to know: "Can this registration statement currently be used for offers and sales of securities?"

Company: ${companyName} (${ticker.toUpperCase()})
Form: ${selectedReg.form} filed ${selectedReg.date}
Type: ${isShelf ? "Shelf (S-3/F-3)" : "Non-Shelf (S-1/F-1)"}

Individual compliance checks:
${checkSummary}

Give a direct, plain-English answer in 2-3 sentences. State clearly YES or NO whether the registration is currently usable. Identify the single most critical issue. State what action is needed, if any. Do not hedge if the answer is clear from the checks above.`,
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