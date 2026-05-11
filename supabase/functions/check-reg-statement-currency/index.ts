const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const HEADERS: Record<string, string> = {
  "User-Agent": "SEC-Filing-Analyzer legal-research@example.com",
  "Accept": "application/json, text/html, */*",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};
const EDGAR_BASE = "https://data.sec.gov/submissions";

let _lastFetchTime = 0;
const secFetch = async (url: string, opts: RequestInit = {}): Promise<Response> => {
  const now = Date.now();
  const wait = 125 - (now - _lastFetchTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastFetchTime = Date.now();
  return fetch(url, { ...opts, headers: { ...HEADERS, ...(opts.headers as Record<string, string> || {}) } });
};

const daysSince = (dateStr: string | null): number | null => {
  if (!dateStr) return null;
  return Math.floor((new Date().getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
};

const REG_FORMS = ["S-1", "S-3", "F-1", "F-3", "F-4", "S-11", "S-4", "S-8"];
const AMENDMENT_FORMS = ["S-1/A", "S-3/A", "F-1/A", "F-3/A", "S-4/A", "S-11/A"];
const POST_EFFECTIVE_FORMS = ["POS AM", "POS AM/A"];
const PROSPECTUS_FORMS = ["424B1", "424B2", "424B3", "424B4", "424B5", "424B7", "424B8", "PROSPECTUS"];

const isRegStatementForm = (form: string) => {
  const f = form?.toUpperCase().trim();
  return REG_FORMS.some(r => f === r || f === r + "/A" || f.startsWith(r + "/"));
};

const isProspectusOrPosAm = (f: { form: string }) =>
  PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) ||
  POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim());

const parseFileNumFeed = (xml: string, cik: string) => {
  const entries: Array<{ accNo: string; date: string; form: string; indexUrl: string }> = [];
  const entryBlocks = xml.split(/<entry[\s>]/i);
  for (const block of entryBlocks.slice(1)) {
    const accNo = (block.match(/<accession-number>([\d-]+)<\/accession-number>/i) || [])[1];
    const date = (block.match(/<filing-date>(\d{4}-\d{2}-\d{2})<\/filing-date>/i) || [])[1];
    const href = (block.match(/<filing-href>(https?:\/\/[^<]+)<\/filing-href>/i) || [])[1];
    const form = (block.match(/<filing-type>([^<]+)<\/filing-type>/i) || [])[1]?.trim().toUpperCase();
    if (!accNo || !date || !form) continue;
    entries.push({ accNo, date, form, indexUrl: href || `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accNo.replace(/-/g, "")}/${accNo}-index.htm` });
  }
  return entries;
};

interface FilingEntry {
  form: string; date: string; accession: string; doc: string;
  cik: string; fileNumber: string | null; description: string | null; size: number;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { ticker, accession } = body;
    if (!ticker) {
      return new Response(JSON.stringify({ error: "ticker is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tickerUpper = ticker.toUpperCase();

    // Resolve ticker -> CIK
    const tickerRes = await secFetch("https://www.sec.gov/files/company_tickers.json");
    const tickerExRes = await secFetch("https://www.sec.gov/files/company_tickers_exchange.json");
    const tickerData = await tickerRes.json();
    const tickerExData = tickerExRes.ok ? await tickerExRes.json() : null;

    let cik: string | null = null, companyName: string | null = null;
    for (const entry of Object.values(tickerData as Record<string, { ticker: string; cik_str: number; title: string }>)) {
      if (entry.ticker?.toUpperCase() === tickerUpper) {
        cik = String(entry.cik_str).padStart(10, "0");
        companyName = entry.title;
        break;
      }
    }
    if (!cik && (tickerExData as any)?.data) {
      for (const row of (tickerExData as any).data) {
        if (row[2]?.toUpperCase() === tickerUpper) {
          cik = String(row[0]).padStart(10, "0");
          companyName = row[1];
          break;
        }
      }
    }
    if (!cik) {
      return new Response(JSON.stringify({ error: `Could not find CIK for ticker: ${ticker}` }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all EDGAR filings
    const mergeFilingPage = (acc: FilingEntry[], page: any) => {
      const forms = page.form || [], dates = page.filingDate || [],
        accessions = page.accessionNumber || [], docs = page.primaryDocument || [],
        fileNumbers = page.fileNumber || [], descriptions = page.primaryDocDescription || [],
        sizes = page.size || [];
      for (let i = 0; i < forms.length; i++) {
        if (forms[i] && dates[i]) {
          acc.push({
            form: forms[i], date: dates[i], accession: accessions[i], doc: docs[i],
            cik, fileNumber: fileNumbers[i] || null, description: descriptions[i] || null, size: sizes[i] || 0,
          });
        }
      }
      return acc;
    };

    const subRes = await secFetch(`${EDGAR_BASE}/CIK${cik}.json`);
    if (!subRes.ok) {
      return new Response(JSON.stringify({ error: "Failed to fetch EDGAR submissions" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const subData = await subRes.json();
    if (subData.name) companyName = subData.name;

    let filings: FilingEntry[] = [];
    mergeFilingPage(filings, subData.filings?.recent || {});
    const additionalFiles = subData.filings?.files || [];
    for (const f of additionalFiles) {
      const pageRes = await secFetch(`https://data.sec.gov/submissions/${f.name}`);
      if (pageRes.ok) mergeFilingPage(filings, await pageRes.json());
    }

    const edgarUrl = (f: FilingEntry | null) => {
      if (!f) return null;
      const accClean = f.accession?.replace(/-/g, "");
      if (!accClean) return null;
      if (f.doc && f.doc.trim()) {
        return `https://www.sec.gov/Archives/edgar/data/${parseInt(f.cik || cik)}/${accClean}/${f.doc}`;
      }
      return `https://www.sec.gov/Archives/edgar/data/${parseInt(f.cik || cik)}/${accClean}/${accClean}-index.htm`;
    };

    const effectFilings = filings.filter(f => f.form?.toUpperCase().trim() === "EFFECT");

    const isLikelyEffective = (regFiling: FilingEntry, feedEffects: Array<{ date: string }> | null) => {
      const form = regFiling.form?.toUpperCase().trim();
      if (form === "S-8" || form?.includes("S-3") || form?.includes("F-3")) {
        return { effective: true, reason: `${form} auto-effective upon filing under Rule 462`, effectDate: regFiling.date };
      }
      const regDate = new Date(regFiling.date);
      const fileNum = regFiling.fileNumber || null;

      if (feedEffects && feedEffects.length > 0) {
        const hit = feedEffects.find(e => new Date(e.date) >= regDate);
        if (hit) return { effective: true, reason: `EFFECT notice ${hit.date} (file no. ${fileNum})`, effectDate: hit.date };
      }

      const effectAfter = effectFilings.find(e => {
        const eDate = new Date(e.date);
        if (eDate < regDate || (eDate.getTime() - regDate.getTime()) >= 365 * 24 * 60 * 60 * 1000) return false;
        if (fileNum && e.fileNumber) return e.fileNumber === fileNum;
        return true;
      });
      if (effectAfter) return { effective: true, reason: `EFFECT notice filed ${effectAfter.date}`, effectDate: effectAfter.date };

      const sameReg = (f: FilingEntry) => (!fileNum || !f.fileNumber) ? true : f.fileNumber === fileNum;
      const prospectusAfter = filings.find(f => {
        const fDate = new Date(f.date);
        return fDate > regDate && PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p)) && sameReg(f);
      });
      if (prospectusAfter) return { effective: true, reason: `424B prospectus filed ${prospectusAfter.date}`, effectDate: prospectusAfter.date };

      return { effective: false, reason: "No EFFECT notice or 424B prospectus found" };
    };

    // Collect ALL registration-related filings
    const allRegFilings = filings.filter(f => {
      const form = f.form?.toUpperCase().trim();
      return REG_FORMS.some(r => form === r || form === r + "/A" || form.startsWith(r + "/"));
    });

    // Group by file number
    const regGroups = new Map<string, FilingEntry[]>();
    for (const f of allRegFilings) {
      const key = f.fileNumber || f.accession;
      if (!regGroups.has(key)) regGroups.set(key, []);
      regGroups.get(key)!.push(f);
    }

    const regFilings = [...regGroups.values()].map(group => {
      group.sort((a, b) => b.date.localeCompare(a.date));
      const rep = { ...group[0] };
      (rep as any)._originalDate = group[group.length - 1].date;
      (rep as any)._originalAccession = group[group.length - 1].accession;
      (rep as any)._amendmentCount = group.length - 1;
      return rep;
    });
    regFilings.sort((a, b) => b.date.localeCompare(a.date));

    // --- LIST MODE ---
    if (!accession) {
      return new Response(JSON.stringify({
        mode: "list", ticker: ticker.toUpperCase(), cik, companyName,
        registrationStatements: regFilings.map(f => {
          const eff = isLikelyEffective(f, null);
          return {
            form: f.form, date: f.date, accession: f.accession, doc: f.doc, url: edgarUrl(f),
            daysOld: daysSince(f.date), effective: eff.effective, effectiveReason: eff.reason,
            effectDate: eff.effectDate || null, registrationNumber: f.fileNumber || null,
            amendmentCount: (f as any)._amendmentCount || 0,
            originalDate: (f as any)._originalDate || f.date,
            description: f.description || null,
          };
        }),
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // --- DETAIL MODE ---
    const clickedFiling = filings.find(f => f.accession === accession);
    const resolvedFileNum = clickedFiling?.fileNumber || null;
    const resolvedRep = resolvedFileNum
      ? regFilings.find(f => f.fileNumber === resolvedFileNum)
      : regFilings.find(f => f.accession === accession);
    const resolvedAccession = resolvedRep?.accession || accession;

    const selectedReg = filings.find(f => f.accession === resolvedAccession) || filings.find(f => f.accession === accession);
    if (!selectedReg) {
      return new Response(JSON.stringify({ error: "Registration statement not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const regDate = new Date(selectedReg.date);
    const regDays = daysSince(selectedReg.date);
    const regType = selectedReg.form?.toUpperCase();
    const isShelf = regType.includes("S-3") || regType.includes("F-3");
    const isFForm = regType.startsWith("F-");
    const isSorFFourBase = (regType === "S-4" || regType === "S-4/A" || regType === "F-4" || regType === "F-4/A");

    const has20F = filings.some(f => f.form === "20-F" || f.form === "20-F/A");
    const has10K = filings.some(f => f.form === "10-K");
    const isFPI = has20F && !has10K;

    const priorExchangeActFilings = filings.filter(f => {
      const fDate = new Date(f.date);
      return fDate < regDate &&
        (f.form === "10-K" || f.form === "20-F" || f.form === "10-Q" || f.form?.startsWith("8-K") || f.form === "6-K");
    });
    const isExchangeActReporterBeforeFiling = priorExchangeActFilings.length > 0;

    const subsequentFilings = filings.filter(f => new Date(f.date) > regDate);
    const regFileNumber = selectedReg.fileNumber || null;

    // Authoritative lookup by file number
    let allFileNumEntries: Array<{ accNo: string; date: string; form: string; indexUrl: string }> = [];
    if (regFileNumber) {
      try {
        const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&filenum=${encodeURIComponent(regFileNumber)}&type=&dateb=&owner=include&count=100&search_text=&output=atom`;
        const res = await secFetch(url);
        if (res.ok) {
          allFileNumEntries = parseFileNumFeed(await res.text(), cik);
        }
      } catch (_) { /* proceed with empty */ }
    }

    const fileNumEffectFilings = allFileNumEntries
      .filter(e => e.form === "EFFECT")
      .map(e => ({ form: e.form, date: e.date, accession: e.accNo, fileNumber: regFileNumber, cik, indexUrl: e.indexUrl }));

    const allUpdatesWithThisFileNumber = allFileNumEntries
      .filter(e => isProspectusOrPosAm({ form: e.form }))
      .map(e => ({ form: e.form, date: e.date, accession: e.accNo, doc: "", fileNumber: regFileNumber, cik, indexUrl: e.indexUrl }))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Build filing chain
    const buildFilingChain = () => {
      const feedEntries = allFileNumEntries
        .filter(e => e.form !== "UPLOAD")
        .sort((a, b) => a.date.localeCompare(b.date));
      const feedAccNosSet = new Set(feedEntries.map(e => e.accNo));
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

    // POS AM effectiveness
    const isPosAmEffectiveFromFeed = (posAm: { date: string }) => {
      const posDate = new Date(posAm.date);
      return fileNumEffectFilings.some(e => {
        const eDate = new Date(e.date);
        return eDate >= posDate && (eDate.getTime() - posDate.getTime()) <= 60 * 24 * 60 * 60 * 1000;
      });
    };

    const allPostEffectiveAmendments = allUpdatesWithThisFileNumber.filter(f =>
      POST_EFFECTIVE_FORMS.includes(f.form?.toUpperCase().trim())
    );
    const effectivePostEffectiveAmendments = allPostEffectiveAmendments.filter(isPosAmEffectiveFromFeed);
    const pendingPostEffectiveAmendments = allPostEffectiveAmendments.filter(f => !isPosAmEffectiveFromFeed(f));
    const latestPostEffective = effectivePostEffectiveAmendments[0] || null;
    const latestPendingPosAm = pendingPostEffectiveAmendments[0] || null;

    const prospectuses = allUpdatesWithThisFileNumber.filter(f =>
      PROSPECTUS_FORMS.some(p => f.form?.toUpperCase().startsWith(p))
    );
    const latestProspectus = prospectuses[0] || null;

    const effectiveness = isLikelyEffective(selectedReg, fileNumEffectFilings);
    const effectiveDate = effectiveness.effective && effectiveness.effectDate ? new Date(effectiveness.effectDate) : regDate;
    const daysSinceEffective = Math.floor((new Date().getTime() - effectiveDate.getTime()) / (1000 * 60 * 60 * 24));

    const annuals = subsequentFilings.filter(f =>
      f.form === "10-K" || f.form === "20-F" || f.form === "10-K/A" || f.form === "20-F/A"
    );
    const latestAnnual = annuals[0] || null;

    const quarterlies = subsequentFilings.filter(f => f.form === "10-Q" || f.form === "10-Q/A");
    const latestQuarterly = quarterlies[0] || null;

    const currentReports = subsequentFilings.filter(f => f.form?.startsWith("8-K"));
    const latestCurrent = currentReports[0] || null;

    const mostRecentEffectiveUpdate = (() => {
      if (!latestPostEffective && !latestProspectus) return null;
      if (!latestPostEffective) return latestProspectus;
      if (!latestProspectus) return latestPostEffective;
      return new Date(latestProspectus.date) > new Date(latestPostEffective.date)
        ? latestProspectus : latestPostEffective;
    })();

    // Fetch the registration document for IBR analysis
    let regDocText: string | null = null;
    if (selectedReg?.doc) {
      try {
        const regDocUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${resolvedAccession.replace(/-/g, "")}/${selectedReg.doc}`;
        const regDocRes = await secFetch(regDocUrl);
        if (regDocRes.ok) {
          regDocText = await regDocRes.text();
        }
      } catch (_) { /* non-critical */ }
    }

    // Return all the data needed for the frontend to run the compliance checks and LLM analysis
    return new Response(JSON.stringify({
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
        registrationNumber: regFileNumber || null,
        annualLimitMonths: isFForm ? 15 : 16,
        interimLimitMonths: 9,
      },
      filingChain: filingChain.length > 0 ? filingChain : null,
      effectiveness: {
        effective: effectiveness.effective,
        reason: effectiveness.reason,
        effectDate: effectiveness.effectDate || null,
        daysSinceEffective,
      },
      isExchangeActReporterBeforeFiling,
      isFPI,
      isShelf,
      isFForm,
      isSorFFourBase,
      regDocText, // raw HTML of the registration document for LLM analysis
      latestAnnual: latestAnnual ? { form: latestAnnual.form, date: latestAnnual.date, url: edgarUrl(latestAnnual) } : null,
      latestQuarterly: latestQuarterly ? { form: latestQuarterly.form, date: latestQuarterly.date, url: edgarUrl(latestQuarterly) } : null,
      latestCurrent: latestCurrent ? { form: latestCurrent.form, date: latestCurrent.date, url: edgarUrl(latestCurrent) } : null,
      latestProspectus: latestProspectus ? { form: latestProspectus.form, date: latestProspectus.date, url: latestProspectus?.indexUrl || null } : null,
      latestPostEffective: latestPostEffective ? { form: latestPostEffective.form, date: latestPostEffective.date } : null,
      latestPendingPosAm: latestPendingPosAm ? { form: latestPendingPosAm.form, date: latestPendingPosAm.date } : null,
      allPostEffectiveAmendments: allPostEffectiveAmendments.map(f => ({ form: f.form, date: f.date, accession: f.accession })),
      effectivePostEffectiveAmendments: effectivePostEffectiveAmendments.map(f => ({ form: f.form, date: f.date, accession: f.accession })),
      prospectuses: prospectuses.map(f => ({ form: f.form, date: f.date, accession: f.accession })),
      mostRecentEffectiveUpdate: mostRecentEffectiveUpdate ? { form: mostRecentEffectiveUpdate.form, date: mostRecentEffectiveUpdate.date } : null,
      subsequentFilingsCount: subsequentFilings.length,
      quarterliesSinceReg: quarterlies.length,
      currentReportsSinceReg: currentReports.length,
      checkedAt: new Date().toISOString(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
