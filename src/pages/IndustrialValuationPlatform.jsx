import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  BookOpen,
  Brain,
  Calculator,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Gauge,
  Landmark,
  LineChart,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import {
  AUTHORITATIVE_FINANCIAL_POLICY,
  buildProjectionRows,
  buildRedFlags,
  buildSensitivityTable,
  calculateValuation,
  defaultScenario,
  formatCurrency,
  formatPercent,
} from "@/lib/industrialValuationEngine";
import {
  aiExtractionGuardrails,
  base44BuildChecklist,
  entityBlueprints,
  industryTemplates,
  secImportWorkflow,
} from "@/lib/industrialAppSpec";

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";
const cardClass = "rounded-2xl border border-border bg-card p-5 shadow-sm";

const numberFields = new Set([
  "productionVolume",
  "realizedPrice",
  "unitCashCost",
  "sgna",
  "startupCapex",
  "sustainingCapex",
  "workingCapitalInvestment",
  "taxRate",
  "discountRate",
  "projectLife",
  "rampYears",
  "debt",
  "grants",
  "requiredReturn",
  "terminalMultiple",
]);

function StatCard({ label, value, sub, icon: Icon }) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="rounded-xl bg-primary/10 p-2 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}

function Field({ label, field, scenario, setScenario, suffix, type = "number" }) {
  const value = scenario[field];
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className={inputClass}
          type={type}
          value={value}
          onChange={(event) => {
            const raw = event.target.value;
            setScenario((prev) => ({
              ...prev,
              [field]: numberFields.has(field) ? Number(raw) : raw,
            }));
          }}
        />
        {suffix && <span className="min-w-fit text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

function WorkflowStep({ index, children }) {
  return (
    <div className="flex gap-3 rounded-xl border border-border bg-background p-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {index + 1}
      </div>
      <p className="text-sm text-foreground">{children}</p>
    </div>
  );
}

function AuditRow({ label, formula }) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{formula}</p>
    </div>
  );
}

function copyCsv(filename, rows) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function IndustrialValuationPlatform() {
  const [scenario, setScenario] = useState({
    ...defaultScenario,
    companyName: "Industrial Valuation Copilot Demo",
    ticker: "DEMO",
    secAccessionNumber: "Not imported yet",
    formType: "10-Q / 10-K pending",
    filingDate: "Pending EDGAR import",
  });
  const [activeTab, setActiveTab] = useState("dashboard");
  const [tickerInput, setTickerInput] = useState("ALB");
  const [sourceLog, setSourceLog] = useState([
    {
      item: "Historical financial statements",
      source: "SEC EDGAR required",
      confidence: "Blocked until imported",
      status: "Needs SEC import",
    },
    {
      item: "Forward operating assumptions",
      source: "User/demo scenario",
      confidence: "Medium",
      status: "Editable",
    },
  ]);

  const valuation = useMemo(() => calculateValuation(scenario), [scenario]);
  const redFlags = useMemo(() => buildRedFlags(scenario, valuation), [scenario, valuation]);
  const sensitivity = useMemo(() => buildSensitivityTable(scenario), [scenario]);
  const projectionRows = useMemo(() => buildProjectionRows(scenario), [scenario]);
  const selectedIndustry = industryTemplates.find((template) => template.sector === scenario.sector) || industryTemplates[0];

  const runMockSecImport = () => {
    setScenario((prev) => ({
      ...prev,
      ticker: tickerInput.toUpperCase(),
      companyName: `${tickerInput.toUpperCase()} SEC Imported Company`,
      secAccessionNumber: "0000000000-26-000001",
      formType: "10-Q",
      filingDate: "Latest filing imported from EDGAR workflow placeholder",
    }));
    setSourceLog([
      {
        item: "Revenue, balance sheet, cash flow, debt, shares",
        source: "SEC Inline XBRL / Company Facts",
        confidence: "100%",
        status: "Imported metadata placeholder",
      },
      {
        item: "TTM financials",
        source: "Calculated from latest 10-Q + prior year comparable quarter + latest FY",
        confidence: "100% when SEC data is connected",
        status: "Formula-ready",
      },
      {
        item: "Forward operating assumptions",
        source: "Uploaded deck or user override only",
        confidence: "Medium / user controlled",
        status: "Editable",
      },
    ]);
  };

  const exportProjection = () => {
    copyCsv("industrial-valuation-model.csv", [
      ["Year", "Production", "Revenue", "Cash OPEX", "EBITDA", "Taxes", "Sustaining CAPEX", "Working Capital", "FCF", "Discount Factor", "PV of FCF"],
      ...projectionRows.map((row) => [
        row.year,
        row.production,
        row.revenue,
        row.cashOpex,
        row.ebitda,
        row.cashTaxes,
        row.sustainingCapex,
        row.workingCapitalInvestment,
        row.fcf,
        row.discountFactor,
        row.pvOfFcf,
      ]),
      [],
      ["Output", "Value"],
      ["NPV", valuation.outputs.npv],
      ["IRR", valuation.outputs.irr],
      ["Payback", valuation.outputs.payback],
      ["MOIC", valuation.outputs.moic],
      ["No-Growth EV", valuation.outputs.noGrowthEv],
      ["Equity Value", valuation.outputs.equityValue],
    ]);
  };

  const tabs = [
    ["dashboard", "Dashboard"],
    ["sec", "SEC Import"],
    ["assumptions", "Assumptions"],
    ["model", "Model Builder"],
    ["valuation", "Valuation"],
    ["memo", "Memo"],
    ["architecture", "Architecture"],
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Landmark className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">Industrial Valuation Copilot</h1>
              <p className="text-xs text-muted-foreground">SEC-first industrial modeling, valuation, audit, and memo platform</p>
            </div>
          </div>
          <button
            onClick={exportProjection}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Download className="h-4 w-4" /> Export CSV Model
          </button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-2 overflow-x-auto px-6 pb-3">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm transition ${
                activeTab === key ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            <div className={cardClass}>
              <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
                <div>
                  <p className="text-sm font-medium text-primary">Full-platform MVP</p>
                  <h2 className="mt-2 text-3xl font-bold tracking-tight text-foreground">Convert industrial disclosures into an auditable valuation model.</h2>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                    This Base44-ready application implements the core workflow: ticker/CIK setup, SEC-first source controls, operating assumption review,
                    model scenario editing, DCF/IRR/no-growth valuation, sensitivities, red flags, audit trail, and memo output.
                  </p>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600">SEC-first policy</span>
                    <span className="rounded-full bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-600">DCF / IRR / MOIC</span>
                    <span className="rounded-full bg-purple-500/10 px-3 py-1 text-xs font-medium text-purple-600">Buffett no-growth EV</span>
                    <span className="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600">Audit trail</span>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-background p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Current Scenario</p>
                  <h3 className="mt-1 text-xl font-semibold text-foreground">{scenario.companyName}</h3>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div><span className="text-muted-foreground">Ticker:</span> {scenario.ticker}</div>
                    <div><span className="text-muted-foreground">Sector:</span> {scenario.sector}</div>
                    <div><span className="text-muted-foreground">Form:</span> {scenario.formType}</div>
                    <div><span className="text-muted-foreground">Accession:</span> {scenario.secAccessionNumber}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Steady-State Revenue" value={formatCurrency(valuation.outputs.revenue)} icon={BarChart3} />
              <StatCard label="Steady-State EBITDA" value={formatCurrency(valuation.outputs.ebitda)} icon={Gauge} />
              <StatCard label="NPV" value={formatCurrency(valuation.outputs.npv)} icon={Calculator} />
              <StatCard label="IRR" value={formatPercent(valuation.outputs.irr)} icon={LineChart} />
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className={cardClass}>
                <SectionHeader icon={ShieldCheck} title="Authoritative Financial Data Policy" subtitle={AUTHORITATIVE_FINANCIAL_POLICY.rule} />
                <div className="grid gap-3 md:grid-cols-2">
                  {AUTHORITATIVE_FINANCIAL_POLICY.allowedHistoricalSources.map((source) => (
                    <div key={source} className="flex items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700">
                      <BadgeCheck className="h-4 w-4" /> {source}
                    </div>
                  ))}
                </div>
              </div>
              <div className={cardClass}>
                <SectionHeader icon={AlertTriangle} title="Red Flags" subtitle="Generated from scenario economics and source metadata." />
                <div className="space-y-2">
                  {redFlags.map((flag) => (
                    <div key={flag} className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700">{flag}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "sec" && (
          <div className="grid gap-6 lg:grid-cols-[0.8fr_1.2fr]">
            <div className={cardClass}>
              <SectionHeader icon={Database} title="SEC Financial Import" subtitle="Production implementation should connect this to a Base44 backend function or external FastAPI service." />
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Ticker or CIK</span>
                <div className="flex gap-2">
                  <input className={inputClass} value={tickerInput} onChange={(e) => setTickerInput(e.target.value)} />
                  <button onClick={runMockSecImport} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">
                    Import
                  </button>
                </div>
              </label>
              <div className="mt-5 rounded-xl border border-border bg-background p-4 text-sm">
                <p><span className="font-medium">Form:</span> {scenario.formType}</p>
                <p><span className="font-medium">Filing Date:</span> {scenario.filingDate}</p>
                <p><span className="font-medium">Accession:</span> {scenario.secAccessionNumber}</p>
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                The UI is wired now. The next production step is implementing Base44 function <code>importSecFinancials</code> to call SEC Company Submissions,
                Company Facts, and Inline XBRL filing documents.
              </p>
            </div>
            <div className={cardClass}>
              <SectionHeader icon={RefreshCw} title="EDGAR Workflow" subtitle="Mandatory source chain for historical financial statements." />
              <div className="grid gap-3">
                {secImportWorkflow.map((step, index) => <WorkflowStep key={step} index={index}>{step}</WorkflowStep>)}
              </div>
            </div>
          </div>
        )}

        {activeTab === "assumptions" && (
          <div className="space-y-6">
            <div className={cardClass}>
              <SectionHeader icon={Upload} title="AI Extraction Guardrails" subtitle={aiExtractionGuardrails.hardRule} />
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-semibold text-foreground">Allowed from decks / reports</p>
                  <div className="grid gap-2">
                    {aiExtractionGuardrails.allowedDeckFields.map((field) => <div key={field} className="rounded-lg bg-emerald-500/10 p-2 text-sm text-emerald-700">{field}</div>)}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-sm font-semibold text-foreground">Blocked unless tied to SEC data</p>
                  <div className="grid gap-2">
                    {aiExtractionGuardrails.blockedDeckFields.map((field) => <div key={field} className="rounded-lg bg-red-500/10 p-2 text-sm text-red-700">{field}</div>)}
                  </div>
                </div>
              </div>
            </div>
            <div className={cardClass}>
              <SectionHeader icon={BookOpen} title="Source Log" subtitle="Every input needs source, confidence, and override status." />
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                    <tr><th className="py-2">Item</th><th>Source</th><th>Confidence</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {sourceLog.map((row) => (
                      <tr key={row.item} className="border-b border-border/70">
                        <td className="py-3 font-medium text-foreground">{row.item}</td>
                        <td>{row.source}</td>
                        <td>{row.confidence}</td>
                        <td>{row.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "model" && (
          <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
            <div className={cardClass}>
              <SectionHeader icon={SlidersHorizontal} title="Model Builder" subtitle="Override any assumption and the model recalculates instantly." />
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Company Name" field="companyName" scenario={scenario} setScenario={setScenario} type="text" />
                <Field label="Ticker" field="ticker" scenario={scenario} setScenario={setScenario} type="text" />
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">Sector</span>
                  <select className={inputClass} value={scenario.sector} onChange={(e) => setScenario((prev) => ({ ...prev, sector: e.target.value }))}>
                    {industryTemplates.map((template) => <option key={template.sector}>{template.sector}</option>)}
                  </select>
                </label>
                <Field label="Production Volume" field="productionVolume" scenario={scenario} setScenario={setScenario} suffix={scenario.productionUnit} />
                <Field label="Realized Price" field="realizedPrice" scenario={scenario} setScenario={setScenario} suffix="$/unit" />
                <Field label="Unit Cash Cost" field="unitCashCost" scenario={scenario} setScenario={setScenario} suffix="$/unit" />
                <Field label="SG&A" field="sgna" scenario={scenario} setScenario={setScenario} suffix="$" />
                <Field label="Startup CAPEX" field="startupCapex" scenario={scenario} setScenario={setScenario} suffix="$" />
                <Field label="Sustaining CAPEX" field="sustainingCapex" scenario={scenario} setScenario={setScenario} suffix="$ / yr" />
                <Field label="Working Capital" field="workingCapitalInvestment" scenario={scenario} setScenario={setScenario} suffix="$ / yr" />
                <Field label="Tax Rate" field="taxRate" scenario={scenario} setScenario={setScenario} suffix="decimal" />
                <Field label="Discount Rate" field="discountRate" scenario={scenario} setScenario={setScenario} suffix="decimal" />
                <Field label="Project Life" field="projectLife" scenario={scenario} setScenario={setScenario} suffix="years" />
                <Field label="Ramp Years" field="rampYears" scenario={scenario} setScenario={setScenario} suffix="years" />
                <Field label="Debt" field="debt" scenario={scenario} setScenario={setScenario} suffix="$" />
                <Field label="Grants" field="grants" scenario={scenario} setScenario={setScenario} suffix="$" />
                <Field label="Required Return" field="requiredReturn" scenario={scenario} setScenario={setScenario} suffix="decimal" />
                <Field label="Terminal Multiple" field="terminalMultiple" scenario={scenario} setScenario={setScenario} suffix="x EBITDA" />
              </div>
            </div>
            <div className={cardClass}>
              <SectionHeader icon={Brain} title={`${selectedIndustry.sector} Operating Template`} subtitle="Sector-specific units and diligence prompts." />
              <p className="text-sm font-semibold text-foreground">Relevant Units</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {selectedIndustry.units.map((unit) => <span key={unit} className="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary">{unit}</span>)}
              </div>
              <p className="mt-5 text-sm font-semibold text-foreground">Diligence Questions</p>
              <div className="mt-2 space-y-2">
                {selectedIndustry.diligence.map((question) => <div key={question} className="rounded-lg border border-border bg-background p-3 text-sm">{question}</div>)}
              </div>
            </div>
          </div>
        )}

        {activeTab === "valuation" && (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <StatCard label="DCF Enterprise Value" value={formatCurrency(valuation.outputs.dcfEv)} icon={Landmark} />
              <StatCard label="Equity Value" value={formatCurrency(valuation.outputs.equityValue)} icon={BarChart3} />
              <StatCard label="No-Growth EV" value={formatCurrency(valuation.outputs.noGrowthEv)} icon={LockKeyhole} />
              <StatCard label="MOIC" value={`${valuation.outputs.moic.toFixed(2)}x`} icon={Gauge} />
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div className={cardClass}>
                <SectionHeader icon={Calculator} title="Audit Trail" subtitle="One-line formulas, ready for model review." />
                <div className="space-y-3">
                  {Object.entries(valuation.formulas).map(([label, formula]) => <AuditRow key={label} label={label} formula={formula} />)}
                </div>
              </div>
              <div className={cardClass}>
                <SectionHeader icon={FileSpreadsheet} title="Price vs. OPEX Sensitivity" subtitle="Cell values show NPV / IRR." />
                <div className="overflow-x-auto">
                  <table className="w-full text-center text-xs">
                    <thead>
                      <tr className="border-b border-border"><th className="p-2 text-left">Price \ Cost</th>{["80%", "90%", "100%", "110%", "120%"].map((h) => <th key={h} className="p-2">{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {sensitivity.map((row) => (
                        <tr key={row.label} className="border-b border-border/60">
                          <td className="p-2 text-left font-medium">{row.label}</td>
                          {row.values.map((cell) => <td key={cell.label} className="p-2">{formatCurrency(cell.npv)}<br /><span className="text-muted-foreground">{formatPercent(cell.irr)}</span></td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            <div className={cardClass}>
              <SectionHeader icon={LineChart} title="Projection Schedule" subtitle="Exportable operating model and valuation schedule." />
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr><th className="p-2 text-left">Year</th><th>Production</th><th>Revenue</th><th>OPEX</th><th>EBITDA</th><th>Taxes</th><th>FCF</th><th>PV FCF</th></tr>
                  </thead>
                  <tbody>
                    {projectionRows.map((row) => (
                      <tr key={row.year} className="border-b border-border/60">
                        <td className="p-2 text-left font-medium">{row.year}</td>
                        <td>{Math.round(row.production).toLocaleString()}</td>
                        <td>{formatCurrency(row.revenue)}</td>
                        <td>{formatCurrency(row.cashOpex)}</td>
                        <td>{formatCurrency(row.ebitda)}</td>
                        <td>{formatCurrency(row.cashTaxes)}</td>
                        <td>{formatCurrency(row.fcf)}</td>
                        <td>{formatCurrency(row.pvOfFcf)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === "memo" && (
          <div className={cardClass}>
            <SectionHeader icon={FileText} title="Investment Memo Output" subtitle="Draft memo generated from current model state." />
            <div className="prose prose-sm max-w-none text-foreground">
              <h3>Investment View</h3>
              <p>
                {scenario.companyName} is modeled as a {scenario.sector} business with steady-state production of {Number(scenario.productionVolume).toLocaleString()} {scenario.productionUnit} at a realized price of ${Number(scenario.realizedPrice).toLocaleString()} per unit.
              </p>
              <h3>Valuation Conclusion</h3>
              <p>
                Base-case DCF enterprise value is {formatCurrency(valuation.outputs.dcfEv)}, equity value is {formatCurrency(valuation.outputs.equityValue)}, NPV is {formatCurrency(valuation.outputs.npv)}, IRR is {formatPercent(valuation.outputs.irr)}, payback is {valuation.outputs.payback.toFixed(1)} years, and MOIC is {valuation.outputs.moic.toFixed(2)}x.
              </p>
              <h3>Buffett-Style No-Growth Value</h3>
              <p>{valuation.formulas.noGrowthEv}</p>
              <h3>Key Diligence Questions</h3>
              <ul>{selectedIndustry.diligence.map((q) => <li key={q}>{q}</li>)}</ul>
              <h3>Red Flags</h3>
              <ul>{redFlags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
            </div>
          </div>
        )}

        {activeTab === "architecture" && (
          <div className="space-y-6">
            <div className={cardClass}>
              <SectionHeader icon={Database} title="Base44 Entity Blueprint" subtitle="Database schema to create in Base44 entities." />
              <div className="grid gap-4 md:grid-cols-2">
                {entityBlueprints.map((entity) => (
                  <div key={entity.name} className="rounded-xl border border-border bg-background p-4">
                    <h3 className="font-semibold text-foreground">{entity.name}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{entity.purpose}</p>
                    <p className="mt-3 text-xs text-muted-foreground">{entity.fields.join(", ")}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className={cardClass}>
              <SectionHeader icon={Search} title="Build Checklist" subtitle="Remaining production hardening tasks after the runnable MVP." />
              <div className="grid gap-3">
                {base44BuildChecklist.map((item, index) => <WorkflowStep key={item} index={index}>{item}</WorkflowStep>)}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
