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
    // Use the SEC's official ticker-to-CIK mapping (company_tickers.json) as primary source.
    // Also check company_tickers_exchange.json which includes more tickers.
    const tickerUpper = ticker.toUpperCase();

    const [tickerRes, tickerExRes] = await Promise.all([
      fetch("https://www.sec.gov/files/company_tickers.json", { headers: HEADERS }),
      fetch("https://www.sec.gov/files/company_tickers_exchange.json", { headers: HEADERS }),
    ]);
    const tickerData = await tickerRes.json();
    const tickerExData = tickerExRes.ok ? await tickerExRes.json() : null;

    let cik = null, companyName = null;

    // Search primary ticker file
    for (const entry of Object.values(tickerData)) {
      if (entry.ticker?.toUpperCase() === tickerUpper) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title;
        break;
      }
    }

    // If not found, search the exchange-specific ticker file (broader coverage)
    if (!cik && tickerExData?.data) {
      for (const row of tickerExData.data) {
        // row format: [cik, name, ticker, exchange]
        if (row[2]?.toUpperCase() === tickerUpper) {
          cik = String(row[0]).padStart(10, "0");
          companyName = row[1];
          break;
        }
      }
    }

    if (!cik) return Response.json({ error: `Could not find CIK for ticker: ${ticker}` }, { status: 404 });

    const mergeFilingPage = (acc, page) => {
      const forms = page.form || [];
      const dates = page.filingDate || [];
      const accessions = page.accessionNumber || [];
      const docs = page.primaryDocument || [];
      const fileNumbers = page.fileNumber || [];
      const descriptions = page.primaryDocDescription || [];
      const sizes = page.size || [];
      for (let i = 0; i < forms.length; i++) {
        if (forms[i] && dates[i]) {
          acc.push({ form: forms[i], date: dates[i], accession: accessions[i], doc: docs[i], cik, fileNumber: fileNumbers[i] || null, description: descriptions[i] || null, size: sizes[i] || 0 });
        }
      }
      return acc;
    };

    // Step 2: Fetch ALL filings — recent page + all historical pagination files
    const subRes = await fetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
    if (!subRes.ok) return Response.json({ error: "Failed to fetch EDGAR submissions" }, { status: 500 });
    const subData = await subRes.json();

    // Use the official company name from submissions if available
    if (subData.name) companyName = subData.name;

    let filings = [];
    mergeFilingPage(filings, subData.filings?.recent || {});

    // Fetch ALL additional historical pages in parallel
    const additionalFiles = subData.filings?.files || [];
    if (additionalFiles.length > 0) {
      const pageResponses = await Promise.all(
        additionalFiles.map(f => fetch(`https://data.sec.gov/submissions/${f.name}`, { headers: HEADERS }))
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

    // Step 3: If no accession selected, return list of all registration statements
    const AUTO_EFFECTIVE_FORMS = ["S-8"];
    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    const isLikelyEffective = (regFiling) => {
      const form = regFiling.form?.toUpperCase().trim();
      // S-8, S-3, and F-3 are automatically effective upon filing (Rules 462(b)/(e))
      if (form === "S-8" || form?.includes("S-3") || form?.includes("F-3")) {
        return { effective: true, reason: `${form} auto-effective upon filing under Rule 462`, effectDate: regFiling.date };
      }

      const regDate = new Date(regFiling.date);
      const fileNum = regFiling.fileNumber || null;

      // Helper: does a filing belong to the same registration (by file number)?
      const sameReg = (f) => {
        if (!fileNum || !f.fileNumber) return true; // fallback
        return f.fileNumber === fileNum;
      };

      // Rule 1: EFFECT notice within 365 days = effective
      const effectAfter = effectFilings.find(e => {
        const eDate = new Date(e.date);
        return eDate >= regDate && (eDate - regDate) < 365 * 24 * 60 * 60 * 1000;
      });
      if (effectAfter) return { effective: true, reason: `EFFECT notice filed ${effectAfter.date}`, effectDate: effectAfter.date };

      // Rule 2: 424B filed after under same file number = proxy for effectiveness
      const prospectusAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && sameReg(f);
      });
      if (prospectusAfter) return { effective: true, reason: `424B prospectus filed ${prospectusAfter.date} (proxy for effectiveness)`, effectDate: prospectusAfter.date };

      // Rule 3: effective POS AM filed after under same file number = proxy for effectiveness
      const posAmAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim()) && sameReg(f) && isPosAmEffective(f);
      });
      if (posAmAfter) return { effective: true, reason: `effective POS AM filed ${posAmAfter.date} (proxy for effectiveness)`, effectDate: posAmAfter.date };

      return { effective: false, reason: "No EFFECT notice, 424B, or effective POS AM found — registration may not have been declared effective" };
    };

    const regFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      // Include base forms AND their /A amendments
      return REG_FORMS.some(r => form === r || form === r + "/A" || form.startsWith(r + "/"));
    });

    if (!accession) {
      // Generate a short subject summary for each reg filing using LLM
      const regFilingsWithMeta = regFilings.map((f) => ({
        form: f.form,
        date: f.date,
        accession: f.accession,
        description: f.description || "",
      }));

      const subjectSummaries = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `For each of the following SEC registration statement filings by ${companyName} (ticker: ${ticker.toUpperCase()}), write a concise label (5-12 words) listing the types of securities being registered and the offering context. Examples: "Common stock — IPO", "Common stock & warrants — resale", "Underlying shares from convertible notes — resale", "Employee stock options — S-8 plan", "Common stock, preferred stock & warrants — shelf offering", "Merger consideration shares — S-4". Focus on security types (common stock, preferred stock, warrants, convertible notes, units, etc.) and whether it's a primary offering, resale/secondary, or merger/plan. If it's an amendment (/A), prepend "Amendment: ". Return a JSON array in the same order as the input.

Filings:
${regFilingsWithMeta.map((f, i) => `${i}. Form: ${f.form}, Date: ${f.date}, Description hint: "${f.description}"`).join("\n")}`,
        response_json_schema: {
          type: "object",
          properties: {
            summaries: {
              type: "array",
              items: { type: "string" }
            }
          }
        }
      });

      const summaryList = subjectSummaries?.summaries || [];

      return Response.json({
        mode: "list",
        ticker: ticker.toUpperCase(),
        cik,
        companyName,
        registrationStatements: regFilings.map((f, i) => {
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
            registrationNumber: f.fileNumber || null,
            subject: summaryList[i] || null,
          };
        }),
      });
    }

    // Step 4: Deep-check the selected registration statement
    const selectedReg = filings.find(f => f.accession === accession);
    if (!selectedReg) return Response.json({ error: "Registration statement not found" }, { status: 404 });

    // Fetch the filing fee table (EX-FILING FEES document) to get securities registered
    // Use EDGAR's JSON index API to reliably find the EX-FILING FEES exhibit filename
    let securitiesRegistered = null;
    try {
      const accNo = accession.replace(/-/g, "");
      // Primary: use EDGAR filing index JSON (most reliable)
      let feeFilename = null;
      const jsonIdxRes = await fetch(
        `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${accession}-index.json`,
        { headers: HEADERS }
      ).catch(() => null);
      if (jsonIdxRes?.ok) {
        const jsonIdx = await jsonIdxRes.json().catch(() => null);
        if (jsonIdx?.documents) {
          const feeDoc = jsonIdx.documents.find(d =>
            d.type?.toUpperCase().includes("EX-FILING FEE") ||
            d.description?.toUpperCase().includes("FILING FEE")
          );
          if (feeDoc) feeFilename = feeDoc.filename;
        }
      }

      // Fallback: scrape the HTML index and look for the type AFTER the href (correct column order)
      if (!feeFilename) {
        const htmIdxRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${accession}-index.htm`,
          { headers: HEADERS }
        ).catch(() => null);
        if (htmIdxRes?.ok) {
          const idxHtml = await htmIdxRes.text();
          // Table row: <a href="filename.htm">filename</a> ... <td>EX-FILING FEES</td>
          // Match each table row and check if it contains EX-FILING FEE type
          const rowMatches = idxHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
          for (const row of rowMatches) {
            if (/EX-FILING FEE/i.test(row)) {
              const hrefMatch = row.match(/href="([^"]+\.htm)"/i);
              if (hrefMatch) { feeFilename = hrefMatch[1].split("/").pop(); break; }
            }
          }
        }
      }

      if (feeFilename) {
        const feeUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${feeFilename}`;
        const feeRes = await fetch(feeUrl, { headers: HEADERS });
        if (feeRes.ok) {
          const feeHtml = await feeRes.text();
          const feeText = feeHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          securitiesRegistered = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Extract the securities being registered from this SEC filing fee table. Return a concise structured summary. Include: security type, class title, number/amount registered, offering price per unit (if any), and total aggregate offering price. Also note if it's a primary offering, secondary/resale offering, or both.

Also produce a short "label" (5-10 words) listing the distinct security types being registered, e.g. "Common stock, warrants" or "Common stock, preferred stock & convertible notes" or "Underlying shares from warrants & convertible notes — resale".

Fee table text (truncated):
${feeText.slice(0, 6000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                label: { type: "string" },
                summary: { type: "string" },
                securities: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      security_class: { type: "string" },
                      offering_type: { type: "string" },
                      amount_registered: { type: "string" },
                      price_per_unit: { type: "string" },
                      aggregate_offering_price: { type: "string" }
                    }
                  }
                },
                total_aggregate_offering_price: { type: "string" },
                offering_types: { type: "string" }
              }
            }
          });
        }
      }
    } catch (_) {
      // Non-critical — continue without securities info
    }

    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isAmendment = AMENDMENT_FORMS.some(a => regType === a);

    // All filings AFTER the registration date
    const subsequentFilings = filings.filter(f => new Date(f.date) > regDate);

    // Detect FPI and F-form early (needed for ANNUAL_LIMIT calc)
    const has20F = filings.some(f => f.form === "20-F" || f.form === "20-F/A");
    const has10K = filings.some(f => f.form === "10-K");
    const isFPI = has20F && !has10K;
    const isFForm = regType.startsWith("F-");
    const isWarrantReg = isFForm && regType.includes("F-4");

    // Collect all annual reports
    const allAnnuals = filings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
    );

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

    // The registration's file number (e.g. "333-283617") — used to scope 424Bs and POS AMs
    // to only those that belong to THIS specific registration statement.
    // A company may have multiple active registrations; a 424B3 filed under one reg's file number
    // must NOT be credited as an update to a different registration.
    const regFileNumber = selectedReg.fileNumber || null;

    const belongsToThisReg = (f) => {
      // If we have a file number for the registration, only accept filings with the same file number.
      // If either side is missing the file number, allow it (conservative fallback).
      if (!regFileNumber || !f.fileNumber) return true;
      return f.fileNumber === regFileNumber;
    };

    // Post-effective amendments — EDGAR form type is "POS AM"
    // CRITICAL: A POS AM must itself be declared effective by the SEC to reset the 9-month clock.
    const allPostEffectiveAmendments = subsequentFilings.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim()) && belongsToThisReg(f)
    );
    // Only count POS AMs that have their own EFFECT notice
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffective);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffective(f));

    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    // 424B prospectuses filed after reg (424Bs are effective upon filing — no EFFECT notice needed)
    // CRITICAL: Only count 424Bs that share the same SEC file number as this registration.
    const prospectuses = subsequentFilings.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && belongsToThisReg(f)
    );
    const latestProspectus = prospectuses[0] || null;

    // ENHANCEMENT: Parse latest prospectus document to find explicitly incorporated filings
    // (e.g., "Form 20-F filed April 1, 2026" mentioned in a 424B3 supplement)
    let prospectusIncorporatedDate = null;
    let prospectusIncorporatedForm = null;
    if (latestProspectus && latestProspectus.doc) {
      try {
        const prospectusUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${latestProspectus.accession.replace(/-/g, "")}/${latestProspectus.doc}`;
        const prospRes = await fetch(prospectusUrl, { headers: HEADERS });
        if (prospRes.ok) {
          const prospText = await prospRes.text();
          // Use LLM to extract the date of the latest incorporated annual report (20-F or 10-K)
          // Pass text content directly (not file_urls which doesn't support .htm)
          const extractResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Extract from this prospectus supplement the date of the MOST RECENT annual report (Form 20-F or Form 10-K) that is explicitly mentioned as being incorporated by reference or attached. Respond with ONLY the date in YYYY-MM-DD format, or "NOT_FOUND" if no date is found.

Document (first 8000 chars):
${prospText.slice(0, 8000)}`,
          });
          if (extractResult && extractResult !== "NOT_FOUND" && /^\d{4}-\d{2}-\d{2}$/.test(extractResult)) {
            prospectusIncorporatedDate = extractResult;
            // Infer the form type from the text
            if (prospText.includes("20-F")) prospectusIncorporatedForm = "20-F";
            else if (prospText.includes("10-K")) prospectusIncorporatedForm = "10-K";
          }
        }
      } catch (err) {
        // If document fetch/parse fails, fall back to metadata-based approach
      }
    }

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

    // RULE 1: Registration must be effective. If not, return NOT CURRENT immediately.
    const effectiveness = isLikelyEffective(selectedReg);
    if (!effectiveness.effective) {
      const failDetail = `Registration statement NOT EFFECTIVE. ${effectiveness.reason}`;
      checks.push({
        id: "effectiveness",
        label: "Registration Statement Declared Effective",
        status: "fail",
        detail: failDetail,
        filingDate: null,
        filingUrl: null,
        filingForm: null,
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
          securitiesRegistered: securitiesRegistered || null,
        },
        overallStatus: "fail",
        aiSummary: {
          verdict: "NOT CURRENT",
          summary: `${companyName} registration (${selectedReg.form} ${selectedReg.date}) is NOT CURRENT: registration not effective.`,
          key_issue: "registration_not_effective",
          required_action: "Obtain declaration of effectiveness."
        },
        checks: [checks[checks.length - 1]],
        checkedAt: new Date().toISOString(),
      });
    }
    checks.push({
      id: "effectiveness",
      label: "Registration Statement Declared Effective",
      status: "pass",
      detail: `Registration effective per ${effectiveness.reason}.`,
      filingDate: effectiveness.effectDate || null,
      filingUrl: null,
      filingForm: null,
    });

    const effectiveDate = effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;

    // RULE 2: Live prospectus must be updated by VALID mechanism only:
    // - Effective POS AM, OR
    // - Valid prospectus supplement (424B for all forms), OR
    // - Valid incorporation by reference (shelf forms auto-IBR; F-1/S-1 require express election)
    // A filed but non-effective POS AM is NOT valid.
    // A 10-Q/6-K is NOT valid by itself unless expressly incorporated.
    
    // For this rule check: prospectus updates count ONLY if:
    // 1. Effective POS AM, OR
    // 2. 424B supplement
    // For F-1/F-3/S-1: must verify express IBR election (we'll flag gaps where we can't verify)
    const mostRecentEffectiveUpdate = latestPostEffective || latestProspectus || null;

    // RULE 3: Audited annual financials age test
    // DOMESTIC: Rule 427 hard stop — if today > last_audited_fs_date + 16 months, NOT CURRENT
    // FPI: Item 8 Form 20-F — audited FS generally current if not older than 15 months (or 18 for warrant exercise)
    
    // RULE 4: Interim financials age test
    // DOMESTIC: Rule 3-12 — live prospectus must include FS at least as current as most recent 10-Q filed
    // FPI: Item 8 Form 20-F — interim FS generally current if not older than 9 months (or 12 for warrant exercise)
    
    let fsStatus, fsDetail, fsFailCode;

    const annualFormLabel = isFPI ? "20-F" : "10-K";
    const interimFormLabel = isFPI ? "6-K" : "10-Q";
    const ruleRef = isFForm ? "Item 8 of Form 20-F" : "Rule 3-12 / Rule 427";

    if (isShelf) {
      // SHELF (S-3/F-3): auto-IBR means each new annual automatically incorporates
      // ENHANCEMENT: If a prospectus supplement explicitly incorporates a newer 20-F/10-K, use that date
      const effectiveAnnualDate = prospectusIncorporatedDate || latestAnnual?.date;
      if (!effectiveAnnualDate) {
        fsStatus = "fail";
        fsFailCode = "later_filing_not_incorporated";
        fsDetail = `No ${annualFormLabel} filed after shelf registration — no financials incorporated via IBR.`;
      } else {
        const annualDays = daysSince(effectiveAnnualDate);
        if (annualDays > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
          fsDetail = `${annualFormLabel} (${effectiveAnnualDate}) is ${annualDays} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit.`;
        } else {
          fsStatus = "pass";
          fsDetail = `${annualFormLabel} (${effectiveAnnualDate}, ${annualDays} days ago) is within limit.${prospectusIncorporatedDate ? ` Incorporated via latest prospectus supplement (${latestProspectus.form} ${latestProspectus.date}).` : ""}`;
        }
      }
    } else {
      // NON-SHELF (S-1/F-1/F-4): prospectus must be validly updated
      // CRITICAL: For non-shelf, we need to READ the 424B document to find what it incorporates
      // (metadata alone is not enough — must verify express incorporation)
      
      // Use the explicitly incorporated date from prospectus document if available,
      // otherwise fall back to latest posteffective or prospectus metadata
      const effectiveAnnualDateNonShelf = prospectusIncorporatedDate || 
        (latestPostEffective ? new Date(latestPostEffective.date) : null) ||
        (latestProspectus ? new Date(latestProspectus.date) : null);

      if (!effectiveAnnualDateNonShelf) {
        // No valid prospectus update (no 424B, no POS AM) — can only use reg date's FS
        fsStatus = "fail";
        fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
        fsDetail = `No 424B prospectus supplement or effective POS AM found after registration. Original prospectus FS (${selectedReg.date}) is ${daysSince(selectedReg.date)} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit.`;
      } else {
        // Prospectus was updated — use the incorporated annual FS date
        const annualDaysOld = daysSince(effectiveAnnualDateNonShelf);
        if (annualDaysOld > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_or_18_months" : "audited_financials_older_than_16_months";
          fsDetail = `Latest incorporated annual FS (${effectiveAnnualDateNonShelf}) via ${latestPostEffective?.form || latestProspectus?.form || "prospectus"} is ${annualDaysOld} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit.`;
        } else {
          fsStatus = "pass";
          fsDetail = `Audited FS (${effectiveAnnualDateNonShelf}, ${annualDaysOld} days ago) incorporated via ${latestPostEffective?.form || latestProspectus?.form || "prospectus"} — within limit.${prospectusIncorporatedDate ? ` (Parsed from ${latestProspectus?.form || "supplement"} document)` : ""}`;
        }
      }
    }

    // If annual test fails, registration is NOT CURRENT
    if (fsStatus === "fail") {
      checks.push({
        id: "financial_statements",
        label: `Audited Annual Financials (${Math.round(ANNUAL_LIMIT/30)}-Month Limit)`,
        status: "fail",
        failCode: fsFailCode,
        detail: fsDetail,
        filingDate: null,
        filingUrl: null,
        filingForm: null,
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
          securitiesRegistered: securitiesRegistered || null,
        },
        overallStatus: "fail",
        aiSummary: {
          verdict: "NOT CURRENT",
          summary: fsDetail,
          key_issue: fsFailCode,
          required_action: `File an effective POS AM with updated ${annualFormLabel}.`
        },
        checks,
        checkedAt: new Date().toISOString(),
      });
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
        // No 10-K after the registration, but check if 10-Qs have been filed and not incorporated
        if (quarterlies.length > 0 && unincorporatedQuarterlies.length > 0) {
          quarterlyStatus = "warn";
          quarterlyDetail = `PROSPECTUS INCORPORATION GAP: ${quarterlies.length} 10-Q(s) have been filed with the SEC (most recent: ${quarterlies[0].form} ${quarterlies[0].date}), but ${unincorporatedQuarterlies.length} filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. A 10-Q filed with the SEC does NOT update a non-shelf prospectus — a 424B3 supplement or declared-effective POS AM is required. Note: No post-registration 10-K found to establish a baseline for expected quarterly count.`;
        } else if (quarterlies.length > 0) {
          quarterlyStatus = "pass";
          quarterlyDetail = `${quarterlies.length} 10-Q(s) filed (most recent: ${quarterlies[0].form} ${quarterlies[0].date}). All are incorporated in the live prospectus. No post-registration 10-K on record.`;
        } else {
          quarterlyStatus = "info";
          quarterlyDetail = "No 10-K or 10-Q filed after this registration — cannot assess quarterly currency without a fiscal year baseline.";
        }
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
        securitiesRegistered: securitiesRegistered || null,
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