import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };
const EDGAR_BASE = "https://data.sec.gov/submissions";

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
};

const daysBetween = (a, b) =>
  Math.floor((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));

const REG_FORMS = ["S-1", "S-3", "F-1", "F-3", "F-4", "S-11", "S-4", "S-8"];
const AMENDMENT_FORMS = ["S-1/A", "S-3/A", "F-1/A", "F-3/A", "S-4/A", "S-11/A"];
const POST_EFFECTIVE_FORMS = ["POS AM", "POS AM/A"];
const PROSPECTUS_FORMS = ["424B1", "424B2", "424B3", "424B4", "424B5", "424B7", "424B8", "PROSPECTUS"];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    const { ticker, accession } = body;
    if (!ticker) return Response.json({ error: "ticker is required" }, { status: 400 });

    const tickerUpper = ticker.toUpperCase();

    // ── Resolve ticker → CIK ─────────────────────────────────────────────────
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

    // ── Fetch all EDGAR filings ───────────────────────────────────────────────
    const mergeFilingPage = (acc, page) => {
      const forms = page.form || [], dates = page.filingDate || [],
            accessions = page.accessionNumber || [], docs = page.primaryDocument || [],
            fileNumbers = page.fileNumber || [], descriptions = page.primaryDocDescription || [],
            sizes = page.size || [];
      for (let i = 0; i < forms.length; i++) {
        if (forms[i] && dates[i]) {
          acc.push({ form: forms[i], date: dates[i], accession: accessions[i], doc: docs[i],
            cik, fileNumber: fileNumbers[i] || null, description: descriptions[i] || null, size: sizes[i] || 0 });
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
        if (pageRes.ok) mergeFilingPage(filings, await pageRes.json());
      }
    }

    const edgarUrl = (f) => f
      ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${f.accession.replace(/-/g, "")}/${f.doc}`
      : null;

    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    const isPosAmEffective = (posAm) => {
      const posDate = new Date(posAm.date);
      return effectFilings.some(e => {
        const eDate = new Date(e.date);
        return eDate >= posDate && (eDate - posDate) <= 60 * 24 * 60 * 60 * 1000;
      });
    };

    // Determine whether a registration statement has been declared effective
    const isLikelyEffective = (regFiling) => {
      const form = regFiling.form?.toUpperCase().trim();
      // S-3, F-3, S-8 are auto-effective upon filing
      if (form === "S-8" || form?.includes("S-3") || form?.includes("F-3")) {
        return { effective: true, reason: `${form} auto-effective upon filing under Rule 462`, effectDate: regFiling.date };
      }
      const regDate = new Date(regFiling.date);
      const fileNum = regFiling.fileNumber || null;
      const sameReg = (f) => (!fileNum || !f.fileNumber) ? true : f.fileNumber === fileNum;

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
      if (posAmAfter) return { effective: true, reason: `effective POS AM filed ${posAmAfter.date}`, effectDate: posAmAfter.date };

      return { effective: false, reason: "No EFFECT notice, 424B, or effective POS AM found" };
    };

    // ── List mode ─────────────────────────────────────────────────────────────
    const regFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      return REG_FORMS.some(r => form === r || form === r + "/A" || form.startsWith(r + "/"));
    });

    if (!accession) {
      const subjectSummaries = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `For each of the following SEC registration statement filings by ${companyName} (ticker: ${ticker.toUpperCase()}), write a concise label (5-12 words) listing the types of securities being registered and the offering context. Examples: "Common stock — IPO", "Common stock & warrants — resale", "Underlying shares from convertible notes — resale", "Employee stock options — S-8 plan", "Common stock, preferred stock & warrants — shelf offering", "Merger consideration shares — S-4". Focus on security types and whether it's primary, resale/secondary, or merger/plan. If amendment (/A), prepend "Amendment: ". Return a JSON array in the same order.

Filings:
${regFilings.map((f, i) => `${i}. Form: ${f.form}, Date: ${f.date}, Description: "${f.description || ""}"`).join("\n")}`,
        response_json_schema: { type: "object", properties: { summaries: { type: "array", items: { type: "string" } } } }
      });
      const summaryList = subjectSummaries?.summaries || [];
      return Response.json({
        mode: "list", ticker: ticker.toUpperCase(), cik, companyName,
        registrationStatements: regFilings.map((f, i) => {
          const eff = isLikelyEffective(f);
          return { form: f.form, date: f.date, accession: f.accession, doc: f.doc, url: edgarUrl(f),
            daysOld: daysSince(f.date), effective: eff.effective, effectiveReason: eff.reason,
            effectDate: eff.effectDate || null, registrationNumber: f.fileNumber || null, subject: summaryList[i] || null };
        }),
      });
    }

    // ── Detail mode: deep-check the selected registration ────────────────────
    const selectedReg = filings.find(f => f.accession === accession);
    if (!selectedReg) return Response.json({ error: "Registration statement not found" }, { status: 404 });

    // ── Fetch securities registered from fee table ────────────────────────────
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
            d.type?.toUpperCase().includes("EX-FILING FEE") || d.description?.toUpperCase().includes("FILING FEE")
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
          for (const row of (idxHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
            if (/EX-FILING FEE/i.test(row)) {
              const m = row.match(/href="([^"]+\.htm)"/i);
              if (m) { feeFilename = m[1].split("/").pop(); break; }
            }
          }
        }
      }
      if (feeFilename) {
        const feeRes = await fetch(`https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo}/${feeFilename}`, { headers: HEADERS });
        if (feeRes.ok) {
          const feeText = (await feeRes.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          securitiesRegistered = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Extract securities from this SEC filing fee table. Include security type, class, amount registered, price per unit, aggregate offering price. Note primary vs resale. Produce a short "label" (5-10 words). Fee table:\n${feeText.slice(0, 6000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                label: { type: "string" }, summary: { type: "string" },
                securities: { type: "array", items: { type: "object", properties: {
                  security_class: { type: "string" }, offering_type: { type: "string" },
                  amount_registered: { type: "string" }, price_per_unit: { type: "string" },
                  aggregate_offering_price: { type: "string" }
                }}},
                total_aggregate_offering_price: { type: "string" }, offering_types: { type: "string" }
              }
            }
          });
        }
      }
    } catch (_) { /* non-critical */ }

    // ── Issuer / form classification ─────────────────────────────────────────
    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isFForm = regType.startsWith("F-");
    const isWarrantReg = isFForm && regType.includes("F-4");
    // S-4 and F-4 are transaction registrations (mergers/business combinations).
    // Once the transaction is complete, these registrations are no longer used for
    // ongoing offers — Section 10(a)(3) prospectus currency obligations do not apply
    // to a completed transaction S-4/F-4. Only warrant exercise S-4s (isWarrantReg)
    // or those with ongoing resale obligations need currency monitoring.
    const isTransactionReg = (regType === "S-4" || regType === "S-4/A" || regType === "F-4" || regType === "F-4/A") && !isWarrantReg;

    const has20F = filings.some(f => f.form === "20-F" || f.form === "20-F/A");
    const has10K = filings.some(f => f.form === "10-K");
    const isFPI = has20F && !has10K;

    // Was this issuer subject to Exchange Act reporting BEFORE filing?
    // Heuristic: if they had filed 10-K/20-F/10-Q/8-K BEFORE the reg statement date, yes.
    const priorExchangeActFilings = filings.filter(f => {
      const fDate = new Date(f.date);
      return fDate < regDate &&
        (f.form === "10-K" || f.form === "20-F" || f.form === "10-Q" || f.form?.startsWith("8-K") || f.form === "6-K");
    });
    const isExchangeActReporterBeforeFiling = priorExchangeActFilings.length > 0;

    const subsequentFilings = filings.filter(f => new Date(f.date) > regDate);

    // ── Staleness thresholds ──────────────────────────────────────────────────
    // Rule 3-12 (pre-effective) thresholds — measured from fiscal year-end:
    //   • If issuer was subject to Exchange Act reporting immediately before filing:
    //       Large accelerated / accelerated filer: 130 days post-year-end
    //       All others (non-accelerated, SRC): 135 days post-year-end
    //   • If issuer was NOT subject to Exchange Act reporting immediately before filing:
    //       1 year + 45 days from fiscal year-end (i.e. 410 days)
    //   • FPI & investment company: carve-out — they have different rules; flag as info
    //
    // Section 10(a)(3) / Item 512 (post-effective) thresholds:
    //   • 9 months from effective date: prospectus cannot be used unless updated
    //   • 16 months from fiscal year-end: hard cap on age of audited FS in prospectus
    //   • IBR: for shelf (S-3/F-3), later 10-K/10-Q automatically refresh via incorporation by reference
    //   • For non-shelf: 424B supplement or effective POS AM required to incorporate newer FS

    const RULE_312_DAYS_ACCELERATED = 130;
    const RULE_312_DAYS_OTHERS = 135;
    const RULE_312_DAYS_NON_REPORTING = 410; // 1 year + 45 days

    const SECTION_10A3_16_MONTHS = 487;
    const SECTION_10A3_15_MONTHS = 456; // F-forms
    const SECTION_10A3_18_MONTHS = 548; // F-4 warrant exercise relaxation
    const SECTION_10A3_9_MONTHS = 274;

    // Post-effective annual FS age cap
    const ANNUAL_LIMIT = isFForm
      ? (isWarrantReg ? SECTION_10A3_18_MONTHS : SECTION_10A3_15_MONTHS)
      : SECTION_10A3_16_MONTHS;

    const annualFormLabel = isFPI ? "20-F" : "10-K";
    const interimFormLabel = isFPI ? "6-K" : "10-Q";

    const regFileNumber = selectedReg.fileNumber || null;

    // ── Scoped prospectus parsing ─────────────────────────────────────────────
    let prospectusRegNumber = null;
    let prospectusIncorporatedDate = null;      // fiscal year-end of audited FS in live prospectus
    let prospectusIncorporatedForm = null;
    let prospectusInterimPeriodEndDate = null;  // period-end of interim FS in live prospectus

    // ── IBR analysis of the registration statement itself ─────────────────────
    // Many non-shelf registrations (S-1, S-4, F-1, etc.) contain an explicit
    // "Incorporation by Reference" section that lists specific Exchange Act reports
    // AND/OR adopts a "forward" or "automatic" IBR clause that incorporates ALL
    // future Exchange Act filings automatically.
    // If such a forward IBR clause exists, subsequently filed 10-Ks and 10-Qs are
    // incorporated into the prospectus without a new 424B or POS AM.
    let regIBRInfo = null; // will hold LLM-extracted IBR data from the registration document
    if (selectedReg?.doc) {
      try {
        const regDocUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accession.replace(/-/g, "")}/${selectedReg.doc}`;
        const regDocRes = await fetch(regDocUrl, { headers: HEADERS });
        if (regDocRes.ok) {
          const regDocText = await regDocRes.text();
          // Extract the IBR section — it typically appears near the front of the document
          // Search for "INCORPORATION BY REFERENCE" heading and grab nearby text
          const ibr = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Analyze this SEC registration statement for its "Incorporation by Reference" (IBR) provisions. Extract the following:

1. HAS_IBR_SECTION: Does the document contain an "Incorporation by Reference" section? (true/false)
2. FORWARD_IBR: Does the document contain language that automatically incorporates ALL FUTURE Exchange Act filings (10-K, 10-Q, 8-K) filed after the registration date? This is sometimes called a "forward-looking" or "automatic" IBR clause. Look for phrases like "all documents filed pursuant to Section 13(a), 13(c), 14 or 15(d) of the Exchange Act after the date of this prospectus" or "any future filings made with the SEC under Sections 13(a), 13(c), 14 or 15(d) of the Exchange Act." (true/false)
3. SPECIFIC_ANNUAL_INCORPORATED: The fiscal year-end date (YYYY-MM-DD) of the most recently audited annual report (10-K or 20-F) specifically named and incorporated by reference in this document. E.g. "Annual Report on Form 10-K for the year ended December 31, 2024" → "2024-12-31". null if none.
4. SPECIFIC_ANNUAL_FORM: "10-K" or "20-F" or null.
5. SPECIFIC_INTERIM_INCORPORATED: The fiscal period-end date (YYYY-MM-DD) of the most recent 10-Q or 6-K specifically incorporated by reference. null if none.
6. IBR_SUMMARY: 1-2 sentence plain-English summary of what is incorporated by reference.

Return JSON only.
Document (first 15000 chars):\n${regDocText.slice(0, 15000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                has_ibr_section: { type: "boolean" },
                forward_ibr: { type: "boolean" },
                specific_annual_incorporated: { type: ["string", "null"] },
                specific_annual_form: { type: ["string", "null"] },
                specific_interim_incorporated: { type: ["string", "null"] },
                ibr_summary: { type: ["string", "null"] }
              }
            }
          });
          regIBRInfo = ibr;
          // If the reg doc itself incorporates a specific annual by reference, use that date
          if (ibr?.specific_annual_incorporated && /^\d{4}-\d{2}-\d{2}$/.test(ibr.specific_annual_incorporated)) {
            prospectusIncorporatedDate = prospectusIncorporatedDate || ibr.specific_annual_incorporated;
            prospectusIncorporatedForm = prospectusIncorporatedForm || ibr.specific_annual_form;
          }
          if (ibr?.specific_interim_incorporated && /^\d{4}-\d{2}-\d{2}$/.test(ibr.specific_interim_incorporated)) {
            prospectusInterimPeriodEndDate = prospectusInterimPeriodEndDate || ibr.specific_interim_incorporated;
          }
        }
      } catch (_) { /* non-critical */ }
    }

    // If forward IBR is present, subsequent Exchange Act filings are auto-incorporated
    // even in a non-shelf registration — treat it similarly to shelf IBR for gap analysis
    const hasForwardIBR = regIBRInfo?.forward_ibr === true;

    const belongsToThisReg = (f, resolvedProspectusRef = null) => {
      if (resolvedProspectusRef && f === resolvedProspectusRef) {
        return !prospectusRegNumber || !regFileNumber || prospectusRegNumber === regFileNumber;
      }
      if (!regFileNumber || !f.fileNumber) return true;
      return f.fileNumber === regFileNumber;
    };

    // Post-effective amendments (POS AM)
    const allPostEffectiveAmendments = subsequentFilings.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim()) && belongsToThisReg(f)
    );
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffective);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffective(f));
    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    // 424B prospectuses filed after reg
    const prospectuses = subsequentFilings.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && belongsToThisReg(f)
    );
    const latestProspectus = prospectuses[0] || null;

    // Parse the latest prospectus document to extract fiscal year-end / period-end dates
    // We measure staleness from FISCAL YEAR-END, not from the prospectus filing date
    if (latestProspectus?.doc) {
      try {
        const prospUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${latestProspectus.accession.replace(/-/g, "")}/${latestProspectus.doc}`;
        const prospRes = await fetch(prospUrl, { headers: HEADERS });
        if (prospRes.ok) {
          const prospText = await prospRes.text();
          const extracted = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `From this SEC prospectus supplement extract FOUR items:
1. REGISTRATION FILE NUMBER (format "333-XXXXXX") that this prospectus updates. Look for "Registration Statement No. 333-XXXXXX" or "File No. 333-XXXXXX".
2. ANNUAL FS FISCAL YEAR-END DATE: the balance-sheet date (end of fiscal year) of the most recent audited annual FS incorporated by reference. E.g. if "Annual Report on Form 10-K for the fiscal year ended December 31, 2024" → "2024-12-31". Do NOT use the 10-K filing date.
3. ANNUAL FS FORM: "10-K" or "20-F".
4. INTERIM FS PERIOD-END DATE: fiscal period-end of the most recent 10-Q or 6-K FS incorporated (e.g. "2024-09-30"). null if none.
Return ONLY JSON: {"registration_number":..., "annual_fs_fiscal_year_end":..., "annual_fs_form":..., "interim_fs_period_end":...}
Document (first 12000 chars):\n${prospText.slice(0, 12000)}`,
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
          if (extracted?.registration_number) prospectusRegNumber = extracted.registration_number;
          if (extracted?.annual_fs_fiscal_year_end && /^\d{4}-\d{2}-\d{2}$/.test(extracted.annual_fs_fiscal_year_end))
            prospectusIncorporatedDate = extracted.annual_fs_fiscal_year_end;
          if (extracted?.annual_fs_form) prospectusIncorporatedForm = extracted.annual_fs_form;
          if (extracted?.interim_fs_period_end && /^\d{4}-\d{2}-\d{2}$/.test(extracted.interim_fs_period_end))
            prospectusInterimPeriodEndDate = extracted.interim_fs_period_end;
        }
      } catch (_) { /* fall back to metadata */ }
    }

    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
    );
    const latestAnnual = annuals[0] || null;

    const quarterlies = subsequentFilings.filter(f => f.form === "10-Q" || f.form === "10-Q/A");
    const latestQuarterly = quarterlies[0] || null;

    const currentReports = subsequentFilings.filter(f => f.form?.startsWith("8-K"));
    const latestCurrent = currentReports[0] || null;

    const mostRecentEffectiveUpdate = latestPostEffective || latestProspectus || null;

    const checks = [];

    // ── CHECK A: Is the registration effective? ───────────────────────────────
    const effectiveness = isLikelyEffective(selectedReg);
    const effectiveDate = effectiveness.effective && effectiveness.effectDate
      ? new Date(effectiveness.effectDate) : regDate;
    const daysSinceEffective = Math.floor((new Date() - effectiveDate) / (1000 * 60 * 60 * 24));

    // ════════════════════════════════════════════════════════════════════════
    // STAGE 1 — NOT YET EFFECTIVE: Apply Rule 3-12
    // Test whether the financial statements currently in the registration are
    // fresh enough to support effectiveness, using the correct thresholds based
    // on the issuer's reporting history and filer status.
    // ════════════════════════════════════════════════════════════════════════
    if (!effectiveness.effective) {
      checks.push({
        id: "effectiveness",
        label: "Registration Statement — Not Yet Effective (Rule 3-12 Analysis)",
        status: "warn",
        detail: `Registration not yet effective. ${effectiveness.reason}. Applying Rule 3-12 pre-effectiveness financial-statement currency analysis below.`,
        filingDate: null, filingUrl: null, filingForm: null,
      });

      // Rule 3-12 pre-effectiveness thresholds
      // Determine applicable threshold based on reporting history and filer status
      let rule312Days, rule312Basis;
      if (isFPI) {
        // FPIs: carve-out — different rules apply (Item 8 Form 20-F; typically 15-month annual, 9-month interim)
        rule312Days = null;
        rule312Basis = "FPI carve-out";
      } else if (!isExchangeActReporterBeforeFiling) {
        // Not subject to Exchange Act reporting immediately before filing: 1 year + 45 days
        rule312Days = RULE_312_DAYS_NON_REPORTING;
        rule312Basis = "not subject to Exchange Act reporting immediately before filing (1 year + 45 days)";
      } else {
        // Exchange Act reporter: large accelerated/accelerated = 130 days; all others = 135 days
        // We cannot determine exact filer status without reading the 10-K cover page;
        // use 135 days as the conservative default (applies to non-accelerated and SRC)
        rule312Days = RULE_312_DAYS_OTHERS;
        rule312Basis = "Exchange Act reporter — applying 135-day threshold (non-accelerated/SRC; use 130 days if large accelerated or accelerated filer)";
      }

      // Find the most recent fiscal year-end covered by audited FS in the registration
      // Proxy: the last 10-K/20-F filed BEFORE the registration date
      const priorAnnuals = filings.filter(f =>
        (f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A") &&
        new Date(f.date) < regDate
      );
      const latestPriorAnnual = priorAnnuals[0] || null;

      // Most recent prior 10-Q for interim assessment
      const priorQuarterlies = filings.filter(f =>
        (f.form === "10-Q" || f.form === "10-Q/A") && new Date(f.date) < regDate
      );
      const latestPriorQuarterly = priorQuarterlies[0] || null;

      if (isFPI) {
        checks.push({
          id: "rule312_preeffective",
          label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
          status: "info",
          detail: `FPI carve-out: Foreign Private Issuers are not subject to Rule 3-12. Applicable rules are Item 8 of Form 20-F (15-month annual FS limit; 9-month interim limit). Manual review of the registration statement's financial statements is required to confirm currency under the FPI framework.`,
          filingDate: latestPriorAnnual?.date || null, filingUrl: edgarUrl(latestPriorAnnual), filingForm: latestPriorAnnual?.form || null,
        });
      } else if (!latestPriorAnnual) {
        checks.push({
          id: "rule312_preeffective",
          label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
          status: "info",
          detail: `No prior ${annualFormLabel} found on EDGAR before the registration date (${selectedReg.date}). Cannot automatically assess Rule 3-12 financial statement age — review the financial statements in the registration document directly.`,
          filingDate: null, filingUrl: null, filingForm: null,
        });
      } else {
        // The registration's audited FS cover the fiscal year ended around the prior annual's period.
        // Rule 3-12 requires that those FS not be stale as of the anticipated effectiveness date.
        // We use TODAY as the proxy for the anticipated effective date (conservative).
        // Stale = more than rule312Days since the fiscal year-end date (we use the filing date as a proxy
        // since we cannot read the actual period-end from EDGAR metadata alone).
        const priorAnnualAge = daysSince(latestPriorAnnual.date);

        // Grace window check: audited year-end FS must be included if available before effectiveness
        // (i.e., if a new fiscal year ended and audited FS are available, they must be included)
        const latestPriorAnnualDate = new Date(latestPriorAnnual.date);
        const isAuditedFSAvailableBeforeEffectiveness =
          // If the most recent 10-K was filed after the registration date, a new annual is available
          annuals.length > 0;

        let r312Status, r312Detail;

        if (priorAnnualAge > rule312Days) {
          r312Status = "fail";
          r312Detail = `Rule 3-12 (pre-effectiveness): The most recent ${annualFormLabel} (${latestPriorAnnual.date}) is ${priorAnnualAge} days old. The applicable threshold is ${rule312Days} days (${rule312Basis}). The financial statements in this registration statement may be too stale to support effectiveness — a Rule 3-12 update (amendment with refreshed FS) is required before the SEC can declare the registration effective.`;
        } else {
          r312Status = "pass";
          r312Detail = `Rule 3-12 (pre-effectiveness): The most recent ${annualFormLabel} (${latestPriorAnnual.date}) is ${priorAnnualAge} days old — within the ${rule312Days}-day threshold (${rule312Basis}). Financial statements appear current for pre-effectiveness purposes as of today.`;
        }

        // If a newer annual report is available (filed after the reg was submitted), flag it
        if (isAuditedFSAvailableBeforeEffectiveness && r312Status === "pass") {
          r312Status = "warn";
          r312Detail += ` However, a newer ${annuals[0].form} (${annuals[0].date}) was filed after this registration was submitted — Rule 3-12 requires that if audited year-end FS are available before effectiveness, they must be included. An amendment incorporating the newer ${annuals[0].form} may be required before the SEC declares the registration effective.`;
        } else if (isAuditedFSAvailableBeforeEffectiveness) {
          r312Detail += ` A newer ${annuals[0].form} (${annuals[0].date}) is also available and must be included before effectiveness.`;
        }

        checks.push({
          id: "rule312_preeffective",
          label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
          status: r312Status,
          detail: r312Detail,
          filingDate: latestPriorAnnual.date, filingUrl: edgarUrl(latestPriorAnnual), filingForm: latestPriorAnnual.form,
        });

        // Interim assessment under Rule 3-12
        if (latestPriorQuarterly) {
          const priorQAge = daysSince(latestPriorQuarterly.date);
          const interimThreshold = 134; // Rule 3-12: interim FS must not be more than ~4.5 months (135 days) old
          const interimStatus = priorQAge > interimThreshold ? "warn" : "pass";
          checks.push({
            id: "rule312_interim_preeffective",
            label: "Rule 3-12 Pre-Effectiveness — Interim Financial Statement Currency",
            status: interimStatus,
            detail: interimStatus === "warn"
              ? `Most recent ${latestPriorQuarterly.form} (${latestPriorQuarterly.date}) is ${priorQAge} days old — may be too stale to include as the most current interim period before effectiveness. Review whether a more recent interim period should be reflected in the registration.`
              : `Most recent ${latestPriorQuarterly.form} (${latestPriorQuarterly.date}) is ${priorQAge} days old — appears current for pre-effectiveness interim financial statement purposes.`,
            filingDate: latestPriorQuarterly.date, filingUrl: edgarUrl(latestPriorQuarterly), filingForm: latestPriorQuarterly.form,
          });
        }
      }

      const overallStatus =
        checks.some(c => c.status === "fail") ? "fail" :
        checks.some(c => c.status === "warn") ? "warn" : "pass";

      const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `Securities law compliance expert. This registration statement is NOT YET EFFECTIVE. Apply Rule 3-12 pre-effectiveness analysis only.

Rule 3-12 framework: If issuer WAS subject to Exchange Act reporting immediately before filing: 130-day threshold (large accelerated/accelerated filers) or 135-day threshold (all others) from fiscal year-end. If NOT subject to Exchange Act reporting before filing: 410-day threshold (1 year + 45 days). FPIs: carve-out (use Item 8 Form 20-F). Also: if audited year-end FS became available before effectiveness, they MUST be included in an amendment.

Company: ${companyName} (${ticker.toUpperCase()}) | Form: ${selectedReg.form} filed ${selectedReg.date} | Exchange Act reporter before filing: ${isExchangeActReporterBeforeFiling ? "Yes" : "No"} | FPI: ${isFPI ? "Yes" : "No"}

Checks:
${checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n")}

Overall: ${overallStatus.toUpperCase()}
Summarize in 2-3 sentences: what is the Rule 3-12 issue (if any) and what must happen before this registration can be declared effective?`,
        response_json_schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] },
            summary: { type: "string" }, key_issue: { type: "string" }, required_action: { type: "string" }
          }
        }
      });

      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg,
          annualLimitMonths: 16, interimLimitMonths: Math.round(RULE_312_DAYS_OTHERS / 30),
          securitiesRegistered: securitiesRegistered || null },
        overallStatus,
        stage: "pre_effective",
        applicableRule: "Rule 3-12",
        aiSummary: aiSummary || null,
        checks,
        checkedAt: new Date().toISOString(),
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // STAGE 2 — ALREADY EFFECTIVE: Apply Section 10(a)(3) and Item 512
    // Test whether the prospectus can CURRENTLY BE USED for offers, i.e. whether
    // it is "current" within the meaning of Securities Act Section 10(a)(3).
    // Rule 3-12 does NOT apply here — it is a pre-effectiveness rule only.
    //
    // The Section 10(a)(3) tests are:
    //   (a) Is today more than 9 months after the effective date? If yes, the
    //       prospectus cannot be used unless it has been updated.
    //   (b) Is the information in the prospectus more than 16 months old (i.e.
    //       is the fiscal year-end of the audited FS more than 16 months ago)?
    //   (c) Has a fundamental change occurred, or has there been a material
    //       change in the plan of distribution, requiring an update?
    //   (d) For shelf (S-3/F-3): later 10-K/10-Q filings automatically refresh
    //       the prospectus through incorporation by reference (Item 512(a)).
    //   For non-shelf (S-1/F-1): a 424B supplement or effective POS AM is
    //       required to incorporate later FS — IBR is NOT automatic.
    // ════════════════════════════════════════════════════════════════════════

    checks.push({
      id: "effectiveness",
      label: "Registration Statement Declared Effective",
      status: "pass",
      detail: `Registration effective per ${effectiveness.reason}. Applying Section 10(a)(3) / Item 512 post-effectiveness currency analysis.`,
      filingDate: effectiveness.effectDate || null, filingUrl: null, filingForm: null,
    });

    // ── Transaction registrations (S-4/F-4 mergers) — short-circuit ──────────
    // S-4 and F-4 registrations cover one-time business combination transactions.
    // Once the merger/transaction is complete, the prospectus is no longer used for
    // ongoing offers and Section 10(a)(3) ongoing currency obligations do not apply.
    // The registration does not need to be "kept current" like a continuous offering.
    if (isTransactionReg) {
      checks.push({
        id: "transaction_reg_note",
        label: "Transaction Registration (S-4/F-4) — Currency Analysis Not Applicable",
        status: "info",
        detail: `This is an S-4/F-4 transaction registration used for a business combination (merger/acquisition). Once the transaction is consummated, the registration is not used for ongoing offers and Section 10(a)(3) prospectus currency obligations do not apply. No ongoing update requirement exists for a completed transaction registration. If warrants were registered and are being exercised on an ongoing basis, a separate analysis under the warrant exercise prospectus would apply.`,
        filingDate: null, filingUrl: edgarUrl(selectedReg), filingForm: selectedReg.form,
      });
      const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `Securities law expert. This is an S-4/F-4 transaction registration for a business combination by ${companyName} (${ticker.toUpperCase()}), filed ${selectedReg.date}, effective ${effectiveness.effectDate}. The transaction has been completed. The verdict MUST be "CURRENT" because completed transaction registrations are not subject to Section 10(a)(3) ongoing prospectus currency obligations. Briefly explain in 1-2 sentences why Section 10(a)(3) does not apply and what, if anything, the company should monitor going forward (e.g. warrant exercise prospectus if warrants are outstanding).`,
        response_json_schema: { type: "object", properties: { verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] }, summary: { type: "string" }, key_issue: { type: "string" }, required_action: { type: "string" } } }
      });
      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg, isTransactionReg: true,
          annualLimitMonths: null, interimLimitMonths: null,
          securitiesRegistered: securitiesRegistered || null },
        overallStatus: "pass", stage: "post_effective", applicableRule: "N/A — Completed Transaction Registration",
        aiSummary: aiSummary || null, checks, checkedAt: new Date().toISOString(),
      });
    }

    // ── CHECK: IBR status of the registration document ──────────────────────
    // Surface whether the registration statement itself contains IBR language,
    // including any forward/automatic IBR clause that auto-incorporates future filings.
    if (regIBRInfo !== null) {
      let ibrStatus, ibrDetail;
      if (!regIBRInfo.has_ibr_section) {
        ibrStatus = "warn";
        ibrDetail = `No Incorporation by Reference section detected in the registration statement. All financial statement updates must be made via 424B supplement or effective POS AM — no automatic IBR refresh available.`;
      } else if (regIBRInfo.forward_ibr) {
        ibrStatus = "pass";
        ibrDetail = `Forward/automatic IBR clause detected: subsequent Exchange Act filings (10-K, 10-Q, 8-K) filed after the registration date are automatically incorporated by reference. ${regIBRInfo.ibr_summary || ""}`;
        if (regIBRInfo.specific_annual_incorporated) {
          ibrDetail += ` Specifically named: annual FS with fiscal year-end ${regIBRInfo.specific_annual_incorporated}${regIBRInfo.specific_interim_incorporated ? `; interim FS through ${regIBRInfo.specific_interim_incorporated}` : ""}.`;
        }
      } else {
        ibrStatus = "info";
        ibrDetail = `IBR section present but NO forward/automatic IBR clause — only specific named documents are incorporated. Future Exchange Act filings are NOT automatically incorporated. ${regIBRInfo.ibr_summary || ""}`;
        if (regIBRInfo.specific_annual_incorporated) {
          ibrDetail += ` Specifically named: annual FS with fiscal year-end ${regIBRInfo.specific_annual_incorporated}${regIBRInfo.specific_interim_incorporated ? `; interim FS through ${regIBRInfo.specific_interim_incorporated}` : ""}.`;
        }
      }
      checks.push({
        id: "ibr_status",
        label: "Incorporation by Reference (IBR) — Registration Statement Language",
        status: ibrStatus,
        detail: ibrDetail,
        filingDate: null, filingUrl: edgarUrl(selectedReg), filingForm: selectedReg.form,
      });
    }

    // ── CHECK B: Section 10(a)(3)(ii) — 16-month hard cap on audited FS age ─
    // Measured from the FISCAL YEAR-END DATE of the audited FS in the live prospectus.
    // For shelf: IBR auto-incorporates the latest annual. Use prospectus-extracted date first,
    //   then fall back to EDGAR filing date of latest annual (conservative proxy).
    // For non-shelf: Use prospectus-extracted fiscal year-end first, then update document date.

    let fsStatus, fsDetail, fsFailCode;

    if (isShelf) {
      const annualFiscalYearEnd = prospectusIncorporatedDate || latestAnnual?.date || null;
      if (!annualFiscalYearEnd) {
        fsStatus = "fail";
        fsFailCode = "no_annual_report_incorporated";
        fsDetail = `No ${annualFormLabel} filed after shelf registration — no financials incorporated via IBR. Section 10(a)(3) requires the prospectus to be kept current. NOT CURRENT.`;
      } else {
        const annualAge = daysSince(annualFiscalYearEnd);
        if (annualAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = "section_10a3_audited_fs_older_than_16_months";
          fsDetail = `Section 10(a)(3)(ii): ${annualFormLabel} fiscal year-end (${annualFiscalYearEnd}) is ${annualAge} days old — exceeds the ${Math.round(ANNUAL_LIMIT/30)}-month information-age limit. The prospectus information is too old. NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          const src = prospectusIncorporatedDate
            ? `fiscal year-end from prospectus supplement ${latestProspectus?.form} ${latestProspectus?.date}`
            : `${annualFormLabel} filing date ${annualFiscalYearEnd} used as proxy (actual year-end is earlier)`;
          fsDetail = `Section 10(a)(3)(ii): ${annualFormLabel} fiscal year-end ${annualFiscalYearEnd} is ${annualAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month limit (${src}). IBR auto-incorporates via shelf registration.`;
        }
      }
    } else {
      // Non-shelf: fiscal year-end from LLM extraction, or update document date as proxy.
      // If forward IBR is present, the latest annual report IS auto-incorporated even without a 424B/POS AM.
      const annualFiscalYearEnd = prospectusIncorporatedDate ||
        (hasForwardIBR && latestAnnual?.date) ||
        latestPostEffective?.date || latestProspectus?.date || null;

      if (!annualFiscalYearEnd) {
        const regAge = daysSince(selectedReg.date);
        if (regAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = "section_10a3_audited_fs_older_than_16_months";
          fsDetail = `Section 10(a)(3)(ii): No 424B supplement or effective POS AM found. Original registration FS from ${selectedReg.date} are ${regAge} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit. NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          fsDetail = `Section 10(a)(3)(ii): No 424B or POS AM found. Original registration FS from ${selectedReg.date} are ${regAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month cap. See 9-month usability check below.`;
        }
      } else {
        const annualAge = daysSince(annualFiscalYearEnd);
        if (annualAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = "section_10a3_audited_fs_older_than_16_months";
          const src = prospectusIncorporatedDate ? `(fiscal year-end from prospectus document)` : `(document date used as proxy — actual fiscal year-end is earlier)`;
          fsDetail = `Section 10(a)(3)(ii): Audited FS fiscal year-end ${annualFiscalYearEnd} ${src} is ${annualAge} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit. NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          const src = prospectusIncorporatedDate
            ? `Fiscal year-end from ${latestProspectus?.form || "prospectus"} ${latestProspectus?.date}.`
            : (hasForwardIBR && latestAnnual?.date)
              ? `${latestAnnual.form} (${latestAnnual.date}) auto-incorporated via forward IBR clause.`
              : `${latestPostEffective?.form || latestProspectus?.form || "update"} date used as conservative proxy.`;
          fsDetail = `Section 10(a)(3)(ii): Audited FS fiscal year-end ${annualFiscalYearEnd} is ${annualAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month limit. ${src}`;
        }
      }
    }

    if (fsStatus === "fail") {
      checks.push({
        id: "section10a3_annual_fs",
        label: `Section 10(a)(3)(ii) — Audited FS Age (${Math.round(ANNUAL_LIMIT/30)}-month cap from fiscal year-end)`,
        status: "fail", failCode: fsFailCode, detail: fsDetail,
        filingDate: null, filingUrl: null, filingForm: null,
      });
      const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `Securities law compliance expert. This registration is effective. Section 10(a)(3) post-effectiveness currency test. The ${Math.round(ANNUAL_LIMIT/30)}-month audited FS age hard cap has been exceeded. Company: ${companyName} (${ticker.toUpperCase()}), Form: ${selectedReg.form}. Checks: ${checks.map(c=>`[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n")}. State in 2 sentences why it is NOT CURRENT and what update is required.`,
        response_json_schema: { type: "object", properties: { verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] }, summary: { type: "string" }, key_issue: { type: "string" }, required_action: { type: "string" } } }
      });
      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg,
          annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: 9,
          securitiesRegistered: securitiesRegistered || null },
        overallStatus: "fail", stage: "post_effective", applicableRule: "Section 10(a)(3) / Item 512",
        aiSummary: aiSummary || null, checks, checkedAt: new Date().toISOString(),
      });
    }

    checks.push({
      id: "section10a3_annual_fs",
      label: isFForm
        ? `Section 10(a)(3)(ii) — Audited FS Age (${Math.round(ANNUAL_LIMIT/30)}-month cap, F-form)`
        : `Section 10(a)(3)(ii) — Audited FS Age (${Math.round(ANNUAL_LIMIT/30)}-month cap from fiscal year-end)`,
      status: fsStatus, failCode: null, detail: fsDetail,
      filingDate: latestPostEffective?.date || latestProspectus?.date || null,
      filingUrl: edgarUrl(latestPostEffective || latestProspectus),
      filingForm: latestPostEffective?.form || latestProspectus?.form || null,
    });

    // ── CHECK C: Section 10(a)(3)(i) — 9-month usability clock (non-shelf) ──
    // After 9 months from the effective date, the prospectus CANNOT be used for
    // offers unless it has been updated AND the update reflects FS at least as
    // current as the most recently filed annual/quarterly report.
    // For shelf OR forward-IBR non-shelf: IBR refreshes automatically.
    // For non-shelf without forward IBR: requires 424B supplement or effective POS AM.
    if (!isShelf) {
      if (daysSinceEffective > SECTION_10A3_9_MONTHS) {
        if (hasForwardIBR) {
          // Forward IBR means all subsequent Exchange Act filings are auto-incorporated —
          // no 424B or POS AM needed to satisfy Section 10(a)(3)(i).
          // The 16-month annual FS age cap still applies.
          const latestIncorporated = latestAnnual || latestQuarterly;
          checks.push({
            id: "section10a3_nine_month",
            label: "Section 10(a)(3)(i) — 9-Month Usability (Forward IBR)",
            status: "pass",
            detail: `Section 10(a)(3)(i): Registration effective ${daysSinceEffective} days ago (past 9-month mark). Forward/automatic IBR clause in registration statement auto-incorporates all subsequent Exchange Act filings — no 424B supplement or POS AM required. ${latestIncorporated ? `Most recent auto-incorporated: ${latestIncorporated.form} (${latestIncorporated.date}).` : ""}`,
            filingDate: latestIncorporated?.date || null, filingUrl: edgarUrl(latestIncorporated), filingForm: latestIncorporated?.form || null,
          });
        } else if (!mostRecentEffectiveUpdate) {
          checks.push({
            id: "section10a3_nine_month",
            label: "Section 10(a)(3)(i) — 9-Month Usability Limit",
            status: "fail",
            failCode: "prospectus_unusable_past_nine_months_no_update",
            detail: `Section 10(a)(3)(i): Registration effective ${daysSinceEffective} days ago (${Math.round(daysSinceEffective/30)} months) — past the 9-month limit. No 424B supplement, effective POS AM, or forward IBR clause found. The prospectus CANNOT be used for offers. To restore usability: file a 424B supplement or effective POS AM with current financial statements. NOT CURRENT.`,
            filingDate: null, filingUrl: null, filingForm: null,
          });
        } else {
          // Update exists — but does it catch up to all later EDGAR filings?
          const updateDate = new Date(mostRecentEffectiveUpdate.date);
          const newerAnnual = latestAnnual && new Date(latestAnnual.date) > updateDate ? latestAnnual : null;
          const newerQuarterly = latestQuarterly && new Date(latestQuarterly.date) > updateDate ? latestQuarterly : null;

          if (newerAnnual) {
            checks.push({
              id: "section10a3_nine_month",
              label: "Section 10(a)(3)(i) — 9-Month Usability: Annual FS Gap",
              status: "fail",
              failCode: "section10a3_later_annual_not_incorporated",
              detail: `Section 10(a)(3)(i): Prospectus last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}. A newer ${newerAnnual.form} (${newerAnnual.date}) was subsequently filed and is NOT incorporated in the live prospectus. Item 512 requires the prospectus to reflect FS at least as current as the latest filed annual report. File a 424B supplement or effective POS AM incorporating the ${newerAnnual.form}. NOT CURRENT.`,
              filingDate: newerAnnual.date, filingUrl: edgarUrl(newerAnnual), filingForm: newerAnnual.form,
            });
          } else if (newerQuarterly) {
            checks.push({
              id: "section10a3_nine_month",
              label: "Section 10(a)(3)(i) — 9-Month Usability: Interim FS Gap",
              status: "fail",
              failCode: "section10a3_later_quarterly_not_incorporated",
              detail: `Section 10(a)(3)(i): Prospectus last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}. A newer ${newerQuarterly.form} (${newerQuarterly.date}) was subsequently filed and is NOT incorporated in the live prospectus. Section 10(a)(3) requires the prospectus to include FS at least as current as the most recently filed 10-Q. File a 424B supplement or effective POS AM incorporating the ${newerQuarterly.form}. NOT CURRENT.`,
              filingDate: newerQuarterly.date, filingUrl: edgarUrl(newerQuarterly), filingForm: newerQuarterly.form,
            });
          } else {
            checks.push({
              id: "section10a3_nine_month",
              label: "Section 10(a)(3)(i) — 9-Month Usability Limit",
              status: "pass",
              detail: `Section 10(a)(3)(i): Prospectus effective ${daysSinceEffective} days ago (past 9-month mark). Validly updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}${prospectusIncorporatedDate ? `, incorporating FS with fiscal year-end ${prospectusIncorporatedDate}` : ""}. No later 10-K or 10-Q on EDGAR postdates that update. Section 10(a)(3)(i) satisfied.`,
              filingDate: mostRecentEffectiveUpdate.date, filingUrl: edgarUrl(mostRecentEffectiveUpdate), filingForm: mostRecentEffectiveUpdate.form,
            });
          }
        }
      } else {
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3)(i) — 9-Month Usability Limit",
          status: "pass",
          detail: `Section 10(a)(3)(i): Registration effective ${daysSinceEffective} days ago — still within the 9-month usability window (${SECTION_10A3_9_MONTHS} days). No update required yet.${hasForwardIBR ? " Forward IBR clause present — subsequent Exchange Act filings auto-incorporated." : ""}`,
          filingDate: null, filingUrl: null, filingForm: null,
        });
      }
    } else {
      // Shelf: IBR via Item 512(a) — later annual reports automatically refresh the prospectus
      // Still check whether the latest annual/quarterly has actually been filed
      const newerAnnualForShelf = latestAnnual;
      const newerQuarterlyForShelf = latestQuarterly;
      let shelfIBRStatus = "pass";
      let shelfIBRDetail;
      if (!newerAnnualForShelf) {
        shelfIBRStatus = "warn";
        shelfIBRDetail = `Item 512(a) IBR: No ${annualFormLabel} filed after shelf registration. The shelf prospectus is only refreshed by IBR when a new annual report is filed. If no ${annualFormLabel} has been filed since the shelf was registered, there may be no current IBR refresh.`;
      } else {
        shelfIBRDetail = `Item 512(a) IBR: ${annualFormLabel} (${newerAnnualForShelf.date}) automatically incorporated by reference, refreshing the shelf prospectus. ${newerQuarterlyForShelf ? `Most recent ${newerQuarterlyForShelf.form} (${newerQuarterlyForShelf.date}) also auto-incorporated.` : ""} Section 10(a)(3) shelf IBR satisfied.`;
      }
      checks.push({
        id: "section10a3_ibr_shelf",
        label: "Section 10(a)(3) / Item 512(a) — Shelf IBR Refresh",
        status: shelfIBRStatus, detail: shelfIBRDetail,
        filingDate: newerAnnualForShelf?.date || null, filingUrl: edgarUrl(newerAnnualForShelf), filingForm: newerAnnualForShelf?.form || null,
      });
    }

    // ── CHECK D: Quarterly / interim reporting gap ────────────────────────────
    // This checks Exchange Act reporting currency (are 10-Qs being filed on time?)
    // and, for non-shelf, whether unincorporated 10-Qs create a prospectus gap.
    let quarterlyStatus, quarterlyDetail;
    const annualDateForQ = latestAnnual ? new Date(latestAnnual.date) : null;
    const annualDaysForQ = latestAnnual ? daysSince(latestAnnual.date) : null;

    if (isFPI) {
      const sixKs = subsequentFilings.filter(f => f.form === "6-K" || f.form === "6-K/A");
      const latestSixK = sixKs[0] || null;
      const liveProspectusBaselineDate = !isShelf && mostRecentEffectiveUpdate ? new Date(mostRecentEffectiveUpdate.date) : effectiveDate;
      const unincorporated6Ks = !isShelf ? sixKs.filter(f => new Date(f.date) > liveProspectusBaselineDate) : [];
      if (!latestSixK) {
        quarterlyStatus = "info";
        quarterlyDetail = `FPI — no 10-Q obligation. No 6-K filings found since this registration.`;
      } else {
        const sixKDays = daysSince(latestSixK.date);
        if (!isShelf && unincorporated6Ks.length > 0) {
          quarterlyStatus = "warn";
          quarterlyDetail = `FPI INTERIM GAP: ${unincorporated6Ks.length} 6-K(s) filed after last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT incorporated in the live prospectus. 6-Ks do not auto-update a non-shelf prospectus — incorporate via 424B3 or effective POS AM.`;
        } else {
          quarterlyStatus = "pass";
          quarterlyDetail = `FPI — ${sixKs.length} 6-K(s) since registration. Most recent: ${latestSixK.date} (${sixKDays} days ago).`;
        }
      }
      checks.push({ id: "quarterly_reports", label: "Interim Reports (6-K) — FPI", status: quarterlyStatus, detail: quarterlyDetail,
        filingDate: latestSixK?.date || null, filingUrl: edgarUrl(latestSixK), filingForm: latestSixK?.form || null, count: sixKs.length });
    } else {
      const quartersFiledSinceAnnual = annualDateForQ ? quarterlies.filter(f => new Date(f.date) > annualDateForQ).length : 0;
      let expectedQ = 0;
      if (annualDaysForQ !== null) {
        if (annualDaysForQ > 270) expectedQ = 3;
        else if (annualDaysForQ > 180) expectedQ = 2;
        else if (annualDaysForQ > 90) expectedQ = 1;
      }
      // If forward IBR is present, all subsequent filings are auto-incorporated — no gap possible
      const liveProspectusBaselineDate = !isShelf && mostRecentEffectiveUpdate ? new Date(mostRecentEffectiveUpdate.date) : effectiveDate;
      const unincorporatedQuarterlies = (!isShelf && !hasForwardIBR) ? quarterlies.filter(f => new Date(f.date) > liveProspectusBaselineDate) : [];

      if (!annualDateForQ) {
        if (quarterlies.length > 0 && hasForwardIBR) {
          quarterlyStatus = "pass";
          quarterlyDetail = `${quarterlies.length} 10-Q(s) on EDGAR. Forward IBR clause auto-incorporates all subsequent Exchange Act filings — no manual prospectus update required. Most recent: ${quarterlies[0].form} ${quarterlies[0].date}.`;
        } else if (quarterlies.length > 0 && unincorporatedQuarterlies.length > 0 && daysSinceEffective > SECTION_10A3_9_MONTHS) {
          quarterlyStatus = "warn";
          quarterlyDetail = `INCORPORATION GAP: ${unincorporatedQuarterlies.length} 10-Q(s) filed after last prospectus update are NOT incorporated in the live prospectus. No forward IBR clause found — a 10-Q does not auto-update a non-shelf prospectus. Incorporate via 424B3 or effective POS AM.`;
        } else if (quarterlies.length > 0 && unincorporatedQuarterlies.length > 0) {
          quarterlyStatus = "pass";
          quarterlyDetail = `${quarterlies.length} 10-Q(s) filed on EDGAR (most recent: ${quarterlies[0].form} ${quarterlies[0].date}). ${unincorporatedQuarterlies.length} not yet incorporated, but within the 9-month window (effective ${daysSinceEffective} days ago) — no update required yet.`;
        } else if (quarterlies.length > 0) {
          quarterlyStatus = "pass";
          quarterlyDetail = `${quarterlies.length} 10-Q(s) filed and incorporated. No post-registration 10-K found.`;
        } else {
          quarterlyStatus = "info";
          quarterlyDetail = "No 10-K or 10-Q filed after this registration — cannot assess quarterly currency.";
        }
      } else if (expectedQ === 0) {
        quarterlyStatus = "pass";
        quarterlyDetail = `10-K filed ${annualDaysForQ} days ago — no quarterly report yet due.`;
      } else if (quartersFiledSinceAnnual < expectedQ) {
        quarterlyStatus = "fail";
        quarterlyDetail = `EDGAR FILING GAP: Only ${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K (${latestAnnual.date}). ${expectedQ - quartersFiledSinceAnnual} report(s) missing — company may be delinquent.`;
      } else if (!isShelf && !hasForwardIBR && unincorporatedQuarterlies.length > 0 && daysSinceEffective > SECTION_10A3_9_MONTHS) {
        // Only flag incorporation gap as a problem AFTER the 9-month mark AND only if no forward IBR.
        quarterlyStatus = "warn";
        quarterlyDetail = `INCORPORATION GAP: ${quartersFiledSinceAnnual}/${expectedQ} 10-Qs current on EDGAR, but ${unincorporatedQuarterlies.length} filed after last prospectus update (${mostRecentEffectiveUpdate?.date || effectiveDate.toISOString().split("T")[0]}) are NOT in the live prospectus. No forward IBR clause found — incorporate via 424B3 or effective POS AM. Most recent unincorporated: ${unincorporatedQuarterlies[0].form} ${unincorporatedQuarterlies[0].date}.`;
      } else if (!isShelf && !hasForwardIBR && unincorporatedQuarterlies.length > 0) {
        // Within 9 months — note the gap informally but not a current violation
        quarterlyStatus = "pass";
        quarterlyDetail = `${quartersFiledSinceAnnual}/${expectedQ} expected 10-Q(s) filed on EDGAR. ${unincorporatedQuarterlies.length} not yet incorporated, but within the 9-month window (effective ${daysSinceEffective} days ago) and no forward IBR issue yet — no action required yet.`;
      } else {
        quarterlyStatus = "pass";
        quarterlyDetail = `${quartersFiledSinceAnnual}/${expectedQ} expected 10-Q(s) filed and incorporated. (No Q4 10-Q required — covered by 10-K.)`;
      }
      checks.push({ id: "quarterly_reports", label: "Quarterly Reports (10-Q) — Exchange Act Currency & Prospectus Incorporation",
        status: quarterlyStatus, detail: quarterlyDetail,
        filingDate: latestQuarterly?.date || null, filingUrl: edgarUrl(latestQuarterly), filingForm: latestQuarterly?.form || null, count: quarterlies.length });
    }

    // ── CHECK E: Current Reports (8-K) ───────────────────────────────────────
    if (!isFPI) {
      const cDays = latestCurrent ? daysSince(latestCurrent.date) : null;
      const currentStatus = !latestCurrent ? "warn" : cDays <= 365 ? "pass" : "warn";
      const currentDetail = !latestCurrent
        ? "No 8-K current reports filed since registration. Verify whether any material events required disclosure."
        : `Most recent 8-K: ${latestCurrent.date} (${cDays} days ago). ${currentReports.length} total 8-K(s) since registration.`;
      checks.push({ id: "current_reports", label: "Current Reports (8-K) Filed Since Registration",
        status: currentStatus, detail: currentDetail,
        filingDate: latestCurrent?.date || null, filingUrl: edgarUrl(latestCurrent), filingForm: latestCurrent?.form || null, count: currentReports.length });
    }

    // ── CHECK F: Post-Effective Amendments (POS AM) ──────────────────────────
    if (!isShelf) {
      let amendStatus, amendDetail;
      if (allPostEffectiveAmendments.length === 0) {
        amendStatus = "info";
        amendDetail = "No POS AM filings found for this registration statement.";
      } else if (effectivePostEffectiveAmendments.length === 0) {
        amendStatus = "fail";
        amendDetail = `${allPostEffectiveAmendments.length} POS AM(s) filed but NONE declared effective (no EFFECT notice within 60 days). A filed POS AM does NOT satisfy Section 10(a)(3) until the SEC issues an effectiveness order. Most recent (not effective): ${latestPendingPosAm.form} on ${latestPendingPosAm.date}.`;
      } else {
        const aDays = daysSince(latestPostEffective.date);
        const pendingNote = latestPendingPosAm ? ` ${pendingPostEffectiveAmendments.length} additional POS AM(s) filed but not yet effective.` : "";
        amendStatus = "pass";
        amendDetail = `${effectivePostEffectiveAmendments.length} effective POS AM(s). Most recent: ${latestPostEffective.form} ${latestPostEffective.date} (${aDays} days ago).${pendingNote}`;
      }
      checks.push({ id: "amendments", label: "Post-Effective Amendments (POS AM) — Section 10(a)(3) Update Mechanism",
        status: amendStatus, detail: amendDetail,
        filingDate: latestPostEffective?.date || latestPendingPosAm?.date || null,
        filingUrl: edgarUrl(latestPostEffective || latestPendingPosAm),
        filingForm: latestPostEffective?.form || latestPendingPosAm?.form || null,
        count: allPostEffectiveAmendments.length, effectiveCount: effectivePostEffectiveAmendments.length });
    }

    const overallStatus =
      checks.some(c => c.status === "fail") ? "fail" :
      checks.some(c => c.status === "warn") ? "warn" : "pass";

    const checkSummary = checks.map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`).join("\n");

    const frameworkNote = isShelf
      ? `Shelf (${selectedReg.form}) — Section 10(a)(3) / Item 512(a). Later 10-K/10-Q filings automatically refresh via IBR. Hard cap: ${Math.round(ANNUAL_LIMIT/30)} months from fiscal year-end of audited FS.`
      : hasForwardIBR
        ? `Non-shelf (${selectedReg.form}) WITH FORWARD IBR CLAUSE — Section 10(a)(3) / Item 512. The registration statement contains a forward/automatic IBR clause that incorporates all subsequent Exchange Act filings. Hard cap: ${Math.round(ANNUAL_LIMIT/30)} months from fiscal year-end of audited FS. IBR auto-refresh applies to all 10-K/10-Q/8-K filed after the effective date.`
        : isFForm
          ? `F-form (${selectedReg.form}) — Section 10(a)(3). Annual FS cap: ${Math.round(ANNUAL_LIMIT/30)} months from fiscal year-end. 9-month usability limit from effective date. IBR NOT automatic on F-1/F-4 without a forward IBR clause.`
          : `Domestic non-shelf (${selectedReg.form}) — Section 10(a)(3) / Item 512. Two tests: (a) 16-month hard cap on audited FS fiscal year-end; (b) 9-month usability limit — after 9 months, prospectus unusable unless updated AND updated FS are as current as latest filed 10-K/10-Q. No forward IBR clause detected — a bare 10-Q filing does NOT update the prospectus; requires 424B supplement or effective POS AM.`;

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `Securities law compliance expert. This registration is ALREADY EFFECTIVE. Apply Section 10(a)(3) and Item 512 post-effectiveness currency analysis only. Rule 3-12 does NOT apply here.

Framework: ${frameworkNote}

CURRENT = (a) audited FS fiscal year-end within ${Math.round(ANNUAL_LIMIT/30)} months AND (b) if past 9 months from effective date: prospectus updated with FS as current as latest EDGAR 10-K/10-Q. "fail" = NOT CURRENT. "warn" = usable but requires remediation. "pass" = CURRENT.

Company: ${companyName} (${ticker.toUpperCase()}) | Form: ${selectedReg.form} filed ${selectedReg.date} | Effective: ${effectiveDate.toISOString().split("T")[0]} (${daysSinceEffective} days ago) | Shelf: ${isShelf} | FPI: ${isFPI}

Compliance checks:
${checkSummary}

Overall: ${overallStatus.toUpperCase()}
Provide 2-3 sentence verdict citing Section 10(a)(3) specifically. What is the primary issue? What action is required?`,
      response_json_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] },
          summary: { type: "string" }, key_issue: { type: "string" }, required_action: { type: "string" }
        }
      }
    });

    return Response.json({
      mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
      registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
        daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isWarrantReg,
        annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: 9,
        securitiesRegistered: securitiesRegistered || null },
      overallStatus, stage: "post_effective", applicableRule: "Section 10(a)(3) / Item 512",
      aiSummary: aiSummary || null, checks,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});