export const entityBlueprints = [
  {
    name: "Company",
    purpose: "Stores issuer identity, SEC identifiers, industry classification, and valuation status.",
    fields: ["ticker", "name", "cik", "sector", "industry", "country", "currency", "fiscal_year_end"],
  },
  {
    name: "Filing",
    purpose: "Stores SEC source metadata so every model is reproducible.",
    fields: ["company_id", "form_type", "accession_number", "filing_date", "period_end", "sec_url", "xbrl_url", "imported_at"],
  },
  {
    name: "FinancialStatementLine",
    purpose: "Stores normalized SEC financial statement facts and tags.",
    fields: ["filing_id", "statement_type", "period", "line_item", "xbrl_tag", "value", "unit", "source_url", "confidence"],
  },
  {
    name: "UploadedDocument",
    purpose: "Stores uploaded decks, reports, feasibility studies, and extracted text.",
    fields: ["company_id", "file_name", "file_type", "storage_url", "upload_date", "parsed_text", "document_type"],
  },
  {
    name: "OperatingAssumption",
    purpose: "Stores forward-looking operating inputs with confidence and source mapping.",
    fields: ["company_id", "assumption_name", "value", "unit", "source_type", "source_page", "confidence", "user_override"],
  },
  {
    name: "ModelScenario",
    purpose: "Stores base/downside/upside and user-created industrial valuation cases.",
    fields: ["company_id", "scenario_name", "production_volume", "price", "unit_cost", "sgna", "capex", "debt", "grants", "tax_rate", "discount_rate", "project_life"],
  },
  {
    name: "ValuationOutput",
    purpose: "Stores model output values for audit, comparison, and export.",
    fields: ["scenario_id", "revenue", "opex", "ebitda", "fcf", "npv", "irr", "payback", "moic", "no_growth_ev", "equity_value"],
  },
  {
    name: "AuditTrail",
    purpose: "Stores formula strings, input source metadata, and timestamps.",
    fields: ["model_id", "output_name", "formula", "input_sources", "created_at"],
  },
];

export const secImportWorkflow = [
  "Ticker or CIK input",
  "CIK lookup",
  "Company submissions request",
  "Identify latest filing with financial statements",
  "Download Inline XBRL or SEC filing HTML",
  "Parse income statement, balance sheet, cash flow, equity, segment, debt, leases, shares, D&A, capex, and working capital",
  "Normalize GAAP labels into standard line items",
  "Construct TTM when the latest financial statement is a 10-Q",
  "Attach SEC metadata: form type, accession number, filing date, reporting period, XBRL tag, source URL, import timestamp",
];

export const aiExtractionGuardrails = {
  role: "Industrial valuation analyst",
  hardRule:
    "Use SEC filings as the only source of historical financials. Use uploaded presentations only for operating assumptions and forward-looking project data.",
  allowedDeckFields: [
    "production capacity",
    "commodity price guidance",
    "cash cost",
    "OPEX guidance",
    "CAPEX guidance",
    "recovery rate",
    "grade",
    "resource size",
    "ramp schedule",
    "grants",
    "loans",
    "tax credits",
    "permitting",
    "technology risk",
    "management milestones",
  ],
  blockedDeckFields: [
    "historical revenue",
    "historical EBITDA",
    "historical net income",
    "historical cash flow",
    "historical debt",
    "historical share count",
  ],
};

export const industryTemplates = [
  {
    sector: "Lithium / DLE",
    units: ["TPA LCE", "brine grade", "Mg/Li ratio", "recovery", "reagent consumption"],
    diligence: [
      "What is the brine grade?",
      "What is Mg/Li ratio?",
      "Has commercial-scale DLE been proven?",
      "What is the final FEL-3 CAPEX?",
      "What lithium price is being underwritten?",
    ],
  },
  {
    sector: "Mining",
    units: ["tonnes mined", "grade", "recovery", "payable metal", "strip ratio"],
    diligence: ["What is grade?", "What is strip ratio?", "What is mine life?", "What is sustaining CAPEX?", "What is permitting status?"],
  },
  {
    sector: "Oil & Gas",
    units: ["BOE/d", "decline rate", "LOE", "royalties", "reserve life"],
    diligence: ["What is decline rate?", "What is the type curve?", "What is LOE?", "What is realized pricing?", "What is hedging?"],
  },
  {
    sector: "Manufacturing",
    units: ["units sold", "ASP", "utilization", "variable cost", "fixed cost"],
    diligence: ["What is utilization?", "What is fixed vs. variable cost?", "What is customer concentration?", "What is maintenance CAPEX?", "What is pricing power?"],
  },
  {
    sector: "Power / Utilities",
    units: ["MW", "capacity factor", "MWh", "PPA price", "fuel cost", "availability"],
    diligence: ["What is capacity factor?", "Is revenue contracted?", "What is fuel exposure?", "What is availability?", "What is grid or interconnection risk?"],
  },
];

export const base44BuildChecklist = [
  "Create Base44 entities for Company, Filing, FinancialStatementLine, UploadedDocument, OperatingAssumption, ModelScenario, ValuationOutput, and AuditTrail.",
  "Add backend function: importSecFinancials(tickerOrCik).",
  "Add backend function: extractOperatingAssumptions(fileUrl, companyId).",
  "Add backend function: calculateIndustrialValuation(scenarioId).",
  "Add backend function: exportExcelModel(companyId, scenarioId).",
  "Add pages: Dashboard, Company Setup, SEC Financial Import, Assumption Review, Model Builder, Valuation Output, Memo Output.",
];
