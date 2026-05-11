import { llm, getGeminiApiKey } from "@/api/apiClient";

const daysSince = (dateStr) => {
  if (!dateStr) return null;
  return Math.floor((new Date() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
};

const SECTION_10A3_16_MONTHS = 487;
const SECTION_10A3_9_MONTHS = 274;
const RULE_312_DAYS_OTHERS = 135;
const RULE_312_DAYS_NON_REPORTING = 410;

export function buildRegStatementChecks(data) {
  const {
    effectiveness,
    isShelf,
    isFPI,
    isFForm,
    isExchangeActReporterBeforeFiling,
    registration,
    latestAnnual,
    latestQuarterly,
    latestCurrent,
    latestProspectus,
    latestPostEffective,
    allPostEffectiveAmendments,
    effectivePostEffectiveAmendments,
    quarterliesSinceReg,
    currentReportsSinceReg,
  } = data;

  const ANNUAL_LIMIT = isFForm ? 456 : SECTION_10A3_16_MONTHS;
  const annualFormLabel = isFPI ? "20-F" : "10-K";
  const checks = [];

  // CHECK: Effectiveness
  if (!effectiveness.effective) {
    checks.push({
      id: "effectiveness",
      label: "Registration Statement — Not Yet Effective (Rule 3-12 Analysis)",
      status: "info",
      detail: `Registration not yet effective. ${effectiveness.reason}. Applying Rule 3-12 pre-effectiveness analysis.`,
      filingDate: null, filingUrl: null, filingForm: null,
    });

    // Rule 3-12 pre-effectiveness
    let rule312Days, rule312Basis;
    if (isFPI) {
      rule312Days = null;
      rule312Basis = "FPI carve-out";
    } else if (!isExchangeActReporterBeforeFiling) {
      rule312Days = RULE_312_DAYS_NON_REPORTING;
      rule312Basis = "not subject to Exchange Act reporting immediately before filing (1 year + 45 days)";
    } else {
      rule312Days = RULE_312_DAYS_OTHERS;
      rule312Basis = "Exchange Act reporter — applying 135-day threshold";
    }

    if (isFPI) {
      checks.push({
        id: "rule312_preeffective",
        label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
        status: "info",
        detail: "FPI carve-out: Foreign Private Issuers are not subject to Rule 3-12. Manual review required.",
        filingDate: latestAnnual?.date || null, filingUrl: latestAnnual?.url || null, filingForm: latestAnnual?.form || null,
      });
    } else if (!latestAnnual) {
      checks.push({
        id: "rule312_preeffective",
        label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
        status: "info",
        detail: `No prior ${annualFormLabel} found on EDGAR. Cannot automatically assess Rule 3-12.`,
        filingDate: null, filingUrl: null, filingForm: null,
      });
    } else {
      const priorAnnualAge = daysSince(latestAnnual.date);
      const r312Status = priorAnnualAge > rule312Days ? "fail" : "pass";
      checks.push({
        id: "rule312_preeffective",
        label: "Rule 3-12 Pre-Effectiveness Financial Statement Currency",
        status: r312Status,
        detail: r312Status === "fail"
          ? `Rule 3-12: ${annualFormLabel} filed ${priorAnnualAge} days ago exceeds ${rule312Days}-day threshold (${rule312Basis}). Financial statements may be too stale for effectiveness.`
          : `Rule 3-12: ${annualFormLabel} filed ${priorAnnualAge} days ago — within ${rule312Days}-day threshold. Financial statements appear current.`,
        filingDate: latestAnnual.date, filingUrl: latestAnnual.url, filingForm: latestAnnual.form,
      });
    }

    const overallStatus = checks.some(c => c.status === "fail") ? "fail" :
      checks.some(c => c.status === "warn") ? "warn" : "pass";

    return { checks, overallStatus, stage: "pre_effective", applicableRule: "Rule 3-12" };
  }

  // EFFECTIVE — Apply Section 10(a)(3)
  checks.push({
    id: "effectiveness",
    label: "Registration Statement Declared Effective",
    status: "pass",
    detail: `Registration effective per ${effectiveness.reason}. Applying Section 10(a)(3) / Item 512 post-effectiveness analysis.`,
    filingDate: effectiveness.effectDate || null, filingUrl: null, filingForm: null,
  });

  // CHECK: Audited FS Age (16-month cap)
  const annualFiscalYearEnd = latestAnnual?.date || null;
  if (!annualFiscalYearEnd) {
    checks.push({
      id: "section10a3_annual_fs",
      label: `Section 10(a)(3)(ii) — Audited FS Age (${Math.round(ANNUAL_LIMIT / 30)}-month cap)`,
      status: "fail",
      detail: `No ${annualFormLabel} filed after registration — no financials incorporated via IBR. NOT CURRENT.`,
      filingDate: null, filingUrl: null, filingForm: null,
    });
  } else {
    const annualAge = daysSince(annualFiscalYearEnd);
    const fsStatus = annualAge > ANNUAL_LIMIT ? "fail" : "pass";
    checks.push({
      id: "section10a3_annual_fs",
      label: `Section 10(a)(3)(ii) — Audited FS Age (${Math.round(ANNUAL_LIMIT / 30)}-month cap from fiscal year-end)`,
      status: fsStatus,
      detail: fsStatus === "fail"
        ? `Section 10(a)(3)(ii): ${annualFormLabel} (${annualFiscalYearEnd}) is ${annualAge} days old — exceeds ${Math.round(ANNUAL_LIMIT / 30)}-month limit. NOT CURRENT.`
        : `Section 10(a)(3)(ii): ${annualFormLabel} (${annualFiscalYearEnd}) is ${annualAge} days old — within ${Math.round(ANNUAL_LIMIT / 30)}-month limit. IBR ${isShelf ? "auto-incorporates via shelf" : "applies"}.`,
      filingDate: latestAnnual.date, filingUrl: latestAnnual.url, filingForm: latestAnnual.form,
    });
  }

  // CHECK: 9-month trigger
  if (!isShelf) {
    if (effectiveness.daysSinceEffective <= SECTION_10A3_9_MONTHS) {
      checks.push({
        id: "section10a3_nine_month",
        label: "Section 10(a)(3) — 9-Month Update Trigger",
        status: "pass",
        detail: `Registration effective ${effectiveness.daysSinceEffective} days ago — still within the 9-month window. No update required yet.`,
        filingDate: null, filingUrl: null, filingForm: null,
      });
    } else if (!latestProspectus && !latestPostEffective) {
      checks.push({
        id: "section10a3_nine_month",
        label: "Section 10(a)(3) — Post-9-Month Update Required: No Update Found",
        status: "fail",
        detail: `Registration effective ${effectiveness.daysSinceEffective} days ago — past the 9-month trigger. No 424B supplement or effective POS AM found. File an update with current financial statements.`,
        filingDate: null, filingUrl: null, filingForm: null,
      });
    } else {
      const updateDate = latestProspectus?.date || latestPostEffective?.date;
      const updateForm = latestProspectus?.form || latestPostEffective?.form;
      const newerAnnual = latestAnnual && new Date(latestAnnual.date) > new Date(updateDate) ? latestAnnual : null;
      const newerQuarterly = latestQuarterly && new Date(latestQuarterly.date) > new Date(updateDate) ? latestQuarterly : null;

      if (newerAnnual) {
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — Post-9-Month Rule 3-12 Gap: Annual FS Not Current",
          status: "fail",
          detail: `Past 9-month trigger. Prospectus last updated ${updateDate} via ${updateForm}, but a newer ${newerAnnual.form} (${newerAnnual.date}) was filed and NOT incorporated. File a 424B or effective POS AM.`,
          filingDate: newerAnnual.date, filingUrl: newerAnnual.url, filingForm: newerAnnual.form,
        });
      } else if (newerQuarterly) {
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — Post-9-Month Rule 3-12 Gap: Interim FS Not Current",
          status: "fail",
          detail: `Past 9-month trigger. Prospectus last updated ${updateDate}, but a newer ${newerQuarterly.form} (${newerQuarterly.date}) was filed and NOT incorporated.`,
          filingDate: newerQuarterly.date, filingUrl: newerQuarterly.url, filingForm: newerQuarterly.form,
        });
      } else {
        checks.push({
          id: "section10a3_nine_month",
          label: "Section 10(a)(3) — Post-9-Month Rule 3-12 FS Currency: Satisfied",
          status: "pass",
          detail: `Past 9-month trigger. Prospectus updated ${updateDate} via ${updateForm}. No later 10-K or 10-Q postdates that update. Section 10(a)(3) satisfied.`,
          filingDate: updateDate, filingUrl: latestProspectus?.url || null, filingForm: updateForm,
        });
      }
    }
  } else {
    // Shelf: IBR auto-refreshes
    const shelfStatus = latestAnnual ? "pass" : "warn";
    checks.push({
      id: "section10a3_ibr_shelf",
      label: "Section 10(a)(3) / Item 512(a) — Shelf IBR Refresh",
      status: shelfStatus,
      detail: shelfStatus === "pass"
        ? `Item 512(a) IBR: ${annualFormLabel} (${latestAnnual.date}) automatically incorporated by reference, refreshing the shelf prospectus. Section 10(a)(3) shelf IBR satisfied.`
        : `No ${annualFormLabel} filed after shelf registration. The shelf prospectus may not have current IBR refresh.`,
      filingDate: latestAnnual?.date || null, filingUrl: latestAnnual?.url || null, filingForm: latestAnnual?.form || null,
    });
  }

  // CHECK: Quarterly reports
  if (isFPI) {
    checks.push({
      id: "quarterly_reports",
      label: "Interim Reports (6-K) — FPI",
      status: "info",
      detail: `FPI — no 10-Q obligation. ${quarterliesSinceReg} 6-K filing(s) since registration.`,
      filingDate: latestQuarterly?.date || null, filingUrl: latestQuarterly?.url || null, filingForm: latestQuarterly?.form || null,
      count: quarterliesSinceReg,
    });
  } else {
    const annualDate = latestAnnual ? new Date(latestAnnual.date) : null;
    const annualDays = latestAnnual ? daysSince(latestAnnual.date) : null;
    let expectedQ = 0;
    if (annualDays !== null) {
      if (annualDays > 270) expectedQ = 3;
      else if (annualDays > 180) expectedQ = 2;
      else if (annualDays > 90) expectedQ = 1;
    }
    const quartersFiledSinceAnnual = annualDate && latestQuarterly
      ? quarterliesSinceReg
      : 0;

    let quarterlyStatus, quarterlyDetail;
    if (!annualDate) {
      quarterlyStatus = "info";
      quarterlyDetail = "No 10-K or 10-Q filed after this registration.";
    } else if (expectedQ === 0) {
      quarterlyStatus = "pass";
      quarterlyDetail = `10-K filed ${annualDays} days ago — no quarterly report yet due.`;
    } else if (quartersFiledSinceAnnual < expectedQ) {
      quarterlyStatus = "fail";
      quarterlyDetail = `Only ${quartersFiledSinceAnnual} of ${expectedQ} expected 10-Q(s) filed since last 10-K. ${expectedQ - quartersFiledSinceAnnual} report(s) missing.`;
    } else {
      quarterlyStatus = "pass";
      quarterlyDetail = `${quartersFiledSinceAnnual}/${expectedQ} expected 10-Q(s) filed and incorporated.`;
    }

    checks.push({
      id: "quarterly_reports",
      label: "Quarterly Reports (10-Q) — Exchange Act Currency & Prospectus Incorporation",
      status: quarterlyStatus,
      detail: quarterlyDetail,
      filingDate: latestQuarterly?.date || null, filingUrl: latestQuarterly?.url || null, filingForm: latestQuarterly?.form || null,
      count: quarterliesSinceReg,
    });
  }

  // CHECK: Current Reports (8-K)
  if (!isFPI) {
    const cDays = latestCurrent ? daysSince(latestCurrent.date) : null;
    const currentStatus = !latestCurrent ? "warn" : cDays <= 365 ? "pass" : "warn";
    checks.push({
      id: "current_reports",
      label: "Current Reports (8-K) Filed Since Registration",
      status: currentStatus,
      detail: !latestCurrent
        ? "No 8-K current reports filed since registration."
        : `Most recent 8-K: ${latestCurrent.date} (${cDays} days ago). ${currentReportsSinceReg} total 8-K(s) since registration.`,
      filingDate: latestCurrent?.date || null, filingUrl: latestCurrent?.url || null, filingForm: latestCurrent?.form || null,
      count: currentReportsSinceReg,
    });
  }

  // CHECK: Post-Effective Amendments
  if (!isShelf) {
    let amendStatus, amendDetail;
    if (allPostEffectiveAmendments.length === 0) {
      amendStatus = "info";
      amendDetail = "No POS AM filings found for this registration statement.";
    } else if (effectivePostEffectiveAmendments.length === 0) {
      amendStatus = "fail";
      amendDetail = `${allPostEffectiveAmendments.length} POS AM(s) filed but NONE declared effective. A filed POS AM does NOT satisfy Section 10(a)(3) until the SEC issues an effectiveness order.`;
    } else {
      amendStatus = "pass";
      amendDetail = `${effectivePostEffectiveAmendments.length} effective POS AM(s). Most recent: ${latestPostEffective?.form} ${latestPostEffective?.date}.`;
    }
    checks.push({
      id: "amendments",
      label: "Post-Effective Amendments (POS AM) — Section 10(a)(3) Update Mechanism",
      status: amendStatus,
      detail: amendDetail,
      filingDate: latestPostEffective?.date || null, filingUrl: null, filingForm: latestPostEffective?.form || null,
      count: allPostEffectiveAmendments.length,
    });
  }

  const overallStatus =
    checks.some(c => c.status === "fail") ? "fail" :
    checks.some(c => c.status === "warn") ? "warn" : "pass";

  return { checks, overallStatus, stage: "post_effective", applicableRule: "Section 10(a)(3) / Item 512" };
}

export async function generateAISummary(data, checkResult) {
  if (!getGeminiApiKey()) return null;

  try {
    const checkSummary = checkResult.checks
      .map(c => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`)
      .join("\n");

    const result = await llm.invoke({
      prompt: `Securities law compliance expert. This registration is ${checkResult.stage === "pre_effective" ? "NOT YET EFFECTIVE" : "ALREADY EFFECTIVE"}.

Company: ${data.companyName} (${data.ticker}) | Form: ${data.registration.form} filed ${data.registration.date} | Effective: ${data.effectiveness.effective ? data.effectiveness.effectDate : "Not yet"} | Shelf: ${data.isShelf} | FPI: ${data.isFPI}

Compliance checks:
${checkSummary}

Overall: ${checkResult.overallStatus.toUpperCase()}
Provide 2-3 sentence verdict citing Section 10(a)(3) specifically. What is the primary issue? What action is required?`,
      response_json_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["CURRENT", "NOT CURRENT", "UNCERTAIN"] },
          summary: { type: "string" },
          key_issue: { type: "string" },
          required_action: { type: "string" },
        },
      },
      model: "gemini-2.0-flash",
    });
    return result;
  } catch (_) {
    return null;
  }
}
