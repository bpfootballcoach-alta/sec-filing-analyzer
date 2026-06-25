export const AUTHORITATIVE_FINANCIAL_POLICY = {
  title: "SEC-first historical financials",
  rule:
    "Historical financial statement data must come only from SEC EDGAR filings. Uploaded decks and investor presentations may only support forward-looking operating assumptions.",
  allowedHistoricalSources: ["SEC Inline XBRL", "SEC filing HTML", "SEC footnotes", "MD&A"],
  blockedHistoricalSources: [
    "LLM memory",
    "web summaries",
    "investor presentations",
    "press releases",
    "Yahoo Finance",
    "Google Finance",
    "third-party financial websites",
  ],
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
};

export const defaultScenario = {
  companyName: "Demo Industrial Company",
  ticker: "DEMO",
  sector: "Lithium / DLE",
  productionVolume: 40000,
  productionUnit: "TPA LCE",
  realizedPrice: 25000,
  unitCashCost: 6000,
  sgna: 40000000,
  startupCapex: 1200000000,
  sustainingCapex: 50000000,
  workingCapitalInvestment: 15000000,
  taxRate: 0.21,
  discountRate: 0.1,
  projectLife: 10,
  rampYears: 3,
  debt: 300000000,
  grants: 100000000,
  requiredReturn: 0.1,
  terminalMultiple: 6,
};

export const assumptionDefinitions = {
  TPA: "Tonnes per annum, meaning annual production capacity.",
  LCE: "Lithium carbonate equivalent, the standard lithium industry unit.",
  OPEX: "Operating expense.",
  CAPEX: "Capital expenditure.",
  EBITDA: "Earnings before interest, taxes, depreciation, and amortization.",
  FCF: "Free cash flow.",
  IRR: "Internal rate of return.",
  NPV: "Net present value.",
  MOIC: "Multiple on invested capital.",
};

export function buildProjectionRows(input = {}) {
  const s = { ...defaultScenario, ...input };
  const projectLife = Math.max(1, Math.round(toNumber(s.projectLife, 10)));
  const rampYears = Math.max(1, Math.round(toNumber(s.rampYears, 1)));
  const taxRate = Math.max(0, toNumber(s.taxRate, 0));
  const discountRate = Math.max(0, toNumber(s.discountRate, 0));

  return Array.from({ length: projectLife }, (_, index) => {
    const year = index + 1;
    const rampFactor = Math.min(1, year / rampYears);
    const production = toNumber(s.productionVolume) * rampFactor;
    const revenue = production * toNumber(s.realizedPrice);
    const cashOpex = production * toNumber(s.unitCashCost);
    const ebitda = revenue - cashOpex - toNumber(s.sgna);
    const cashTaxes = Math.max(0, ebitda * taxRate);
    const fcf = ebitda - cashTaxes - toNumber(s.sustainingCapex) - toNumber(s.workingCapitalInvestment);
    const discountFactor = 1 / (1 + discountRate) ** year;
    const pvOfFcf = fcf * discountFactor;

    return {
      year,
      rampFactor,
      production,
      revenue,
      cashOpex,
      sgna: toNumber(s.sgna),
      ebitda,
      cashTaxes,
      sustainingCapex: toNumber(s.sustainingCapex),
      workingCapitalInvestment: toNumber(s.workingCapitalInvestment),
      fcf,
      discountFactor,
      pvOfFcf,
      formulas: {
        revenue: `Revenue = ${round(production, 0).toLocaleString()} × ${round(s.realizedPrice, 2).toLocaleString()} = ${round(revenue, 0).toLocaleString()}`,
        cashOpex: `Cash OPEX = ${round(production, 0).toLocaleString()} × ${round(s.unitCashCost, 2).toLocaleString()} = ${round(cashOpex, 0).toLocaleString()}`,
        ebitda: `EBITDA = Revenue − Cash OPEX − SG&A = ${round(ebitda, 0).toLocaleString()}`,
        fcf: `FCF = EBITDA − Cash Taxes − Sustaining CAPEX − Working Capital = ${round(fcf, 0).toLocaleString()}`,
      },
    };
  });
}

export function calculateNpv(cashFlows, discountRate) {
  return cashFlows.reduce((sum, cashFlow, index) => sum + cashFlow / (1 + discountRate) ** index, 0);
}

export function calculateIrr(cashFlows) {
  let low = -0.99;
  let high = 5;
  let mid = 0;

  for (let i = 0; i < 100; i += 1) {
    mid = (low + high) / 2;
    const npv = calculateNpv(cashFlows, mid);
    if (Math.abs(npv) < 0.01) break;
    if (npv > 0) low = mid;
    else high = mid;
  }

  return mid;
}

export function calculateValuation(input = {}) {
  const s = { ...defaultScenario, ...input };
  const projectionRows = buildProjectionRows(s);
  const grossInitialInvestment = toNumber(s.startupCapex);
  const netInitialInvestment = grossInitialInvestment - toNumber(s.grants);
  const pvOfFcfs = projectionRows.reduce((sum, row) => sum + row.pvOfFcf, 0);
  const npv = pvOfFcfs - netInitialInvestment;
  const cashFlows = [-netInitialInvestment, ...projectionRows.map((row) => row.fcf)];
  const irr = calculateIrr(cashFlows);
  const steadyState = projectionRows[projectionRows.length - 1];
  const noGrowthOwnerEarnings =
    steadyState.ebitda - steadyState.cashTaxes - toNumber(s.sustainingCapex) - toNumber(s.workingCapitalInvestment);
  const noGrowthEv = noGrowthOwnerEarnings / Math.max(0.0001, toNumber(s.requiredReturn, 0.1));
  const terminalValue = steadyState.ebitda * toNumber(s.terminalMultiple, 0);
  const terminalPv = terminalValue / (1 + toNumber(s.discountRate, 0.1)) ** projectionRows.length;
  const dcfEv = pvOfFcfs + terminalPv - netInitialInvestment;
  const equityValue = dcfEv - toNumber(s.debt);
  const annualFcfAtSteadyState = Math.max(1, steadyState.fcf);
  const payback = netInitialInvestment / annualFcfAtSteadyState;
  const moic = Math.max(0, equityValue) / Math.max(1, netInitialInvestment);
  const capexIntensity = grossInitialInvestment / Math.max(1, toNumber(s.productionVolume));
  const breakevenPrice =
    (toNumber(s.unitCashCost) * toNumber(s.productionVolume) + toNumber(s.sgna) + toNumber(s.sustainingCapex)) /
    Math.max(1, toNumber(s.productionVolume));

  return {
    scenario: s,
    projectionRows,
    outputs: {
      revenue: steadyState.revenue,
      cashOpex: steadyState.cashOpex,
      ebitda: steadyState.ebitda,
      fcf: steadyState.fcf,
      npv,
      irr,
      payback,
      moic,
      noGrowthOwnerEarnings,
      noGrowthEv,
      dcfEv,
      terminalValue,
      terminalPv,
      equityValue,
      capexIntensity,
      breakevenPrice,
    },
    formulas: {
      revenue: `Revenue = Volume × Price = ${round(s.productionVolume, 0).toLocaleString()} × ${round(s.realizedPrice, 2).toLocaleString()} = ${round(steadyState.revenue, 0).toLocaleString()}`,
      cashOpex: `Cash OPEX = Volume × Unit Cost = ${round(s.productionVolume, 0).toLocaleString()} × ${round(s.unitCashCost, 2).toLocaleString()} = ${round(steadyState.cashOpex, 0).toLocaleString()}`,
      ebitda: `EBITDA = Revenue − Cash OPEX − SG&A = ${round(steadyState.ebitda, 0).toLocaleString()}`,
      fcf: `FCF = EBITDA − Cash Taxes − Sustaining CAPEX − Working Capital = ${round(steadyState.fcf, 0).toLocaleString()}`,
      npv: `NPV = Sum of PV of FCF − Initial Investment = ${round(pvOfFcfs, 0).toLocaleString()} − ${round(netInitialInvestment, 0).toLocaleString()} = ${round(npv, 0).toLocaleString()}`,
      irr: `IRR = Discount rate where NPV = 0 = ${(irr * 100).toFixed(1)}%`,
      noGrowthEv: `No-Growth EV = Owner Earnings ÷ Required Return = ${round(noGrowthOwnerEarnings, 0).toLocaleString()} ÷ ${(toNumber(s.requiredReturn) * 100).toFixed(1)}% = ${round(noGrowthEv, 0).toLocaleString()}`,
      equityValue: `Equity Value = Enterprise Value − Net Debt = ${round(dcfEv, 0).toLocaleString()} − ${round(s.debt, 0).toLocaleString()} = ${round(equityValue, 0).toLocaleString()}`,
    },
  };
}

export function buildSensitivityTable(input = {}, variableA = "realizedPrice", variableB = "unitCashCost") {
  const base = { ...defaultScenario, ...input };
  const priceCases = [0.8, 0.9, 1, 1.1, 1.2];
  const costCases = [0.8, 0.9, 1, 1.1, 1.2];

  return priceCases.map((priceMultiplier) => ({
    label: `${Math.round(priceMultiplier * 100)}%`,
    values: costCases.map((costMultiplier) => {
      const next = {
        ...base,
        [variableA]: toNumber(base[variableA]) * priceMultiplier,
        [variableB]: toNumber(base[variableB]) * costMultiplier,
      };
      const result = calculateValuation(next);
      return {
        label: `${Math.round(costMultiplier * 100)}%`,
        npv: result.outputs.npv,
        irr: result.outputs.irr,
        moic: result.outputs.moic,
      };
    }),
  }));
}

export function buildRedFlags(input = {}, valuation = calculateValuation(input)) {
  const s = { ...defaultScenario, ...input };
  const flags = [];

  if (!s.secAccessionNumber) {
    flags.push("Historical SEC metadata is missing. Import EDGAR financials before treating the model as investment-grade.");
  }
  if (valuation.outputs.capexIntensity > s.realizedPrice * 2) {
    flags.push("CAPEX intensity is high relative to realized price; confirm final EPC estimate and contingency.");
  }
  if (toNumber(s.rampYears) <= 2) {
    flags.push("Ramp-up is aggressive; verify commercial-scale operating history and commissioning risk.");
  }
  if (valuation.outputs.npv < 0) {
    flags.push("Base-case NPV is negative after initial investment and grants.");
  }
  if (toNumber(s.sustainingCapex) <= 0) {
    flags.push("Sustaining CAPEX is zero or missing; industrial assets usually require maintenance capital.");
  }
  if (toNumber(s.workingCapitalInvestment) <= 0) {
    flags.push("Working capital investment is zero or missing; check inventory, receivables, and payables assumptions.");
  }

  return flags;
}

export function formatCurrency(value, compact = true) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(toNumber(value));
}

export function formatPercent(value) {
  return `${(toNumber(value) * 100).toFixed(1)}%`;
}
