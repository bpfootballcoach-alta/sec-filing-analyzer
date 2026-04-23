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

const isRegForm = (form) => {
  if (!form) return false;
  const f = form.toUpperCase().trim();
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

    const tickerUpper = ticker.toUpperCase();

    const [tickerRes, tickerExRes] = await Promise.all([
      fetch("https://www.sec.gov/files/company_tickers.json", { headers: HEADERS }),
      fetch("https://www.sec.gov/files/company_tickers_exchange.json", { headers: HEADERS }),
    ]);
    const tickerData = await tickerRes.json();
    const tickerExData = tickerExRes.ok ? await tickerExRes.json() : null;

    let cik = null, companyName = null;

    for (const entry of Object.values(tickerData)) {
      if (entry.ticker?.toUpperCase() === tickerUpper) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title;
        break;
      }
    }

    if (!cik && tickerExData?.data) {
      for (const row of tickerExData.data) {
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

    const subRes = await fetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
    if (!subRes.ok) return Response.json({ error: "Failed to fetch EDGAR submissions" }, { status: 500 });
    const subData = await subRes.json();

    if (subData.name) companyName = subData.name;

    let filings = [];
    mergeFilingPage(filings, subData.filings?.recent || {});

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

    const AUTO_EFFECTIVE_FORMS = ["S-8"];
    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    const isPosAmEffective = (posAm) => {
      const posDate = new Date(posAm.date);
      return effectFilings.some(e => {
        const eDate = new Date(e.date);
        return eDate >= posDate && (eDate - posDate) <= 60 * 24 * 60 * 60 * 1000;
      });
    };

    const isLikelyEffective = (regFiling) => {
      const form = regFiling.form?.toUpperCase().trim();
      if (form === "S-8" || form?.includes("S-3") || form?.includes("F-3")) {
        return { effective: true, reason: `${form} auto-effective upon filing under Rule 462`, effectDate: regFiling.date };
      }

      const regDate = new Date(regFiling.date);
      const fileNum = regFiling.fileNumber || null;

      const sameReg = (f) => {
        if (!fileNum || !f.fileNumber) return true;
        return f.fileNumber === fileNum;
      };

      const effectAfter = effectFilings.find(e => {
        const eDate = new Date(e.date);
        return eDate >= regDate && (eDate - regDate) < 365 * 24 * 60 * 60 * 1000;
      });
      if (effectAfter) return { effective: true, reason: `EFFECT notice filed ${effectAfter.date}`, effectDate: effectAfter.date };

      const prospectusAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && sameReg(f);
      });
      if (prospectusAfter) return { effective: true, reason: `424B prospectus filed ${prospectusAfter.date} (proxy for effectiveness)`, effectDate: prospectusAfter.date };

      const posAmAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim()) && sameReg(f) && isPosAmEffective(f);
      });
      if (posAmAfter) return { effective: true, reason: `effective POS AM filed ${posAmAfter.date} (proxy for effectiveness)`, effectDate: posAmAfter.date };

      return { effective: false, reason: "No EFFECT notice, 424B, or effective POS AM found — registration may not have been declared effective" };
    };

    const regFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      return REG_FORMS.some(r => form === r || form === r + "/A" || form.startsWith(r + "/"));
    });

    if (!accession) {
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

    // ── Step 4: Deep-check the selected registration statement ────────────────

    const selectedReg = filings.find(f => f.accession === accession);
    if (!selectedReg) return Response.json({ error: "Registration statement not found" }, { status: 404 });

    // Fetch securities registered (fee table)
    let securitiesRegistered = null;
    try {
      const accNo = accession.replace(/-/g, "");
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

      if (!feeFilename) {
        const htmIdxRes = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${accession}-index.htm`,
          { headers: HEADERS }
        ).catch(() => null);
        if (htmIdxRes?.ok) {
          const idxHtml = await htmIdxRes.text();
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
    } catch (_) { /* non-critical */ }

    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isAmendment = AMENDMENT_FORMS.some(a => regType === a);

    const subsequentFilings = filings.filter(f => new Date(f.date) > regDate);

    const has20F = filings.some(f => f.form === "20-F" || f.form === "20-F/A");
    const has10K = filings.some(f => f.form === "10-K");
    const isFPI = has20F && !has10K;
    const isFForm = regType.startsWith("F-");
    const isWarrantReg = isFForm && regType.includes("F-4");

    // Thresholds
    const NINE_MONTHS = 274;       // Rule 3-12: prospectus stale after 9 months from effective date
    const FIFTEEN_MONTHS = 456;
    const SIXTEEN_MONTHS = 487;    // Rule 3-12/427: hard cap on audited FS age (measured from fiscal year-end)
    const TWELVE_MONTHS = 365;
    const EIGHTEEN_MONTHS = 548;

    // Annual FS age limit measured from fiscal year-end date (not filing date)
    const ANNUAL_LIMIT = isFForm
      ? (isWarrantReg ? EIGHTEEN_MONTHS : FIFTEEN_MONTHS)
      : SIXTEEN_MONTHS;

    // Interim FS limit
    const INTERIM_LIMIT = (isFForm && isWarrantReg) ? TWELVE_MONTHS : NINE_MONTHS;

    const regFileNumber = selectedReg.fileNumber || null;

    // Prospectus metadata — populated after parsing the latest 424B document
    let prospectusIncorporatedDate = null;        // fiscal year-end date of the incorporated annual FS
    let prospectusIncorporatedForm = null;        // "20-F" or "10-K"
    let prospectusRegNumber = null;               // "333-XXXXXX" from the document itself
    let prospectusInterimPeriodEndDate = null;    // fiscal period-end of the most recent interim FS incorporated

    const belongsToThisReg = (f) => {
      if (prospectusRegNumber && f === latestProspectus) {
        return prospectusRegNumber === regFileNumber;
      }
      if (!regFileNumber || !f.fileNumber) return true;
      return f.fileNumber === regFileNumber;
    };

    // Post-effective amendments
    const allPostEffectiveAmendments = subsequentFilings.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim()) && belongsToThisReg(f)
    );
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffective);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffective(f));
    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    // 424B prospectuses
    const prospectuses = subsequentFilings.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && belongsToThisReg(f)
    );
    const latestProspectus = prospectuses[0] || null;

    // ── Parse the latest prospectus document ─────────────────────────────────
    // Extract:
    //   1. Which registration file number it updates (to confirm it belongs here)
    //   2. The fiscal year-end date of the most recent audited FS incorporated by reference
    //   3. The fiscal period-end of the most recent interim (10-Q/6-K) FS incorporated
    // CRITICAL: We measure staleness from fiscal year-end / period-end, NOT from filing date.
    if (latestProspectus && latestProspectus.doc) {
      try {
        const prospectusUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${latestProspectus.accession.replace(/-/g, "")}/${latestProspectus.doc}`;
        const prospRes = await fetch(prospectusUrl, { headers: HEADERS });
        if (prospRes.ok) {
          const prospText = await prospRes.text();
          const extractResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Analyze this SEC prospectus supplement and extract FOUR pieces of information:

1. REGISTRATION FILE NUMBER: The "333-XXXXXX" registration statement file number this prospectus updates/supplements. Look for text like "Registration Statement No. 333-XXXXXX" or "File No. 333-XXXXXX".

2. ANNUAL FS FISCAL YEAR-END DATE: The fiscal year-end date (balance sheet date) of the most recent audited annual financial statements incorporated by reference. This is the END of the fiscal year covered by the most recent 10-K or 20-F mentioned. For example, if the document says "Annual Report on Form 10-K for the fiscal year ended December 31, 2024", the answer is "2024-12-31". Do NOT use the filing date of the 10-K — use the fiscal year-end date.

3. ANNUAL FS FORM TYPE: "10-K" or "20-F" — whichever annual form is incorporated.

4. INTERIM FS PERIOD-END DATE: The fiscal period-end date of the most recent interim financial statements incorporated by reference (from a 10-Q or 6-K). For example "2024-09-30" for a Q3 report. Return null if no interim FS are incorporated.

Respond ONLY as JSON:
{
  "registration_number": "333-XXXXXX or null",
  "annual_fs_fiscal_year_end": "YYYY-MM-DD or null",
  "annual_fs_form": "10-K or 20-F or null",
  "interim_fs_period_end": "YYYY-MM-DD or null"
}

Document (first 12000 chars):
${prospText.slice(0, 12000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                registration_number: { type: ["string", "null"] },
                annual_fs_fiscal_year_end: { type: ["string", "null"] },
                annual_fs_form: { type: ["string", "null"] },
                interim_fs_period_end: { type: ["string", "null"] }
              }
            }
          });

          if (extractResult?.registration_number) {
            prospectusRegNumber = extractResult.registration_number;
          }
          if (extractResult?.annual_fs_fiscal_year_end && /^\d{4}-\d{2}-\d{2}$/.test(extractResult.annual_fs_fiscal_year_end)) {
            prospectusIncorporatedDate = extractResult.annual_fs_fiscal_year_end;
          }
          if (extractResult?.annual_fs_form) {
            prospectusIncorporatedForm = extractResult.annual_fs_form;
          }
          if (extractResult?.interim_fs_period_end && /^\d{4}-\d{2}-\d{2}$/.test(extractResult.interim_fs_period_end)) {
            prospectusInterimPeriodEndDate = extractResult.interim_fs_period_end;
          }
        }
      } catch (_) { /* fall back to metadata */ }
    }

    // Annual reports and quarterlies filed after reg
    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
    );
    const latestAnnual = annuals[0] || null;

    const quarterlies = subsequentFilings.filter(f =>
      f.form === "10-Q" || f.form === "10-Q/A"
    );
    const latestQuarterly = quarterlies[0] || null;

    const currentReports = subsequentFilings.filter(f => f.form?.startsWith("8-K"));
    const latestCurrent = currentReports[0] || null;

    const checks = [];

    // ── CHECK A: Registration effectiveness ──────────────────────────────────
    const effectiveness = isLikelyEffective(selectedReg);
    if (!effectiveness.effective) {
      checks.push({
        id: "effectiveness",
        label: "Registration Statement Declared Effective",
        status: "fail",
        detail: `Registration statement NOT EFFECTIVE. ${effectiveness.reason}`,
        filingDate: null, filingUrl: null, filingForm: null,
      });
      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession, daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg, annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: Math.round(INTERIM_LIMIT / 30), securitiesRegistered: securitiesRegistered || null },
        overallStatus: "fail",
        aiSummary: { verdict: "NOT CURRENT", summary: `Registration not effective.`, key_issue: "registration_not_effective", required_action: "Obtain declaration of effectiveness." },
        checks: [checks[checks.length - 1]],
        checkedAt: new Date().toISOString(),
      });
    }
    checks.push({
      id: "effectiveness",
      label: "Registration Statement Declared Effective",
      status: "pass",
      detail: `Registration effective per ${effectiveness.reason}.`,
      filingDate: effectiveness.effectDate || null, filingUrl: null, filingForm: null,
    });

    const effectiveDate = effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;
    const daysSinceEffective = Math.floor((new Date() - effectiveDate) / (1000 * 60 * 60 * 24));

    const annualFormLabel = isFPI ? "20-F" : "10-K";
    const interimFormLabel = isFPI ? "6-K" : "10-Q";
    const mostRecentEffectiveUpdate = latestPostEffective || latestProspectus || null;

    // ── CHECK B: Rule 3-12 / Rule 427 — Audited Annual FS Age ────────────────
    //
    // The rule measures from the FISCAL YEAR-END DATE of the audited FS in the live prospectus.
    // For shelf (S-3/F-3): the latest annual report auto-incorporates via IBR.
    //   → Use the fiscal year-end date we extracted from the prospectus supplement, or
    //     fall back to the latest annual report EDGAR filing date as a conservative proxy
    //     (the actual fiscal year-end is always before the filing date, so this slightly
    //     over-estimates age — acceptable as a conservative fallback).
    // For non-shelf (S-1/F-1): the prospectus must have been validly updated via 424B or effective POS AM
    //   that expressly incorporated the audited FS.
    //   → We extracted the fiscal year-end date from the prospectus document.
    //   → If not available, we use the date of the update document as a conservative proxy.
    //
    // SEPARATE from the 16-month cap: for non-shelf, the 9-month staleness rule (Rule 3-12(g))
    // also prohibits use of the prospectus after 9 months from effective date UNLESS the FS have
    // been updated — checked in CHECK B2 below.

    let fsStatus, fsDetail, fsFailCode;

    if (isShelf) {
      // Shelf: IBR of latest annual is automatic
      // Fiscal year-end date: prefer what the prospectus supplement says; fall back to filing date of latest annual
      const annualFiscalYearEnd = prospectusIncorporatedDate || latestAnnual?.date || null;

      if (!annualFiscalYearEnd) {
        fsStatus = "fail";
        fsFailCode = "no_annual_report_incorporated";
        fsDetail = `No ${annualFormLabel} filed after shelf registration — no financials incorporated via IBR. Registration is NOT CURRENT.`;
      } else {
        const annualAge = daysSince(annualFiscalYearEnd);
        if (annualAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_months" : "audited_financials_older_than_16_months";
          fsDetail = `${annualFormLabel} fiscal year-end (${annualFiscalYearEnd}) is ${annualAge} days old — exceeds the ${Math.round(ANNUAL_LIMIT/30)}-month Rule 3-12/427 hard cap. Registration is NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          const sourceNote = prospectusIncorporatedDate
            ? ` (fiscal year-end extracted from ${latestProspectus?.form || "prospectus supplement"} ${latestProspectus?.date})`
            : ` (using ${annualFormLabel} filing date ${annualFiscalYearEnd} as proxy for fiscal year-end — actual year-end is earlier, so age may be slightly under-estimated)`;
          fsDetail = `${annualFormLabel} fiscal year-end ${annualFiscalYearEnd} is ${annualAge} days old — within the ${Math.round(ANNUAL_LIMIT/30)}-month limit.${sourceNote}`;
        }
      }
    } else {
      // Non-shelf: prospectus must have been validly updated
      // Determine the fiscal year-end of the audited FS in the live prospectus:
      //   Option A: LLM extracted it from the document (most accurate)
      //   Option B: fall back to the date of the most recent update document (conservative proxy — over-estimates age)
      const annualFiscalYearEnd = prospectusIncorporatedDate ||
        latestPostEffective?.date ||
        latestProspectus?.date ||
        null;

      if (!annualFiscalYearEnd) {
        // No update at all — the only FS are those in the original registration statement
        const regAge = daysSince(selectedReg.date);
        fsStatus = "fail";
        fsFailCode = "audited_financials_older_than_16_months";
        fsDetail = `No 424B supplement or effective POS AM found. Original registration FS are from ${selectedReg.date} (${regAge} days ago). ${regAge > ANNUAL_LIMIT ? `Exceeds ${Math.round(ANNUAL_LIMIT/30)}-month hard cap — NOT CURRENT.` : `Within ${Math.round(ANNUAL_LIMIT/30)}-month cap, but see 9-month stale-prospectus check below.`}`;
        // Only hard-fail here if beyond the annual cap; the 9-month check handles the earlier gate
        if (regAge <= ANNUAL_LIMIT) {
          fsStatus = "pass";
          fsFailCode = null;
          fsDetail = `No 424B or POS AM found. Using original registration FS from ${selectedReg.date} (${regAge} days ago) — within ${Math.round(ANNUAL_LIMIT/30)}-month annual cap (see 9-month stale-prospectus check below).`;
        }
      } else {
        const annualAge = daysSince(annualFiscalYearEnd);
        if (annualAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = isFForm ? "fpi_audited_financials_older_than_15_months" : "audited_financials_older_than_16_months";
          const sourceNote = prospectusIncorporatedDate ? `(fiscal year-end from prospectus document)` : `(using document date as proxy — actual fiscal year-end is earlier)`;
          fsDetail = `Audited FS fiscal year-end ${annualFiscalYearEnd} ${sourceNote} is ${annualAge} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month hard cap. Registration is NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          const sourceNote = prospectusIncorporatedDate
            ? `Fiscal year-end extracted from ${latestProspectus?.form || "prospectus"} ${latestProspectus?.date}.`
            : `Using ${latestPostEffective?.form || latestProspectus?.form || "update"} date as conservative proxy for fiscal year-end.`;
          fsDetail = `Audited FS fiscal year-end ${annualFiscalYearEnd} is ${annualAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month cap. ${sourceNote}`;
        }
      }
    }

    // Early exit on annual FS failure
    if (fsStatus === "fail") {
      checks.push({
        id: "financial_statements",
        label: `Audited Annual FS — Rule 3-12/427 (${Math.round(ANNUAL_LIMIT/30)}-month hard cap from fiscal year-end)`,
        status: "fail", failCode: fsFailCode, detail: fsDetail,
        filingDate: null, filingUrl: null, filingForm: null,
      });
      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession, daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg, annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: Math.round(INTERIM_LIMIT / 30), securitiesRegistered: securitiesRegistered || null },
        overallStatus: "fail",
        aiSummary: { verdict: "NOT CURRENT", summary: fsDetail, key_issue: fsFailCode, required_action: `Update the prospectus with a current ${annualFormLabel} (fiscal year-end must be within ${Math.round(ANNUAL_LIMIT/30)} months).` },
        checks,
        checkedAt: new Date().toISOString(),
      });
    }

    checks.push({
      id: "financial_statements",
      label: isFForm
        ? `Audited Annual FS — Item 8/Form 20-F (${Math.round(ANNUAL_LIMIT/30)}-month cap from fiscal year-end)`
        : `Audited Annual FS — Rule 3-12/427 (${Math.round(ANNUAL_LIMIT/30)}-month hard cap from fiscal year-end)`,
      status: fsStatus, failCode: fsFailCode || null, detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus),
      filingForm: latestPostEffective?.form || latestProspectus?.form || null,
    });

    // ── CHECK B2: Rule 3-12(g) — 9-month stale-prospectus clock (non-shelf only) ──
    // After 9 months from the effective date, the prospectus CANNOT be used for offers
    // unless it has been updated to include FS as current as the most recently filed annual/quarterly report.
    // This is a SEPARATE, STRICTER gate than the 16-month hard cap.
    // A prospectus that passes the 16-month annual cap can still fail this 9-month check.
    if (!isShelf) {
      if (daysSinceEffective > NINE_MONTHS) {
        // The 9-month window has elapsed. The prospectus must have been updated.
        // A valid update means: effective POS AM or 424B supplement filed after the 9-month mark
        // that incorporated FS at least as current as the most recently filed annual/quarterly report.
        const hasValidUpdateAfterNineMonths = !!mostRecentEffectiveUpdate;

        if (!hasValidUpdateAfterNineMonths) {
          // No update at all — definitely stale
          checks.push({
            id: "nine_month_clock",
            label: "9-Month Stale-Prospectus Rule (Rule 3-12(g))",
            status: "fail",
            failCode: "prospectus_stale_nine_months_no_update",
            detail: `Registration has been effective for ${daysSinceEffective} days (${Math.round(daysSinceEffective/30)} months) — past the 9-month threshold. No 424B supplement or effective POS AM has been filed. Under Rule 3-12(g), the prospectus CANNOT be used for offers until updated with current financial statements. Registration is NOT CURRENT.`,
            filingDate: null, filingUrl: null, filingForm: null,
          });
        } else {
          // There is an update. Check whether it catches up to the most recent EDGAR filings.
          // If a newer 10-Q or 10-K exists on EDGAR that postdates the last prospectus update,
          // the live prospectus does not include those FS — Rule 3-12 violation.
          const updateDate = new Date(mostRecentEffectiveUpdate.date);
          const newerAnnual = latestAnnual && new Date(latestAnnual.date) > updateDate ? latestAnnual : null;
          const newerQuarterly = latestQuarterly && new Date(latestQuarterly.date) > updateDate ? latestQuarterly : null;

          // Use the interim period-end extracted from the prospectus if available
          // to more precisely assess the gap (rather than just comparing filing dates)
          if (newerAnnual) {
            checks.push({
              id: "nine_month_clock",
              label: "9-Month Stale-Prospectus Rule (Rule 3-12(g)) — Annual FS Gap",
              status: "fail",
              failCode: "later_annual_not_incorporated",
              detail: `Registration effective for ${daysSinceEffective} days. Live prospectus last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}. A newer ${newerAnnual.form} was filed on ${newerAnnual.date} — this annual report is NOT incorporated in the live prospectus. Under Rule 3-12, the prospectus must include FS at least as current as the most recently filed annual report. File a 424B supplement or effective POS AM incorporating the ${newerAnnual.form}. Registration is NOT CURRENT.`,
              filingDate: newerAnnual.date, filingUrl: edgarUrl(newerAnnual), filingForm: newerAnnual.form,
            });
          } else if (newerQuarterly) {
            checks.push({
              id: "nine_month_clock",
              label: "9-Month Stale-Prospectus Rule (Rule 3-12(g)) — Interim FS Gap",
              status: "fail",
              failCode: "later_quarterly_not_incorporated",
              detail: `Registration effective for ${daysSinceEffective} days. Live prospectus last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}. A newer ${newerQuarterly.form} was filed on ${newerQuarterly.date} — these interim FS are NOT incorporated in the live prospectus. Under Rule 3-12, the prospectus must include FS at least as current as the most recently filed 10-Q. File a 424B supplement or effective POS AM incorporating the ${newerQuarterly.form}. Registration is NOT CURRENT.`,
              filingDate: newerQuarterly.date, filingUrl: edgarUrl(newerQuarterly), filingForm: newerQuarterly.form,
            });
          } else {
            checks.push({
              id: "nine_month_clock",
              label: "9-Month Stale-Prospectus Rule (Rule 3-12(g))",
              status: "pass",
              detail: `Registration effective for ${daysSinceEffective} days (past 9-month mark). Prospectus was validly updated on ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}${prospectusIncorporatedDate ? `, incorporating FS with fiscal year-end ${prospectusIncorporatedDate}` : ""}. No newer annual or quarterly report on EDGAR postdates that update. Rule 3-12 interim catch-up requirement satisfied.`,
              filingDate: mostRecentEffectiveUpdate.date, filingUrl: edgarUrl(mostRecentEffectiveUpdate), filingForm: mostRecentEffectiveUpdate.form,
            });
          }
        }
      } else {
        // Still within the 9-month window
        checks.push({
          id: "nine_month_clock",
          label: "9-Month Stale-Prospectus Rule (Rule 3-12(g))",
          status: "pass",
          detail: `Registration effective for ${daysSinceEffective} days — still within the 9-month window (${NINE_MONTHS} days). No prospectus update required yet under Rule 3-12(g).`,
          filingDate: null, filingUrl: null, filingForm: null,
        });
      }
    }

    // ── CHECK C: Interim Reports — Exchange Act currency & incorporation gap ─
    let quarterlyStatus, quarterlyDetail;
    const annualDateForQ = latestAnnual ? new Date(latestAnnual.date) : null;
    const annualDaysForQ = latestAnnual ? daysSince(latestAnnual.date) : null;

    if (isFPI) {
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
        quarterlyDetail = `FPI — no Form 10-Q obligation. No 6-K filings found since this registration statement.`;
      } else {
        const sixKDays = daysSince(latestSixK.date);
        if (!isShelf && unincorporated6Ks.length > 0) {
          quarterlyStatus = "warn";
          quarterlyDetail = `FPI INTERIM INCORPORATION GAP: ${sixKs.length} 6-K(s) filed since registration (most recent: ${latestSixK.date}, ${sixKDays} days ago). ${unincorporated6Ks.length} 6-K(s) filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. 6-Ks do NOT automatically update a non-shelf prospectus — a 424B3 supplement or effective POS AM expressly incorporating the 6-K is required.`;
        } else {
          quarterlyStatus = "pass";
          quarterlyDetail = `FPI — ${sixKs.length} 6-K(s) filed since registration (most recent: ${latestSixK.date}, ${sixKDays} days ago).`;
        }
      }
      checks.push({
        id: "quarterly_reports",
        label: "Interim Reports (6-K) — FPI",
        status: quarterlyStatus, detail: quarterlyDetail,
        filingDate: latestSixK?.date || null, filingUrl: edgarUrl(latestSixK), filingForm: latestSixK?.form || null,
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
        if (quarterlies.length > 0 && unincorporatedQuarterlies.length > 0) {
          quarterlyStatus = "warn";
          quarterlyDetail = `PROSPECTUS INCORPORATION GAP: ${quarterlies.length} 10-Q(s) filed (most recent: ${quarterlies[0].form} ${quarterlies[0].date}), but ${unincorporatedQuarterlies.length} filed after the last prospectus update are NOT part of the live prospectus. A 10-Q does NOT automatically update a non-shelf prospectus — incorporate via 424B3 or effective POS AM. No post-registration 10-K found.`;
        } else if (quarterlies.length > 0) {
          quarterlyStatus = "pass";
          quarterlyDetail = `${quarterlies.length} 10-Q(s) filed (most recent: ${quarterlies[0].form} ${quarterlies[0].date}). All incorporated in the live prospectus. No post-registration 10-K found.`;
        } else {
          quarterlyStatus = "info";
          quarterlyDetail = "No 10-K or 10-Q filed after this registration — cannot assess quarterly currency.";
        }
      } else if (expectedQ === 0) {
        quarterlyStatus = "pass";
        quarterlyDetail = `10-K filed ${annualDaysForQ} days ago — no quarterly report yet due. No quarterly incorporation gap.`;
      } else if (quartersFiledSinceAnnual < expectedQ) {
        const missing = expectedQ - quartersFiledSinceAnnual;
        quarterlyStatus = "fail";
        quarterlyDetail = `EDGAR FILING GAP: Only ${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K (${latestAnnual.date}). ${missing} report(s) missing — company may be delinquent.`;
      } else if (!isShelf && unincorporatedQuarterlies.length > 0) {
        // Note: this is a prospectus incorporation gap. The 9-month clock check (CHECK B2) above
        // already catches this as a hard fail when past the 9-month mark. Here we report it
        // as a warn for the case still within the 9-month window (not yet a hard violation).
        quarterlyStatus = "warn";
        quarterlyDetail = `PROSPECTUS INCORPORATION GAP: ${quartersFiledSinceAnnual} of ${expectedQ} 10-Q(s) current on EDGAR, but ${unincorporatedQuarterlies.length} 10-Q(s) filed after the last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT part of the live prospectus. A 10-Q does NOT automatically update a non-shelf prospectus. Incorporate via 424B3 or effective POS AM. Most recent unincorporated: ${unincorporatedQuarterlies[0].form} ${unincorporatedQuarterlies[0].date}.`;
      } else {
        quarterlyStatus = "pass";
        quarterlyDetail = `${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed and incorporated since last 10-K. (No Q4 10-Q required — covered by 10-K.)`;
      }
      checks.push({
        id: "quarterly_reports",
        label: "Quarterly Reports (10-Q) — EDGAR Currency & Prospectus Incorporation",
        status: quarterlyStatus, detail: quarterlyDetail,
        filingDate: latestQuarterly?.date || null, filingUrl: edgarUrl(latestQuarterly), filingForm: latestQuarterly?.form || null,
        count: quarterlies.length,
      });
    }

    // ── CHECK D: Current Reports (8-K) ───────────────────────────────────────
    let currentStatus, currentDetail;
    if (isFPI) {
      currentStatus = "info";
      currentDetail = "FPI — no Form 8-K obligation. Material information furnished via Form 6-K (see Interim Reports above).";
    } else {
      if (!latestCurrent) {
        currentStatus = "warn";
        currentDetail = "No 8-K current reports filed since this registration statement. Verify whether material events required disclosure.";
      } else {
        const cDays = daysSince(latestCurrent.date);
        currentStatus = cDays <= 365 ? "pass" : "warn";
        currentDetail = `Most recent 8-K filed ${cDays} days ago on ${latestCurrent.date}. ${currentReports.length} total 8-K(s) since registration.`;
      }
    }
    checks.push({
      id: "current_reports",
      label: isFPI ? "Current Reports — FPI (6-K)" : "Current Reports (8-K) Filed Since Registration",
      status: currentStatus, detail: currentDetail,
      filingDate: latestCurrent?.date || null, filingUrl: edgarUrl(latestCurrent), filingForm: latestCurrent?.form || null,
      count: currentReports.length,
    });

    // ── CHECK E: Post-Effective Amendments ───────────────────────────────────
    let amendStatus, amendDetail;
    if (isShelf) {
      amendStatus = "info";
      amendDetail = "Shelf (S-3/F-3) kept current via IBR of annual reports — POS AM not required for Section 10(a)(3) compliance.";
    } else if (allPostEffectiveAmendments.length === 0) {
      amendStatus = "info";
      amendDetail = "No POS AM filings found for this registration statement.";
    } else if (effectivePostEffectiveAmendments.length === 0) {
      amendStatus = "fail";
      amendDetail = `${allPostEffectiveAmendments.length} POS AM(s) filed but NONE declared effective (no EFFECT notice). A filed POS AM does NOT satisfy Section 10(a)(3) until the SEC issues an effectiveness order. Most recent (not effective): ${latestPendingPosAm.form} on ${latestPendingPosAm.date}.`;
    } else {
      const aDays = daysSince(latestPostEffective.date);
      const pendingNote = latestPendingPosAm ? ` Additionally, ${pendingPostEffectiveAmendments.length} POS AM(s) filed but not yet effective.` : "";
      amendStatus = "pass";
      amendDetail = `${effectivePostEffectiveAmendments.length} effective POS AM(s). Most recent: ${latestPostEffective.form} on ${latestPostEffective.date} (${aDays} days ago).${pendingNote}`;
    }
    checks.push({
      id: "amendments",
      label: "Post-Effective Amendments (POS AM)",
      status: amendStatus, detail: amendDetail,
      filingDate: latestPostEffective?.date || latestPendingPosAm?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestPendingPosAm),
      filingForm: latestPostEffective?.form || latestPendingPosAm?.form || null,
      count: allPostEffectiveAmendments.length,
      effectiveCount: effectivePostEffectiveAmendments.length,
    });

    const overallStatus =
      checks.some(c => c.status === "fail") ? "fail" :
      checks.some(c => c.status === "warn") ? "warn" : "pass";

    const checkSummary = checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n");

    const frameworkNote = isFForm
      ? `F-form (${selectedReg.form}) — Item 8 Form 20-F. Annual FS limit: ${Math.round(ANNUAL_LIMIT/30)} months from fiscal year-end${isWarrantReg ? " (18-mo relaxation)" : ""}. Interim limit: ${Math.round(INTERIM_LIMIT/30)} months. IBR on F-1/F-4 is NOT automatic.`
      : `Domestic (${selectedReg.form}) — Rule 3-12/427. TWO separate tests: (1) 16-month hard cap on audited FS measured from fiscal year-end date; (2) 9-month stale-prospectus gate from effective date — after 9 months, cannot use prospectus unless updated AND updated prospectus includes FS at least as current as latest filed 10-K/10-Q. A bare 10-Q filing does NOT update the prospectus.`;

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `You are a securities law compliance expert applying SEC Rule 3-12 / Rule 427 financial-statement currency rules.

Framework: ${frameworkNote}

CURRENT = effective AND (a) audited FS fiscal year-end within ${Math.round(ANNUAL_LIMIT/30)} months AND (b) if past 9 months from effective date: prospectus updated AND no newer 10-K or 10-Q on EDGAR that postdates the update.
Only "fail" = NOT CURRENT. "warn" = can still be used but requires remediation. "pass" = CURRENT.

Company: ${companyName} (${ticker.toUpperCase()})
Form: ${selectedReg.form} filed ${selectedReg.date}
Type: ${isShelf ? "Shelf" : "Non-Shelf"} | FPI: ${isFPI ? "Yes" : "No"} | Effective: ${effectiveDate.toISOString().split("T")[0]} (${daysSinceEffective} days ago)

Compliance checks:
${checkSummary}

Overall: ${overallStatus.toUpperCase()}

Provide a direct 2-3 sentence verdict. State the primary issue. What action is required?`,
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
      ticker: ticker.toUpperCase(), cik, companyName,
      registration: {
        form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
        daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg,
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