const SEC_HEADERS = {
  'User-Agent': 'industrial-valuation-copilot local beta contact@example.com',
  'Accept': 'application/json'
};

const padCik = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

const pickLatestFact = (companyFacts, names) => {
  const usgaap = companyFacts?.facts?.['us-gaap'] || {};
  for (const name of names) {
    const units = usgaap[name]?.units || {};
    const unitKey = units.USD ? 'USD' : units.shares ? 'shares' : Object.keys(units)[0];
    const rows = units[unitKey] || [];
    const annual = rows
      .filter((row) => row.val != null && row.fy && row.fp && row.form)
      .sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')));
    if (annual[0]) return { ...annual[0], tag: name, unit: unitKey };
  }
  return null;
};

export async function importSecCompanyFacts(tickerOrCik) {
  const raw = String(tickerOrCik || '').trim().toUpperCase();
  if (!raw) throw new Error('Enter a ticker or CIK.');

  const tickerMapResponse = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
  if (!tickerMapResponse.ok) throw new Error('Could not download SEC ticker map.');
  const tickerMap = await tickerMapResponse.json();
  const rows = Object.values(tickerMap);
  const match = /^\d+$/.test(raw)
    ? rows.find((row) => String(row.cik_str) === String(Number(raw))) || { cik_str: Number(raw), ticker: raw, title: raw }
    : rows.find((row) => String(row.ticker).toUpperCase() === raw);
  if (!match) throw new Error(`Ticker not found in SEC ticker map: ${raw}`);

  const cik = padCik(match.cik_str);
  const factsResponse = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: SEC_HEADERS });
  if (!factsResponse.ok) throw new Error(`Could not download SEC Company Facts for ${raw}.`);
  const facts = await factsResponse.json();

  const revenue = pickLatestFact(facts, ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']);
  const assets = pickLatestFact(facts, ['Assets']);
  const cash = pickLatestFact(facts, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']);
  const debt = pickLatestFact(facts, ['LongTermDebtCurrent', 'LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']);
  const shares = pickLatestFact(facts, ['EntityCommonStockSharesOutstanding', 'CommonStocksIncludingAdditionalPaidInCapital']);
  const netIncome = pickLatestFact(facts, ['NetIncomeLoss']);
  const operatingCashFlow = pickLatestFact(facts, ['NetCashProvidedByUsedInOperatingActivities']);
  const capex = pickLatestFact(facts, ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpendituresIncurredButNotYetPaid']);

  return {
    ticker: match.ticker,
    cik,
    companyName: facts.entityName || match.title,
    formType: revenue?.form || assets?.form || 'SEC Company Facts',
    filingDate: revenue?.filed || assets?.filed || 'SEC Company Facts imported',
    periodEnd: revenue?.end || assets?.end,
    accessionNumber: revenue?.accn || assets?.accn || 'Company Facts API',
    facts: { revenue, assets, cash, debt, shares, netIncome, operatingCashFlow, capex },
    suggestedScenario: {
      ticker: match.ticker,
      companyName: facts.entityName || match.title,
      secAccessionNumber: revenue?.accn || assets?.accn || 'Company Facts API',
      formType: revenue?.form || assets?.form || 'SEC Company Facts',
      filingDate: revenue?.filed || assets?.filed || 'SEC Company Facts imported',
      debt: Number(debt?.val || 0),
      sgna: Math.max(0, Number(revenue?.val || 0) * 0.08),
      startupCapex: Math.max(0, Number(capex?.val || 0) * 5),
      sustainingCapex: Math.max(0, Number(capex?.val || 0)),
      workingCapitalInvestment: Math.max(0, Number(revenue?.val || 0) * 0.02)
    }
  };
}
