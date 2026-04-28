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
    let user;
    try {
      user = await base44.auth.me();
    } catch (_) {
      user = null;
    }
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

    const edgarUrl = (f) => {
      if (!f) return null;
      if (f.indexUrl) return f.indexUrl;
      const accClean = f.accession?.replace(/-/g, "");
      if (!accClean) return null;
      if (f.doc && f.doc.trim()) {
        return `https://www.sec.gov/Archives/edgar/data/${parseInt(f.cik || cik)}/${accClean}/${f.doc}`;
      }
      return `https://www.sec.gov/Archives/edgar/data/${parseInt(f.cik || cik)}/${accClean}/${accClean}-index.htm`;
    };

    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    // isLikelyEffective: used in LIST MODE (no file-number feed available yet).
    // Uses company-wide EFFECT notices + 424B proxies from submissions.json.
    // For DETAIL MODE, we re-check using the authoritative file-number feed after it is fetched.
    const isLikelyEffective = (regFiling, feedEffects) => {
      const form = regFiling.form?.toUpperCase().trim();
      // S-3, F-3, S-8 are auto-effective upon filing under Rule 462(e)/(f)
      if (form === "S-8" || form?.includes("S-3") || form?.includes("F-3")) {
        return { effective: true, reason: `${form} auto-effective upon filing under Rule 462`, effectDate: regFiling.date };
      }
      const regDate = new Date(regFiling.date);
      const fileNum = regFiling.fileNumber || null;

      // 1. Authoritative: EFFECT notices scoped to this registration's file number
      if (feedEffects && feedEffects.length > 0) {
        const hit = feedEffects.find(e => new Date(e.date) >= regDate);
        if (hit) return { effective: true, reason: `EFFECT notice ${hit.date} (file no. ${fileNum})`, effectDate: hit.date };
      }

      // 2. Company-wide EFFECT notices from submissions.json, scoped by file number when available
      const effectAfter = effectFilings.find(e => {
        const eDate = new Date(e.date);
        if (eDate < regDate || (eDate - regDate) >= 365 * 24 * 60 * 60 * 1000) return false;
        if (fileNum && e.fileNumber) return e.fileNumber === fileNum;
        return true;
      });
      if (effectAfter) return { effective: true, reason: `EFFECT notice filed ${effectAfter.date}`, effectDate: effectAfter.date };

      // 3. A 424B filing is definitive proof of effectiveness
      const sameReg = (f) => (!fileNum || !f.fileNumber) ? true : f.fileNumber === fileNum;
      const prospectusAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && sameReg(f);
      });
      if (prospectusAfter) return { effective: true, reason: `424B prospectus filed ${prospectusAfter.date} (proxy for effectiveness)`, effectDate: prospectusAfter.date };

      return { effective: false, reason: "No EFFECT notice or 424B prospectus found" };
    };

    // ── List mode ─────────────────────────────────────────────────────────────
    // Collect ALL registration-related filings (base forms + amendments)
    const allRegFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      return REG_FORMS.some(r => form === r || form === r + "/A" || form.startsWith(r + "/"));
    });

    // Group by file number so that S-1 + S-1/A + S-1/A/A are all ONE registration.
    // For each group, use the MOST RECENT amendment as the representative (it's the live document).
    // Registrations with no file number fall back to grouping by accession.
    const regGroups = new Map(); // fileNumber (or accession) → array of filings
    for (const f of allRegFilings) {
      const key = f.fileNumber || f.accession;
      if (!regGroups.has(key)) regGroups.set(key, []);
      regGroups.get(key).push(f);
    }

    // For each group, sort by date descending and take the most recent as the representative
    const regFilings = [...regGroups.values()].map(group => {
      group.sort((a, b) => b.date.localeCompare(a.date));
      const rep = group[0]; // most recent amendment or original
      // Attach the original (earliest) filing date for reference
      rep._originalDate = group[group.length - 1].date;
      rep._originalAccession = group[group.length - 1].accession;
      rep._amendmentCount = group.length - 1;
      return rep;
    });
    // Sort the de-duped list by the representative's date, newest first
    regFilings.sort((a, b) => b.date.localeCompare(a.date));

    if (!accession) {
      const subjectSummaries = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `For each of the following SEC registration statement filings by ${companyName} (ticker: ${ticker.toUpperCase()}), write a concise label (5-12 words) listing the types of securities being registered and the offering context. Examples: "Common stock — IPO", "Common stock & warrants — resale", "Underlying shares from convertible notes — resale", "Employee stock options — S-8 plan", "Common stock, preferred stock & warrants — shelf offering", "Merger consideration shares — S-4". Focus on security types and whether it's primary, resale/secondary, or merger/plan. Return a JSON array in the same order.

Filings:
${regFilings.map((f, i) => `${i}. Form: ${f.form}, Date: ${f.date}, Description: "${f.description || ""}"`).join("\n")}`,
        response_json_schema: { type: "object", properties: { summaries: { type: "array", items: { type: "string" } } } }
      });
      const summaryList = subjectSummaries?.summaries || [];
      return Response.json({
        mode: "list", ticker: ticker.toUpperCase(), cik, companyName,
        registrationStatements: regFilings.map((f, i) => {
          const eff = isLikelyEffective(f, null); // list mode — no file-number feed
          return {
            form: f.form, date: f.date, accession: f.accession, doc: f.doc, url: edgarUrl(f),
            daysOld: daysSince(f.date), effective: eff.effective, effectiveReason: eff.reason,
            effectDate: eff.effectDate || null, registrationNumber: f.fileNumber || null,
            subject: summaryList[i] || null,
            amendmentCount: f._amendmentCount || 0,
            originalDate: f._originalDate || f.date,
          };
        }),
      });
    }

    // In detail mode, the user may pass the accession of ANY amendment in the family.
    // Resolve it to the group representative (most recent amendment) so we always
    // analyse the live document, while using the file number to pull all related filings.
    const clickedFiling = filings.find(f => f.accession === accession);
    const resolvedFileNum = clickedFiling?.fileNumber || null;
    // Find the representative for this file number group
    const resolvedRep = resolvedFileNum
      ? regFilings.find(f => f.fileNumber === resolvedFileNum)
      : regFilings.find(f => f.accession === accession);
    const resolvedAccession = resolvedRep?.accession || accession;

    // ── Detail mode: deep-check the selected registration ────────────────────
    // Always use the most recent amendment (resolvedAccession) as the live document.
    const selectedReg = filings.find(f => f.accession === resolvedAccession) || filings.find(f => f.accession === accession);
    if (!selectedReg) return Response.json({ error: "Registration statement not found" }, { status: 404 });

    // securitiesRegistered will be extracted from the document cover page text below
    // (after the main doc is fetched for IBR analysis — no separate fetch needed)
    let securitiesRegistered = null;

    // ── Issuer / form classification ─────────────────────────────────────────
    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isFForm = regType.startsWith("F-");
    // S-4/F-4 MAY be transaction registrations (mergers) where the prospectus is no longer
    // being "used" once the transaction closes — Section 10(a)(3) only applies "when a
    // prospectus is used" (15 U.S.C. § 77j(a)(3)). But some S-4/F-4s register warrants
    // or resale securities that ARE continuously offered. We must check the actual document
    // before short-circuiting. isTransactionReg is determined after IBR/document analysis below.
    const isSorFFourBase = (regType === "S-4" || regType === "S-4/A" || regType === "F-4" || regType === "F-4/A");

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

    // Post-effective annual FS age cap (warrant-exercise F-4s get 18-month relaxation)
    const ANNUAL_LIMIT = isFForm ? SECTION_10A3_15_MONTHS : SECTION_10A3_16_MONTHS;

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
    // 
    // CRITICAL: For non-shelf regs with NO 424B updates yet, the REG STATEMENT ITSELF
    // is the live prospectus and must be parsed to extract the actual FS dates.
    let regIBRInfo = null; // will hold LLM-extracted IBR data from the registration document
    if (selectedReg?.doc) {
      try {
        const regDocUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${resolvedAccession.replace(/-/g, "")}/${selectedReg.doc}`;
        const regDocRes = await fetch(regDocUrl, { headers: HEADERS });
        if (regDocRes.ok) {
          const regDocText = await regDocRes.text();

          // Strip HTML tags and collapse whitespace to get readable text
          const plainText = regDocText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

          // ── Direct regex extraction of FS dates from plain text ───────────────
          // Strategy: find "BALANCE SHEET" or "BALANCE SHEETS" header occurrences,
          // then scan the surrounding text (±600 chars) for date patterns like
          // "December 31, 2025" or "March 31, 2025". These are the column headers
          // in the actual financial tables and are the authoritative FS period dates.
          const MONTH_MAP = { january:1, february:2, march:3, april:4, may:5, june:6,
            july:7, august:8, september:9, october:10, november:11, december:12 };
          const todayStr = new Date().toISOString().slice(0,10); // e.g. "2026-04-28"

          const extractDatesNear = (text, keywordRegex, windowSize = 600) => {
            const dates = new Set();
            const localDatePat = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/gi;
            let km;
            const pat = new RegExp(keywordRegex.source, "gi");
            while ((km = pat.exec(text)) !== null) {
              const snippet = text.slice(Math.max(0, km.index - 100), Math.min(text.length, km.index + windowSize));
              let dm;
              const lp = new RegExp(localDatePat.source, "gi");
              while ((dm = lp.exec(snippet)) !== null) {
                const mon = MONTH_MAP[dm[1].toLowerCase()];
                const day = parseInt(dm[2]);
                const yr = parseInt(dm[3]);
                const iso = `${yr}-${String(mon).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                // Only accept past/current dates, not future ones (excludes legal instrument maturity dates etc.)
                if (yr >= 2018 && iso <= todayStr) dates.add(iso);
              }
            }
            return [...dates].sort((a,b) => b.localeCompare(a));
          };

          // Primary: dates near balance sheet headers (most reliable)
          const bsDates = extractDatesNear(plainText, /balance\s+sheets?/gi, 600);
          // Secondary: dates near income statement headers
          const isDates = extractDatesNear(plainText, /statements?\s+of\s+operations|statements?\s+of\s+(comprehensive\s+)?(?:income|loss)/gi, 400);
          // Combined unique set
          const allFSDates = [...new Set([...bsDates, ...isDates])].sort((a,b) => b.localeCompare(a));

          // A date is a fiscal year-end if it falls on Dec 31, Mar 31, Jun 30, or Sep 30
          // AND appears at least twice in bsDates (column header repeats for both periods shown)
          // OR it's Dec 31 (most common domestic FYE)
          const isFYE = (d) => d.endsWith("-12-31") || d.endsWith("-03-31") || d.endsWith("-06-30") || d.endsWith("-09-30");

          // Among balance sheet dates: split into FYE candidates vs interim candidates
          const fyeDates = bsDates.filter(isFYE);
          const interimDates = bsDates.filter(d => !isFYE(d));

          // Pick most recent of each
          const regexMostRecentAnnual = fyeDates[0] || null;
          // Interim: must be AFTER the most recent annual (otherwise it's just the comparison period)
          const regexMostRecentInterim = regexMostRecentAnnual
            ? (interimDates.find(d => d > regexMostRecentAnnual) || null)
            : (interimDates[0] || null);



          // Search for IBR section by looking for the keyword anywhere in the full text
          const ibrKeyword = /incorporat\w*\s+by\s+reference|where\s+you\s+can\s+find\s+more\s+information/gi;
          let ibrSnippet = "";
          let match;
          const snippets = [];
          while ((match = ibrKeyword.exec(plainText)) !== null) {
            const start = Math.max(0, match.index - 200);
            const end = Math.min(plainText.length, match.index + 3000);
            snippets.push(plainText.slice(start, end));
            if (snippets.length >= 5) break;
          }
          ibrSnippet = snippets.join("\n\n---\n\n");

          // Grab last 8000 chars where IBR sections often appear at end of S-4
          const tailText = plainText.slice(-8000);

          const contextToAnalyze = ibrSnippet
            ? `EXTRACTED IBR-RELEVANT SECTIONS (found by keyword search):\n${ibrSnippet.slice(0, 12000)}\n\nDOCUMENT TAIL (last portion):\n${tailText}`
            : `No IBR keyword found in document. Document tail:\n${tailText}`;

          const offeringSnippet = plainText.slice(0, 5000) + "\n\n" + plainText.slice(-3000);

          const ibr = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `You are reviewing an SEC registration statement. Extract:

1. HAS_IBR_SECTION: Is there a dedicated "Incorporation by Reference" section? (true/false)

2. FORWARD_IBR: Does it contain automatic forward IBR language for future Exchange Act filings? (true/false)

3. SPECIFIC_ANNUAL_INCORPORATED: Fiscal year-end (YYYY-MM-DD) of specifically NAMED 10-K/20-F in IBR, else null.

4. IS_ONGOING_OFFERING: (true/false) Is this prospectus for ongoing offers? Return TRUE if warrants, resale, or continuous offerings are registered. Return FALSE only if ONLY merger consideration shares, NO warrants, NO resale.

NOTE: FS dates (most_recent_annual_date, most_recent_interim_date) will be pre-populated from direct regex extraction — you do NOT need to find them.

Extracted text:\n${contextToAnalyze.slice(0, 12000)}\n\nCOVER PAGE:\n${offeringSnippet.slice(0, 3000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                has_ibr_section: { type: "boolean" },
                forward_ibr: { type: "boolean" },
                specific_annual_incorporated: { type: ["string", "null"] },
                is_ongoing_offering: { type: "boolean" }
              }
            }
          });

          // Merge: use regex-extracted FS dates as primary source (reliable),
          // LLM for IBR/structure fields only.
          regIBRInfo = {
            ...(ibr || {}),
            most_recent_annual_date: regexMostRecentAnnual,
            most_recent_interim_date: regexMostRecentInterim,
            balance_sheet_dates: allFSDates.slice(0, 10),
          };

          // ── Extract securities being registered from the cover page ──────────
          // Use the cover page text (first 8000 chars of the plain text) which always
          // contains the "Securities Being Registered" section on S-1, S-3, S-4, etc.
          try {
            const coverText = plainText.slice(0, 10000);
            securitiesRegistered = await base44.asServiceRole.integrations.Core.InvokeLLM({
              prompt: `Read this SEC registration statement cover page and extract what securities are being registered.

For EACH security class listed, extract:
- security_class: e.g. "Class A Common Stock", "Warrants to Purchase Common Stock", "Units"
- offering_type: "Primary" (company selling new shares), "Resale" (selling shareholders), or "Underlying" (shares issuable on exercise of warrants/options)
- amount_registered: number of shares/units if stated
- price_per_unit: offering price per unit if stated (may be null)
- aggregate_offering_price: total offering amount if stated (may be null)

Also provide:
- label: 5-10 word plain-English summary of what is being registered (e.g. "Common stock and warrants — resale by selling shareholders")
- summary: 1-2 sentence description of the offering
- offering_types: comma-separated list: Primary, Resale, Underlying (only those present)

IMPORTANT: Read the actual "Securities Being Registered" or "Title of Each Class of Securities" table from the document. Do NOT guess.

Cover page text:
${coverText}`,
              response_json_schema: {
                type: "object",
                properties: {
                  label: { type: "string" }, summary: { type: "string" },
                  securities: { type: "array", items: { type: "object", properties: {
                    security_class: { type: "string" }, offering_type: { type: "string" },
                    amount_registered: { type: "string" }, price_per_unit: { type: "string" },
                    aggregate_offering_price: { type: "string" }
                  }}},
                  offering_types: { type: "string" }
                }
              }
            });
          } catch (_) { /* non-critical */ }

          // Update prospectus dates from actual FS in the reg document
          if (ibr?.most_recent_interim_date && /^\d{4}-\d{2}-\d{2}$/.test(ibr.most_recent_interim_date)) {
            prospectusInterimPeriodEndDate = ibr.most_recent_interim_date;
          }
          if (ibr?.most_recent_annual_date && /^\d{4}-\d{2}-\d{2}$/.test(ibr.most_recent_annual_date)) {
            prospectusIncorporatedDate = ibr.most_recent_annual_date;
          }
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

    // Determine if this S-4/F-4 is a one-time completed transaction (no ongoing prospectus use)
    // or an ongoing offering (warrant exercises, resale, etc.) where Section 10(a)(3) applies.
    // Section 10(a)(3) only triggers "when a prospectus is used" — if no prospectus is being
    // actively used for ongoing offers, the obligation does not arise.
    //
    // ADDITIONAL HARD CHECK: If the fee table shows warrants or warrant shares registered,
    // it is definitively an ongoing offering — override the LLM determination.
    // isOngoingOffering: determined by LLM reading the actual document cover page.
    // For S-4/F-4: is_ongoing_offering=false means pure merger — no Section 10(a)(3) obligation.
    const isTransactionReg = isSorFFourBase && (
      regIBRInfo !== null
        ? regIBRInfo.is_ongoing_offering === false
        : false  // couldn't read doc — assume ongoing to be conservative
    );

    const isProspectusOrPosAm = (f) =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) ||
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim());

    const isRegStatementForm = (form) => {
      const f = form?.toUpperCase().trim();
      return REG_FORMS.some(r => f === r || f === r + "/A" || f.startsWith(r + "/"));
    };

    // ── AUTHORITATIVE LOOKUP: query EDGAR by file number ─────────────────────
    // browse-edgar?action=getcompany&filenum=333-XXXXXX&output=atom returns EVERY filing
    // ever made under this registration file number: S-1, S-1/A, 424Bs, POS AMs, EFFECT, etc.
    // This is THE source of truth. We use it for:
    //   1. All prospectus updates (424B filings)
    //   2. POS AM filings and their effectiveness (EFFECT notices)
    //   3. Whether the original registration was declared effective
    //
    // Real Atom entry format observed from live EDGAR feed:
    //   ...href="https://.../{accno}-index.htm"...
    //   424B3 - Prospectus [Rule 424(b)(3)]
    //   <b>Filed:</b> 2023-11-08 <b>AccNo:</b> 0001104659-23-115727 <b>Size:</b> 4 MB
    //
    // Each entry block ends at the next AccNo. We parse by finding each AccNo, then
    // look BACKWARDS in the text for Filed date, index URL, and form type.

    const parseFileNumFeed = (xml) => {
      // The EDGAR Atom feed uses proper XML tags inside each <entry> block:
      //   <accession-number>, <filing-date>, <filing-href>, <filing-type>
      // Split on entry boundaries and parse each block's XML tags directly.
      const entries = [];
      const entryBlocks = xml.split(/<entry[\s>]/i);
      for (const block of entryBlocks.slice(1)) {
        const accNo  = (block.match(/<accession-number>([\d-]+)<\/accession-number>/i) || [])[1];
        const date   = (block.match(/<filing-date>(\d{4}-\d{2}-\d{2})<\/filing-date>/i) || [])[1];
        const href   = (block.match(/<filing-href>(https?:\/\/[^<]+)<\/filing-href>/i) || [])[1];
        const form   = (block.match(/<filing-type>([^<]+)<\/filing-type>/i) || [])[1]?.trim().toUpperCase();
        if (!accNo || !date || !form) continue;
        entries.push({ accNo, date, form, indexUrl: href || `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo.replace(/-/g,"")}/${accNo}-index.htm` });
      }
      return entries;
    };

    // All filings under this file number from EDGAR
    let allFileNumEntries = [];
    if (regFileNumber) {
      try {
        const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(regFileNumber)}&type=&dateb=&owner=include&count=100&search_text=&output=atom`;
        const res = await fetch(url, { headers: HEADERS });
        if (res.ok) {
          allFileNumEntries = parseFileNumFeed(await res.text());
        }
      } catch (_) { /* proceed with empty */ }
    }

    // EFFECT notices from the authoritative feed (scoped to this registration's file number)
    const fileNumEffectFilings = allFileNumEntries
      .filter(e => e.form === "EFFECT")
      .map(e => ({ form: e.form, date: e.date, accession: e.accNo, fileNumber: regFileNumber, cik, indexUrl: e.indexUrl }));

    // All prospectus/POS AM updates for this registration
    const allUpdatesWithThisFileNumber = allFileNumEntries
      .filter(e => isProspectusOrPosAm({ form: e.form }))
      .map(e => ({ form: e.form, date: e.date, accession: e.accNo, doc: "", fileNumber: regFileNumber, cik, indexUrl: e.indexUrl }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // ── Build the full filing chain for this registration (used in ALL response paths) ──
    // Everything under the file number: S-1, S-1/A, EFFECT, 424B, POS AM — chronological order.
    const buildFilingChain = () => {
      const feedEntries = allFileNumEntries
        .filter(e => e.form !== "UPLOAD")
        .sort((a, b) => a.date.localeCompare(b.date));
      const feedAccNosSet = new Set(feedEntries.map(e => e.accNo));
      // Add original reg statement(s) from submissions.json if not already in the feed
      const fromSubs = filings.filter(f =>
        f.fileNumber === regFileNumber &&
        !feedAccNosSet.has(f.accession) &&
        isRegStatementForm(f.form)
      ).map(f => ({ accNo: f.accession, date: f.date, form: f.form, indexUrl: edgarUrl(f) }));
      return [...fromSubs, ...feedEntries]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => ({
          form: e.form, date: e.date, accession: e.accNo, url: e.indexUrl,
          isEffect: e.form === "EFFECT",
          isProspectus: PROSPECTUS_FORMS.some(p => e.form?.toUpperCase().startsWith(p)),
          isPosAm: POST_EFFECTIVE_FORMS.includes(e.form?.toUpperCase().trim()),
          isRegStatement: isRegStatementForm(e.form),
        }));
    };
    const filingChain = buildFilingChain();

    // POS AM effectiveness: check against EFFECT notices from this registration's file number feed
    const isPosAmEffectiveFromFeed = (posAm) => {
      const posDate = new Date(posAm.date);
      return fileNumEffectFilings.some(e => {
        const eDate = new Date(e.date);
        return eDate >= posDate && (eDate - posDate) <= 60 * 24 * 60 * 60 * 1000;
      });
    };

    // Post-effective amendments (POS AM)
    const allPostEffectiveAmendments = allUpdatesWithThisFileNumber.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim())
    );
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffectiveFromFeed);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffectiveFromFeed(f));
    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    // 424B prospectuses
    const prospectuses = allUpdatesWithThisFileNumber.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p))
    );
    const latestProspectus = prospectuses[0] || null;

    for (const updateFiling of allUpdatesWithThisFileNumber) {
      try {
        // Build the URL: prefer indexUrl (resolves the actual doc), fallback to direct doc URL
        let updateUrl;
        if (updateFiling.indexUrl) {
          // Fetch the index page to find the primary document filename
          const idxRes = await fetch(updateFiling.indexUrl, { headers: HEADERS }).catch(() => null);
          if (idxRes?.ok) {
            const idxHtml = await idxRes.text();
            // Extract the first .htm document from the index table (primary document)
            const docMatch = idxHtml.match(/href="(\/Archives\/edgar\/data\/[^"]+?\.htm)"/i);
            updateUrl = docMatch ? `https://www.sec.gov${docMatch[1]}` : null;
          }
        } else if (updateFiling.doc) {
          updateUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${updateFiling.accession.replace(/-/g, "")}/${updateFiling.doc}`;
        }
        if (!updateUrl) continue;
        const updateRes = await fetch(updateUrl, { headers: HEADERS });
        if (updateRes.ok) {
          const updateText = await updateRes.text();
          const extracted = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Extract FS table dates from this SEC prospectus document:

1. BALANCE_SHEET_DATES: Look for "Condensed Consolidated Balance Sheet" or "Balance Sheet" table headers. Extract ALL column dates shown (e.g. ["2024-03-31", "2023-12-31"]). Read the exact header text.
2. INCOME_STATEMENT_DATES: Look for "Statement of Operations" or "Income Statement" table headers. Extract ALL period-end dates (e.g. ["2024-03-31", "2023-03-31"]).
3. MOST_RECENT_INTERIM_DATE: The most recent non-annual (Q1, Q2, Q3) date from the tables. null if only annual.
4. MOST_RECENT_ANNUAL_DATE: The most recent FY-end (December 31 or other year-end) from the tables. null if none.

Document excerpt (first 15000 chars):\n${updateText.slice(0, 15000)}`,
            response_json_schema: {
              type: "object",
              properties: {
                balance_sheet_dates: { type: "array", items: { type: "string" } },
                income_statement_dates: { type: "array", items: { type: "string" } },
                most_recent_interim_date: { type: ["string", "null"] },
                most_recent_annual_date: { type: ["string", "null"] }
              }
            }
          });

          // Update prospectusIncorporatedDate if this filing has a more recent annual
          if (extracted?.most_recent_annual_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.most_recent_annual_date)) {
            if (!prospectusIncorporatedDate || new Date(extracted.most_recent_annual_date) > new Date(prospectusIncorporatedDate)) {
              prospectusIncorporatedDate = extracted.most_recent_annual_date;
            }
          }

          // Update prospectusInterimPeriodEndDate if this filing has a more recent interim
          if (extracted?.most_recent_interim_date && /^\d{4}-\d{2}-\d{2}$/.test(extracted.most_recent_interim_date)) {
            if (!prospectusInterimPeriodEndDate || new Date(extracted.most_recent_interim_date) > new Date(prospectusInterimPeriodEndDate)) {
              prospectusInterimPeriodEndDate = extracted.most_recent_interim_date;
            }
          }
        }
      } catch (_) { /* continue to next filing */ }
    }

    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
    );
    const latestAnnual = annuals[0] || null;

    const quarterlies = subsequentFilings.filter(f => f.form === "10-Q" || f.form === "10-Q/A");
    const latestQuarterly = quarterlies[0] || null;

    const currentReports = subsequentFilings.filter(f => f.form?.startsWith("8-K"));
    const latestCurrent = currentReports[0] || null;



    // Pick whichever is more recent: the latest effective POS AM or the latest 424B prospectus
    const mostRecentEffectiveUpdate = (() => {
      if (!latestPostEffective && !latestProspectus) return null;
      if (!latestPostEffective) return latestProspectus;
      if (!latestProspectus) return latestPostEffective;
      return new Date(latestProspectus.date) > new Date(latestPostEffective.date)
        ? latestProspectus : latestPostEffective;
    })();

    const checks = [];

    // ── CHECK A: Is the registration effective? ───────────────────────────────
    // Use authoritative EFFECT notices from the file-number feed when available
    const effectiveness = isLikelyEffective(selectedReg, fileNumEffectFilings);
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
        //
        // BEST CASE: use the actual fiscal year-end date extracted by LLM from the registration document
        // itself (regIBRInfo.most_recent_annual_date). This is the correct date to measure staleness from.
        // FALLBACK: use the 10-K filing date as a conservative proxy (filing date > fiscal year-end,
        // so this slightly overstates staleness — safe but may produce false warnings).
        const fsAnnualDate = (regIBRInfo?.most_recent_annual_date && /^\d{4}-\d{2}-\d{2}$/.test(regIBRInfo.most_recent_annual_date))
          ? regIBRInfo.most_recent_annual_date
          : latestPriorAnnual.date;
        const fsInterimDate = (regIBRInfo?.most_recent_interim_date && /^\d{4}-\d{2}-\d{2}$/.test(regIBRInfo.most_recent_interim_date))
          ? regIBRInfo.most_recent_interim_date
          : null;
        const priorAnnualAge = daysSince(fsAnnualDate);

        // Grace window check: audited year-end FS must be included if available before effectiveness.
        // Two cases:
        //   (a) A newer 10-K was filed AFTER the registration date (annuals.length > 0), OR
        //   (b) The 10-K filed BEFORE the reg date covers a LATER FISCAL YEAR than the FS in the
        //       reg document (i.e., the S-1 was filed with stale FS even though a newer fiscal year's
        //       10-K already existed). We compare fiscal year-end dates, not filing dates.
        //
        // IMPORTANT: A 10-K filed on e.g. 2026-03-31 for FY2025 (year-end 2025-12-31) does NOT
        // constitute "newer FS" if the S-1 already contains FY2025 FS (year-end 2025-12-31).
        // We must compare fiscal year-ends, not filing dates.
        //
        // Heuristic for prior annual's fiscal year-end: a 10-K filed in Q1 of year Y typically
        // covers FY ending Dec 31 of year Y-1. We derive the FYE from the filing date.
        const deriveFYEFromFilingDate = (filingDateStr) => {
          // For a 10-K filed Jan-Apr of year Y, FYE is typically Dec 31 of year Y-1
          // For a 10-K filed May-Dec of year Y, FYE is typically Dec 31 of year Y
          // More precisely: most 10-Ks are filed within 60-90 days of FYE.
          // Simple heuristic: filing date minus 90 days ≈ FYE year
          const d = new Date(filingDateStr);
          const approxFYE = new Date(d.getTime() - 90 * 24 * 60 * 60 * 1000);
          // Return Dec 31 of that approximate year
          return `${approxFYE.getFullYear()}-12-31`;
        };
        const priorAnnualDerivedFYE = deriveFYEFromFilingDate(latestPriorAnnual.date);
        // A newer 10-K's FYE is "after" the reg's FS FYE only if it covers a LATER fiscal year
        const newerAnnualAlreadyFiled = priorAnnualDerivedFYE > fsAnnualDate;
        const isAuditedFSAvailableBeforeEffectiveness =
          annuals.length > 0 || newerAnnualAlreadyFiled;
        // Identify the most current available annual for the error message
        const mostCurrentAvailableAnnual = annuals[0] || (newerAnnualAlreadyFiled ? latestPriorAnnual : null);

        let r312Status, r312Detail;

        const fsDateSource = fsAnnualDate !== latestPriorAnnual.date
          ? `fiscal year-end ${fsAnnualDate} (from FS in registration document)`
          : `${annualFormLabel} filing date ${latestPriorAnnual.date} (proxy — actual year-end is earlier)`;

        if (priorAnnualAge > rule312Days) {
          r312Status = "fail";
          r312Detail = `Rule 3-12 (pre-effectiveness): Audited FS in the registration statement have fiscal year-end ${fsAnnualDate} — ${priorAnnualAge} days ago. The applicable threshold is ${rule312Days} days (${rule312Basis}). The financial statements may be too stale to support effectiveness — a Rule 3-12 update (amendment with refreshed FS) is required before the SEC can declare the registration effective.`;
        } else {
          r312Status = "pass";
          r312Detail = `Rule 3-12 (pre-effectiveness): Audited FS fiscal year-end ${fsAnnualDate} (${fsDateSource}) is ${priorAnnualAge} days ago — within the ${rule312Days}-day threshold (${rule312Basis}). Financial statements appear current for pre-effectiveness purposes as of today.`;
        }

        // If a more current annual report is available (either filed after submission, or was already
        // filed before submission but not yet included in the registration), flag it.
        if (isAuditedFSAvailableBeforeEffectiveness && mostCurrentAvailableAnnual) {
          if (r312Status === "pass") {
            r312Status = "warn";
            r312Detail += ` However, a more current ${mostCurrentAvailableAnnual.form} (${mostCurrentAvailableAnnual.date}) is available and has NOT been incorporated into this registration — Rule 3-12 requires that if audited year-end FS are available before effectiveness, they must be included. An amendment incorporating the ${mostCurrentAvailableAnnual.form} is required before the SEC can declare the registration effective.`;
          } else {
            r312Detail += ` Additionally, a more current ${mostCurrentAvailableAnnual.form} (${mostCurrentAvailableAnnual.date}) exists on EDGAR and must be incorporated into the registration via amendment before effectiveness.`;
          }
        }

        checks.push({
          id: "rule312_preeffective",
          label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
          status: r312Status,
          detail: r312Detail,
          filingDate: latestPriorAnnual.date, filingUrl: edgarUrl(latestPriorAnnual), filingForm: latestPriorAnnual.form,
        });

        // Interim assessment under Rule 3-12 — use LLM-extracted interim date if available
        const interimCheckDate = fsInterimDate || latestPriorQuarterly?.date || null;
        const interimCheckForm = latestPriorQuarterly?.form || "10-Q";
        if (interimCheckDate) {
          const priorQAge = daysSince(interimCheckDate);
          const interimThreshold = 134; // Rule 3-12: interim FS must not be more than ~4.5 months (135 days) old
          const interimStatus = priorQAge > interimThreshold ? "warn" : "pass";
          const interimDateSource = fsInterimDate && fsInterimDate !== latestPriorQuarterly?.date
            ? `interim period-end ${interimCheckDate} (from FS in registration document)`
            : `${interimCheckForm} filed ${interimCheckDate}`;
          checks.push({
            id: "rule312_interim_preeffective",
            label: "Rule 3-12 Pre-Effectiveness — Interim Financial Statement Currency",
            status: interimStatus,
            detail: interimStatus === "warn"
              ? `Most recent interim FS in the registration have period-end ${interimCheckDate} (${interimDateSource}) — ${priorQAge} days ago. This may be too stale as the most current interim period before effectiveness. Review whether a more recent interim period should be reflected in the registration.`
              : `Most recent interim FS in the registration have period-end ${interimCheckDate} (${interimDateSource}) — ${priorQAge} days ago. Appears current for pre-effectiveness interim financial statement purposes.`,
            filingDate: latestPriorQuarterly?.date || null, filingUrl: edgarUrl(latestPriorQuarterly), filingForm: interimCheckForm,
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
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm,
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

    // ── CHECK: IBR status of the registration document ──────────────────────
    // Surface whether the registration statement itself contains IBR language,
    // including any forward/automatic IBR clause that auto-incorporates future filings.
    // This runs for ALL registration types including transaction regs (S-4/F-4).
    if (regIBRInfo !== null) {
      let ibrStatus, ibrDetail;
      if (!regIBRInfo.has_ibr_section) {
        ibrStatus = "warn";
        ibrDetail = `No Incorporation by Reference section detected in the registration statement. All financial statement updates must be made via 424B supplement or effective POS AM — no automatic IBR refresh available.`;
      } else if (regIBRInfo.forward_ibr) {
        ibrStatus = "pass";
        ibrDetail = `Forward/automatic IBR clause detected`;
        if (regIBRInfo.forward_ibr_section_heading) {
          ibrDetail += ` in section: "${regIBRInfo.forward_ibr_section_heading}"`;
        }
        ibrDetail += `. Subsequent Exchange Act filings (10-K, 10-Q, 8-K) filed after the registration date are automatically incorporated by reference.`;
        if (regIBRInfo.forward_ibr_quote) {
          ibrDetail += ` Exact language: "${regIBRInfo.forward_ibr_quote}"`;
        }
        if (regIBRInfo.ibr_summary) {
          ibrDetail += ` ${regIBRInfo.ibr_summary}`;
        }
        if (regIBRInfo.specific_docs_list?.length > 0) {
          ibrDetail += ` Specific named documents also incorporated: ${regIBRInfo.specific_docs_list.join("; ")}.`;
        } else if (regIBRInfo.specific_annual_incorporated) {
          ibrDetail += ` Specifically named: annual FS with fiscal year-end ${regIBRInfo.specific_annual_incorporated}${regIBRInfo.specific_interim_incorporated ? `; interim FS through ${regIBRInfo.specific_interim_incorporated}` : ""}.`;
        }
      } else {
        ibrStatus = "info";
        ibrDetail = `IBR section present`;
        if (regIBRInfo.forward_ibr_section_heading) {
          ibrDetail += ` ("${regIBRInfo.forward_ibr_section_heading}")`;
        }
        ibrDetail += ` but NO forward/automatic IBR clause — only specific named documents are incorporated. Future Exchange Act filings are NOT automatically incorporated.`;
        if (regIBRInfo.ibr_summary) {
          ibrDetail += ` ${regIBRInfo.ibr_summary}`;
        }
        if (regIBRInfo.specific_docs_list?.length > 0) {
          ibrDetail += ` Named documents: ${regIBRInfo.specific_docs_list.join("; ")}.`;
        } else if (regIBRInfo.specific_annual_incorporated) {
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

    // ── Transaction registrations (S-4/F-4 mergers) — short-circuit ──────────
    // Section 10(a)(3) only applies "when a prospectus is used" (15 U.S.C. § 77j(a)(3)).
    // For a completed one-time transaction (merger/business combination), the prospectus
    // is no longer being used for any ongoing offer — so the obligation never triggers.
    // This determination is made by the LLM reading the actual registration document above.
    if (isTransactionReg) {
      const ongoingReason = regIBRInfo?.ongoing_offering_reason || "The prospectus was used solely for a one-time business combination transaction. Once the merger closed and merger consideration was issued, no further offers are being made using this prospectus.";
      checks.push({
        id: "transaction_reg_note",
        label: "One-Time Transaction Registration (S-4/F-4) — No Ongoing Prospectus Use",
        status: "info",
        detail: `Section 10(a)(3) of the Securities Act only applies "when a prospectus is used" for ongoing offers. Based on review of the registration document, this appears to be a pure one-time business combination transaction with no warrants, resale component, or other ongoing Securities Act use: ${ongoingReason} The registration document was reviewed for: (1) warrants or warrant shares in the fee table, (2) resale/selling shareholder components, (3) Section 10(a)(3) undertakings, and (4) ongoing offering language. None were found. If the governing warrant agreement separately requires maintaining an effective registration statement post-merger for warrant exercises, that obligation would apply to that prospectus and should be analyzed separately.`,
        filingDate: null, filingUrl: edgarUrl(selectedReg), filingForm: selectedReg.form,
      });
      const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt: `Securities law expert. This is an S-4/F-4 registration for ${companyName} (${ticker.toUpperCase()}), filed ${selectedReg.date}, effective ${effectiveness.effectDate}. The LLM reviewed the actual registration document and determined it is a one-time transaction (not an ongoing offering): "${ongoingReason}". Under Section 10(a)(3) of the Securities Act (15 U.S.C. § 77j(a)(3)), the currency obligation only arises "when a prospectus is used." Since no prospectus is currently being used for ongoing offers, Section 10(a)(3) does not apply. Verdict MUST be "CURRENT". In 1-2 sentences explain this and note any caveats (e.g. if warrants are outstanding and being exercised, that prospectus would need separate analysis).`,
        response_json_schema: { type: "object", properties: { verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] }, summary: { type: "string" }, key_issue: { type: "string" }, required_action: { type: "string" } } }
      });
      return Response.json({
        mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
        registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm, isTransactionReg: true,
          registrationNumber: regFileNumber || null,
          annualLimitMonths: null, interimLimitMonths: null,
          securitiesRegistered: securitiesRegistered || null },
        filingChain: filingChain.length > 0 ? filingChain : null,
        overallStatus: "pass", stage: "post_effective", applicableRule: "N/A — Completed Transaction Registration",
        aiSummary: aiSummary || null, checks, checkedAt: new Date().toISOString(),
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
      // Non-shelf: The prospectusIncorporatedDate is the gold standard — extracted from the actual 
      // update document (424B or POS AM) via LLM parsing. It is the FISCAL YEAR-END of the FS 
      // incorporated by reference in that update, NOT the filing date.
      // If prospectusIncorporatedDate is missing, check the REG STATEMENT ITSELF for IBR info
      // (for regs with no 424B/POS AM updates yet, the reg IS the live prospectus).
      // Forward IBR: latest annual is auto-incorporated.
      
      let annualFiscalYearEnd = null;
      let sourceInfo = null;

      if (hasForwardIBR && latestAnnual) {
        // Forward IBR overrides everything: the latest 10-K is automatically incorporated
        // regardless of what the 424B/POS AM scan found. 424B supplements are often short
        // documents that don't contain full FS — the LLM extraction is unreliable for them.
        annualFiscalYearEnd = latestAnnual.date;
        sourceInfo = `${latestAnnual.form} filing date ${latestAnnual.date} — auto-incorporated via forward IBR clause (takes precedence over prospectus supplement scan)`;
      } else if (prospectusIncorporatedDate) {
        // BEST CASE: LLM extracted actual fiscal year-end from prospectus supplement / POS AM
        annualFiscalYearEnd = prospectusIncorporatedDate;
        sourceInfo = `fiscal year-end ${prospectusIncorporatedDate} extracted from the live prospectus (${mostRecentEffectiveUpdate?.form} ${mostRecentEffectiveUpdate?.date})`;
      } else if (!mostRecentEffectiveUpdate && regIBRInfo?.specific_annual_incorporated && /^\d{4}-\d{2}-\d{2}$/.test(regIBRInfo.specific_annual_incorporated)) {
        // NO 424B/POS AM update exists: the REG STATEMENT ITSELF is the live prospectus
        // Extract FS date from the reg's IBR section
        annualFiscalYearEnd = regIBRInfo.specific_annual_incorporated;
        sourceInfo = `fiscal year-end ${regIBRInfo.specific_annual_incorporated} incorporated by reference in the original ${selectedReg.form} registration statement (${selectedReg.date})`;
      } else if (hasForwardIBR && latestAnnual) {
        // Forward IBR clause: latest annual report is auto-incorporated
        annualFiscalYearEnd = latestAnnual.date;
        sourceInfo = `${latestAnnual.form} filing date ${latestAnnual.date} — auto-incorporated via forward IBR clause`;
      } else if (mostRecentEffectiveUpdate && latestAnnual && new Date(latestAnnual.date) <= new Date(mostRecentEffectiveUpdate.date)) {
        // Latest annual is on or before the last update — use latest annual's date
        annualFiscalYearEnd = latestAnnual.date;
        sourceInfo = `${latestAnnual.form} filing date ${latestAnnual.date}`;
      } else if (mostRecentEffectiveUpdate) {
        // Last resort: use the filing date of the most recent update (424B or POS AM) as conservative proxy
        // IMPORTANT: This is a conservative lower bound. The actual fiscal year-end is earlier.
        annualFiscalYearEnd = mostRecentEffectiveUpdate.date;
        sourceInfo = `${mostRecentEffectiveUpdate.form} filing date ${mostRecentEffectiveUpdate.date} (conservative proxy—actual fiscal year-end is earlier)`;
      } else if (latestAnnual) {
        // No update after registration, but annual exists
        annualFiscalYearEnd = latestAnnual.date;
        sourceInfo = `${latestAnnual.form} filing date ${latestAnnual.date}`;
      } else {
        // Fall back to original registration
        annualFiscalYearEnd = selectedReg.date;
        sourceInfo = `Original registration filing date ${selectedReg.date}`;
      }

      if (!annualFiscalYearEnd) {
        const regAge = daysSince(selectedReg.date);
        if (regAge > ANNUAL_LIMIT) {
          fsStatus = "fail";
          fsFailCode = "section_10a3_audited_fs_older_than_16_months";
          fsDetail = `Section 10(a)(3)(ii): No financial statements can be located. Original registration FS from ${selectedReg.date} are ${regAge} days old — exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit. NOT CURRENT.`;
        } else {
          fsStatus = "pass";
          fsDetail = `Section 10(a)(3)(ii): No 424B or POS AM found. Original registration FS from ${selectedReg.date} are ${regAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month cap. See 9-month usability check below.`;
        }
      } else {
        const annualAge = daysSince(annualFiscalYearEnd);
        const interimAge = prospectusInterimPeriodEndDate ? daysSince(prospectusInterimPeriodEndDate) : null;
        const INTERIM_LIMIT = 274; // 9 months ≈ 274 days
        
        // Section 10(a)(3)(ii) is satisfied if EITHER annual or interim FS are current
        const annualCurrent = annualAge <= ANNUAL_LIMIT;
        const interimCurrent = interimAge !== null && interimAge <= INTERIM_LIMIT;
        
        if (!annualCurrent && !interimCurrent) {
          // Both stale
          fsStatus = "fail";
          fsFailCode = "section_10a3_audited_fs_older_than_16_months";
          fsDetail = `Section 10(a)(3)(ii): Audited annual FS have ${sourceInfo}, ${annualAge} days old (exceeds ${Math.round(ANNUAL_LIMIT/30)}-month limit)${interimAge ? `. Interim FS (${prospectusInterimPeriodEndDate}) are ${interimAge} days old (exceeds 9-month limit)` : ""}. Neither are current. NOT CURRENT.`;
        } else if (interimCurrent) {
          // Interim current (this satisfies Section 10(a)(3)(ii))
          fsStatus = "pass";
          fsDetail = `Section 10(a)(3)(ii): Interim FS as of ${prospectusInterimPeriodEndDate} are ${interimAge} days old — within 9-month limit. Section 10(a)(3)(ii) satisfied (interim FS currency does NOT require annual FS to be current). FS currency OK.`;
        } else {
          // Annual current, interim stale or missing
          fsStatus = "pass";
          fsDetail = `Section 10(a)(3)(ii): Audited annual FS have ${sourceInfo}, ${annualAge} days old — within ${Math.round(ANNUAL_LIMIT/30)}-month limit. FS currency OK.`;
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
          daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm,
          registrationNumber: regFileNumber || null,
          annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: 9,
          securitiesRegistered: securitiesRegistered || null },
        filingChain: filingChain.length > 0 ? filingChain : null,
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

    // ── CHECK C: Section 10(a)(3) — 9-month trigger + Rule 3-12 update test ──
    //
    // The 9-month clock is a TRIGGER, not a hard expiry:
    //   • Before 9 months: prospectus is usable as-is; no update required.
    //   • After 9 months: prospectus MAY still be used, BUT only if the financial
    //     information in it satisfies Rule 3-12 / the 16-month maximum age test
    //     (i.e., the FS in the prospectus are not older than 16 months AND are
    //     at least as current as the most recently filed periodic report on EDGAR).
    //
    // So the test is: past 9 months AND (no update OR update is stale / lagging)?
    //   → fail if the prospectus has NOT been updated to reflect current FS.
    //   → pass if updated with FS ≤ 16 months old AND ≥ as current as latest 10-K/10-Q.
    //   → pass (with note) if still within 9 months.
    //
    // For shelf OR forward-IBR non-shelf: IBR refreshes automatically.
    // For non-shelf without forward IBR: requires 424B supplement or effective POS AM.
    if (!isShelf) {
      if (daysSinceEffective <= SECTION_10A3_9_MONTHS) {
        // Still within 9-month window — no update required yet
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — 9-Month Update Trigger",
          status: "pass",
          detail: `Section 10(a)(3): Registration effective ${daysSinceEffective} days ago — still within the 9-month window. The 9-month clock has not yet triggered the requirement to update the prospectus with financial statements compliant with Rule 3-12 / the 16-month maximum age test.${hasForwardIBR ? " Forward IBR clause present — subsequent Exchange Act filings are auto-incorporated in any event." : ""}`,
          filingDate: null, filingUrl: null, filingForm: null,
        });
      } else if (hasForwardIBR) {
        // Past 9 months but forward IBR auto-incorporates all subsequent Exchange Act filings.
        // The 16-month FS age cap (already checked above as CHECK B) remains the binding test.
        const latestIncorporated = latestAnnual || latestQuarterly;
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — Post-9-Month Update Requirement (Forward IBR Satisfied)",
          status: "pass",
          detail: `Section 10(a)(3): Registration effective ${daysSinceEffective} days ago — past the 9-month trigger. Forward/automatic IBR clause in registration statement auto-incorporates all subsequent Exchange Act filings (10-K, 10-Q, 8-K), satisfying the Rule 3-12 / 16-month FS currency requirement without a separate 424B or POS AM. ${latestIncorporated ? `Most recent auto-incorporated filing: ${latestIncorporated.form} (${latestIncorporated.date}).` : ""}`,
          filingDate: latestIncorporated?.date || null, filingUrl: edgarUrl(latestIncorporated), filingForm: latestIncorporated?.form || null,
        });
      } else if (!mostRecentEffectiveUpdate) {
        // Past 9 months, no forward IBR, no update at all.
        // The prospectus must now be evaluated against Rule 3-12 / 16-month standards.
        // Since there is NO update whatsoever, the FS in the original prospectus are likely stale.
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — Post-9-Month Update Required: No Update Found",
          status: "fail",
          failCode: "prospectus_past_nine_months_no_update",
          detail: `Section 10(a)(3): Registration effective ${daysSinceEffective} days ago (${Math.round(daysSinceEffective/30)} months) — past the 9-month trigger. The prospectus must now be updated so that its financial information complies with Rule 3-12 (FS not older than 16 months and as current as the most recently filed annual/quarterly report). No 424B supplement, effective POS AM, or forward IBR clause found — the FS in the original prospectus have not been updated. File a 424B supplement or effective POS AM incorporating current financial statements.`,
          filingDate: null, filingUrl: null, filingForm: null,
        });
      } else {
        // Past 9 months AND an update exists.
        // Now apply Rule 3-12: the update must have FS that are (a) ≤ 16 months old AND
        // (b) at least as current as the most recently filed 10-K/10-Q on EDGAR.
        const updateDate = new Date(mostRecentEffectiveUpdate.date);
        const newerAnnual = latestAnnual && new Date(latestAnnual.date) > updateDate ? latestAnnual : null;
        const newerQuarterly = latestQuarterly && new Date(latestQuarterly.date) > updateDate ? latestQuarterly : null;

        if (newerAnnual) {
          // A newer annual report is on EDGAR but not yet incorporated — Rule 3-12 requires it
          checks.push({
            id: "section10a3_nine_month",
            label: "Section 10(a)(3) — Post-9-Month Rule 3-12 Gap: Annual FS Not Current",
            status: "fail",
            failCode: "section10a3_later_annual_not_incorporated",
            detail: `Section 10(a)(3) / Rule 3-12: Registration effective ${daysSinceEffective} days ago (past 9-month trigger). The prospectus was last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}, but a newer ${newerAnnual.form} (${newerAnnual.date}) was subsequently filed on EDGAR and has NOT been incorporated into the live prospectus. Rule 3-12 requires the prospectus to include annual financial statements that are at least as current as the most recently filed annual report. File a 424B supplement or effective POS AM incorporating the ${newerAnnual.form}.`,
            filingDate: newerAnnual.date, filingUrl: edgarUrl(newerAnnual), filingForm: newerAnnual.form,
          });
        } else if (newerQuarterly) {
          // A newer quarterly is on EDGAR but not yet incorporated — Rule 3-12 requires it
          checks.push({
            id: "section10a3_nine_month",
            label: "Section 10(a)(3) — Post-9-Month Rule 3-12 Gap: Interim FS Not Current",
            status: "fail",
            failCode: "section10a3_later_quarterly_not_incorporated",
            detail: `Section 10(a)(3) / Rule 3-12: Registration effective ${daysSinceEffective} days ago (past 9-month trigger). The prospectus was last updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}, but a newer ${newerQuarterly.form} (${newerQuarterly.date}) was subsequently filed on EDGAR and has NOT been incorporated. Rule 3-12 requires the prospectus to include interim financial statements at least as current as the most recently filed quarterly report. File a 424B supplement or effective POS AM incorporating the ${newerQuarterly.form}.`,
            filingDate: newerQuarterly.date, filingUrl: edgarUrl(newerQuarterly), filingForm: newerQuarterly.form,
          });
        } else {
          // Update exists AND covers the most current EDGAR filings — Rule 3-12 satisfied
          checks.push({
            id: "section10a3_nine_month",
            label: "Section 10(a)(3) — Post-9-Month Rule 3-12 FS Currency: Satisfied",
            status: "pass",
            detail: `Section 10(a)(3) / Rule 3-12: Registration effective ${daysSinceEffective} days ago (past 9-month trigger). Prospectus updated ${mostRecentEffectiveUpdate.date} via ${mostRecentEffectiveUpdate.form}${prospectusIncorporatedDate ? `, incorporating FS with fiscal year-end ${prospectusIncorporatedDate}` : ""}. No later 10-K or 10-Q on EDGAR postdates that update — the prospectus FS are as current as required by Rule 3-12. Section 10(a)(3) satisfied.`,
            filingDate: mostRecentEffectiveUpdate.date, filingUrl: edgarUrl(mostRecentEffectiveUpdate), filingForm: mostRecentEffectiveUpdate.form,
          });
        }
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
        ? `Non-shelf (${selectedReg.form}) WITH FORWARD IBR CLAUSE — Section 10(a)(3) / Item 512. Forward IBR auto-incorporates all subsequent Exchange Act filings. Hard cap: ${Math.round(ANNUAL_LIMIT/30)} months from fiscal year-end of audited FS.`
        : isFForm
          ? `F-form (${selectedReg.form}) — Section 10(a)(3) / Rule 3-12. The 9-month clock is a TRIGGER: before 9 months no update required; after 9 months the prospectus must be updated so its FS comply with Rule 3-12 (≤${Math.round(ANNUAL_LIMIT/30)} months old and as current as the most recent EDGAR filing). IBR NOT automatic without a forward IBR clause.`
          : `Domestic non-shelf (${selectedReg.form}) — Section 10(a)(3) / Rule 3-12 / Item 512. The 9-month clock is a TRIGGER, not an automatic expiry. Before 9 months: prospectus usable as-is. After 9 months: the prospectus must be updated so its financial information complies with Rule 3-12 — FS must be ≤${Math.round(ANNUAL_LIMIT/30)} months old AND as current as the most recently filed annual/quarterly report on EDGAR. No forward IBR — update requires 424B supplement or effective POS AM.`;

    const aiSummary = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: `Securities law compliance expert. This registration is ALREADY EFFECTIVE. Apply Section 10(a)(3) and Rule 3-12 post-effectiveness currency analysis.

CRITICAL FRAMING — Section 10(a)(3) correctly understood:
- The 9-month clock is a TRIGGER TEST, not an automatic expiry.
- Before 9 months from the effective date: prospectus is usable as-is; no update required.
- After 9 months: the prospectus MUST be updated so its financial information is (a) no older than ${Math.round(ANNUAL_LIMIT/30)} months (the 16-month maximum age test) AND (b) at least as current as the most recently filed annual/quarterly report on EDGAR (Rule 3-12 standard).
- A prospectus that is past 9 months old but HAS been validly updated with current FS IS current — do NOT say it is "not current" merely because it is past 9 months.

Framework: ${frameworkNote}

CURRENT = (a) audited FS ≤ ${Math.round(ANNUAL_LIMIT/30)} months old AND (b) if past 9-month trigger: prospectus has been updated with FS at least as current as latest EDGAR 10-K/10-Q. "fail" = NOT CURRENT. "warn" = usable but action needed soon. "pass" = CURRENT.

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

    // Build prospectus updates list (424B/POS AM only, for the checks section)
    const prospectusUpdates = allUpdatesWithThisFileNumber.map(f => ({
      form: f.form,
      date: f.date,
      fileNumber: f.fileNumber,
      url: edgarUrl(f),
      accession: f.accession
    }));

    return Response.json({
      mode: "detail", ticker: ticker.toUpperCase(), cik, companyName,
      registration: { form: selectedReg.form, date: selectedReg.date, accession: selectedReg.accession,
        daysOld: regDays, url: edgarUrl(selectedReg), isShelf, isFPI, isFForm,
        registrationNumber: regFileNumber || null,
        annualLimitMonths: Math.round(ANNUAL_LIMIT / 30), interimLimitMonths: 9,
        securitiesRegistered: securitiesRegistered || null },
      filingChain: filingChain.length > 0 ? filingChain : null,
      overallStatus, stage: "post_effective", applicableRule: "Section 10(a)(3) / Item 512",
      aiSummary: aiSummary || null, checks,
      checkedAt: new Date().toISOString(),
    });

  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});