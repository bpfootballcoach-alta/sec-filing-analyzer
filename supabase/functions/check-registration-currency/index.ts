const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const EDGAR_BASE = "https://data.sec.gov/submissions";
const HEADERS = { "User-Agent": "SEC-Filing-Analyzer contact@example.com" };

let _lastFetchTime = 0;
const secFetch = async (url: string, opts: RequestInit = {}): Promise<Response> => {
  const now = Date.now();
  const wait = 125 - (now - _lastFetchTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastFetchTime = Date.now();
  return fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers as Record<string, string> || {}) } });
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { ticker } = await req.json();
    if (!ticker) {
      return new Response(JSON.stringify({ error: "ticker is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 1: Resolve ticker -> CIK
    const tickerRes = await secFetch("https://www.sec.gov/files/company_tickers.json", { headers: HEADERS });
    const tickerData = await tickerRes.json();

    let cik: string | null = null;
    let companyName: string | null = null;
    for (const entry of Object.values(tickerData as Record<string, { ticker: string; cik_str: number; title: string }>)) {
      if (entry.ticker?.toUpperCase() === ticker.toUpperCase()) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title;
        break;
      }
    }

    if (!cik) {
      return new Response(JSON.stringify({ error: `Could not find CIK for ticker: ${ticker}` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Step 2: Fetch all filings
    const subRes = await secFetch(`${EDGAR_BASE}/CIK${cik}.json`, { headers: HEADERS });
    if (!subRes.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch EDGAR submissions" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const subData = await subRes.json();

    let allForms: string[] = [], allDates: string[] = [], allAccessions: string[] = [], allPrimaryDocs: string[] = [], allSizes: number[] = [];
    const recent = subData.filings?.recent || {};
    allForms = recent.form || [];
    allDates = recent.filingDate || [];
    allAccessions = recent.accessionNumber || [];
    allPrimaryDocs = recent.primaryDocument || [];
    allSizes = recent.size || [];

    const files = subData.filings?.files || [];
    for (const f of files) {
      const pageRes = await secFetch(`https://data.sec.gov${f.name}`, { headers: HEADERS });
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

    const daysSince = (dateStr: string | null) => {
      if (!dateStr) return null;
      return Math.floor((today.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
    };

    const findLatest = (formTypes: string[]) =>
      filings.find((f) => formTypes.some((t) => f.form?.toUpperCase() === t.toUpperCase() || f.form?.toUpperCase().startsWith(t.toUpperCase() + "/")));

    const findAll = (formTypes: string[]) =>
      filings.filter((f) => formTypes.some((t) => f.form?.toUpperCase() === t.toUpperCase() || f.form?.toUpperCase().startsWith(t.toUpperCase() + "/")));

    const edgarUrl = (f: { accession: string; doc: string } | null) =>
      f ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik!)}/${f.accession.replace(/-/g, "")}/${f.doc}` : null;

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

    const annualDays = daysSince(latestAnnual?.date || null);
    const quarterlyDays = daysSince(latestQuarterly?.date || null);
    const currentDays = daysSince(latestCurrent?.date || null);

    // --- CHECK 1: Annual Report current? ---
    let annualStatus: string, annualDetail: string;
    if (!latestAnnual) {
      annualStatus = "fail";
      annualDetail = `No ${annualFormTypes[0]} found on EDGAR. Company is not current on its annual reporting obligation.`;
    } else if (annualDays! > 455) {
      annualStatus = "fail";
      annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). Company appears delinquent.`;
    } else if (annualDays! > 365) {
      annualStatus = "warn";
      annualDetail = `Last ${latestAnnual.form} was filed ${annualDays} days ago (${latestAnnual.date}). A new annual report may be coming due.`;
    } else {
      annualStatus = "pass";
      annualDetail = `${latestAnnual.form} filed ${annualDays} days ago on ${latestAnnual.date}. Annual reporting is current.`;
    }

    // --- CHECK 2: Quarterly Reports current? ---
    let quarterlyStatus: string, quarterlyDetail: string;
    if (isFPI) {
      quarterlyStatus = "info";
      quarterlyDetail = "Foreign Private Issuer — quarterly 10-Q not required; 6-K used for interim updates.";
    } else {
      const annualDate = latestAnnual ? new Date(latestAnnual.date) : null;
      const quartersFiledSinceAnnual = annualDate
        ? filings.filter(f => f.form === "10-Q" && new Date(f.date) > annualDate).length
        : 0;

      let expectedQuarters = 0;
      if (annualDays !== null) {
        if (annualDays > 270) expectedQuarters = 3;
        else if (annualDays > 180) expectedQuarters = 2;
        else if (annualDays > 90) expectedQuarters = 1;
        else expectedQuarters = 0;
      }

      if (!annualDate) {
        quarterlyStatus = "warn";
        quarterlyDetail = "Cannot determine 10-Q currency without a filed 10-K.";
      } else if (expectedQuarters === 0) {
        quarterlyStatus = "pass";
        quarterlyDetail = `10-K was filed ${annualDays} days ago. No quarterly report due yet.`;
      } else if (quartersFiledSinceAnnual >= expectedQuarters) {
        quarterlyStatus = "pass";
        quarterlyDetail = `${quartersFiledSinceAnnual} of ${expectedQuarters} expected 10-Q(s) filed since last 10-K. Quarterly reporting is current.`;
      } else {
        const missing = expectedQuarters - quartersFiledSinceAnnual;
        quarterlyStatus = "fail";
        quarterlyDetail = `Only ${quartersFiledSinceAnnual} of ${expectedQuarters} expected 10-Q(s) filed since the last 10-K. ${missing} quarterly report(s) appear missing.`;
      }
    }

    // --- CHECK 3: Current Reports (8-K) ---
    let currentStatus: string, currentDetail: string;
    if (!latestCurrent) {
      currentStatus = "warn";
      currentDetail = `No ${currentFormTypes[0]} current reports found on EDGAR.`;
    } else if (currentDays! > 365) {
      currentStatus = "warn";
      currentDetail = `Last ${latestCurrent.form} was filed ${currentDays} days ago. No recent current event filings.`;
    } else {
      currentStatus = "pass";
      currentDetail = `Most recent ${latestCurrent.form} filed ${currentDays} days ago on ${latestCurrent.date}.`;
    }

    // --- CHECK 4: Section 10(a)(3) Prospectus Currency ---
    const allRegistrationForms = findAll(["S-1", "S-3", "F-1", "F-3", "S-11"]);
    const latestRegistration = allRegistrationForms[0] || null;
    const allProspectusForms = findAll(["424B", "PROSPECTUS"]);
    const latestProspectus = allProspectusForms[0] || null;
    const prospectusDays = daysSince(latestProspectus?.date || null);

    const oldestFiling = filings[filings.length - 1];
    const reportingHistoryDays = daysSince(oldestFiling?.date || null);
    const hasMinReportingHistory = reportingHistoryDays! >= 365;

    const isCurrentFiler = annualStatus !== "fail" && quarterlyStatus !== "fail";
    const hasNTFilings = filings.some(f => f.form?.startsWith("NT "));

    let prospectusStatus: string, prospectusDetail: string;

    if (!latestRegistration) {
      prospectusStatus = "info";
      prospectusDetail = "No registration statement (S-1, S-3, F-1, F-3) found on EDGAR. Section 10(a)(3) not applicable.";
    } else {
      const regType = latestRegistration.form.toUpperCase();
      const isShelf = regType.includes("S-3") || regType.includes("F-3");
      const regDays = daysSince(latestRegistration.date);

      if (isShelf) {
        if (!isCurrentFiler) {
          prospectusStatus = "fail";
          prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) found, but the company is NOT current in its Exchange Act reporting. Shelf prospectus is STALE.`;
        } else if (latestAnnual && new Date(latestAnnual.date) > new Date(latestRegistration.date)) {
          prospectusStatus = "pass";
          prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) is automatically updated via incorporation by reference of the latest ${latestAnnual.form} (${latestAnnual.date}). Prospectus is current.`;
        } else if (!latestAnnual) {
          prospectusStatus = "fail";
          prospectusDetail = `Shelf registration found but no annual report has been filed. Shelf prospectus is STALE.`;
        } else {
          prospectusStatus = "warn";
          prospectusDetail = `Shelf registration (${latestRegistration.form}, ${latestRegistration.date}) filed but no subsequent annual report found to auto-incorporate. Currency uncertain.`;
        }
      } else {
        const nineMonths = 274;
        const latestAmendment = findLatest([`${regType.split("/")[0]}/A`, "424B"]);
        const amendmentDays = daysSince(latestAmendment?.date || null);

        if (!isCurrentFiler) {
          prospectusStatus = "fail";
          prospectusDetail = `Non-shelf registration (${latestRegistration.form}, ${latestRegistration.date}) found. Company is NOT current in Exchange Act reporting. Prospectus is STALE.`;
        } else if (!latestProspectus && regDays! > nineMonths) {
          prospectusStatus = "fail";
          prospectusDetail = `Non-shelf registration (${latestRegistration.form}, ${latestRegistration.date}) is ${regDays} days old with no 424B prospectus or amendment. Prospectus appears STALE.`;
        } else if (latestProspectus && prospectusDays! > nineMonths) {
          if (latestAmendment && amendmentDays! <= nineMonths) {
            prospectusStatus = "pass";
            prospectusDetail = `Non-shelf registration updated via ${latestAmendment.form} filed ${amendmentDays} days ago. Prospectus is current.`;
          } else {
            prospectusStatus = "fail";
            prospectusDetail = `Last prospectus/424B was ${prospectusDays} days ago. Prospectus appears STALE — a post-effective amendment or new 424B is required.`;
          }
        } else if (latestProspectus) {
          prospectusStatus = "pass";
          prospectusDetail = `Most recent prospectus/424B filed ${prospectusDays} days ago on ${latestProspectus.date}. Within the 9-month window.`;
        } else {
          prospectusStatus = "warn";
          prospectusDetail = `Registration statement found but no 424B prospectus on record. Verify Section 10(a)(3) compliance.`;
        }
      }
    }

    // --- CHECK 5: S-3 / Shelf Eligibility ---
    let eligibilityStatus: string, eligibilityDetail: string;
    const eligibilityIssues: string[] = [];

    if (!hasMinReportingHistory) {
      eligibilityIssues.push(`Has not been an Exchange Act reporting company for 12 months (${reportingHistoryDays} days on record)`);
    }
    if (!isCurrentFiler) {
      eligibilityIssues.push("Is NOT current in all required Exchange Act filings");
    }
    if (!latestAnnual) {
      eligibilityIssues.push("Has not filed a 10-K annual report");
    }
    if (hasNTFilings) {
      eligibilityIssues.push("Has NT (non-timely) filings on record");
    }

    if (eligibilityIssues.length === 0) {
      eligibilityStatus = "pass";
      eligibilityDetail = `Company appears to meet the baseline eligibility requirements for S-3 registration and Section 10(a)(3) automatic prospectus updating.`;
    } else {
      eligibilityStatus = "fail";
      eligibilityDetail = `Company does NOT fully meet S-3/Section 10(a)(3) eligibility requirements:\n- ${eligibilityIssues.join("\n- ")}`;
    }

    const overallStatus =
      [annualStatus, quarterlyStatus, prospectusStatus, eligibilityStatus].includes("fail") ? "fail" :
      [annualStatus, quarterlyStatus, prospectusStatus, eligibilityStatus].includes("warn") ? "warn" : "pass";

    return new Response(JSON.stringify({
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
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
