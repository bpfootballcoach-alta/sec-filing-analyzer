const $ = (id) => document.getElementById(id);
const money = (v) => v == null ? 'n/a' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(v);
const num = (v) => v == null ? 'n/a' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
const padCik = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

function latestFact(facts, names, preferredUnit = 'USD') {
  const usgaap = facts?.facts?.['us-gaap'] || {};
  for (const name of names) {
    const units = usgaap[name]?.units || {};
    const unitKey = units[preferredUnit] ? preferredUnit : units.USD ? 'USD' : units.shares ? 'shares' : Object.keys(units)[0];
    const rows = (units[unitKey] || [])
      .filter((r) => r.val != null && r.end && r.form && r.filed)
      .sort((a, b) => String(b.end).localeCompare(String(a.end)) || String(b.filed).localeCompare(String(a.filed)));
    if (rows[0]) return { ...rows[0], tag: name, unit: unitKey };
  }
  return null;
}

function row(label, fact, format = money) {
  if (!fact) return `<tr><td>${label}</td><td>n/a</td><td></td><td></td><td></td></tr>`;
  return `<tr><td>${label}<br><small>${fact.tag}</small></td><td>${format(fact.val)}</td><td>${fact.form}</td><td>${fact.end || ''}</td><td>${fact.filed || ''}</td></tr>`;
}

async function importTicker() {
  const ticker = $('ticker').value.trim().toUpperCase();
  if (!ticker) return;
  $('status').textContent = 'Importing from SEC...';
  $('results').innerHTML = '';
  $('raw').textContent = '';

  try {
    const mapRes = await fetch('https://www.sec.gov/files/company_tickers.json');
    if (!mapRes.ok) throw new Error('Could not download SEC ticker map.');
    const map = await mapRes.json();
    const companies = Object.values(map);
    const match = /^\d+$/.test(ticker)
      ? companies.find((c) => String(c.cik_str) === String(Number(ticker))) || { cik_str: Number(ticker), ticker, title: ticker }
      : companies.find((c) => String(c.ticker).toUpperCase() === ticker);
    if (!match) throw new Error(`Ticker not found in SEC ticker map: ${ticker}`);

    const cik = padCik(match.cik_str);
    const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    if (!factsRes.ok) throw new Error(`SEC Company Facts failed for CIK ${cik}.`);
    const facts = await factsRes.json();

    const picked = {
      revenue: latestFact(facts, ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet']),
      assets: latestFact(facts, ['Assets']),
      cash: latestFact(facts, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']),
      debtCurrent: latestFact(facts, ['LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent']),
      debtLongTerm: latestFact(facts, ['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']),
      netIncome: latestFact(facts, ['NetIncomeLoss']),
      operatingCashFlow: latestFact(facts, ['NetCashProvidedByUsedInOperatingActivities']),
      capex: latestFact(facts, ['PaymentsToAcquirePropertyPlantAndEquipment', 'CapitalExpendituresIncurredButNotYetPaid']),
      shares: latestFact(facts, ['EntityCommonStockSharesOutstanding'], 'shares')
    };

    const totalDebt = Number(picked.debtCurrent?.val || 0) + Number(picked.debtLongTerm?.val || 0);
    $('status').textContent = `Imported live SEC Company Facts for ${facts.entityName || match.title} (${match.ticker}, CIK ${cik})`;
    $('results').innerHTML = `
      <div class="card"><h2>${facts.entityName || match.title}</h2><p><b>Ticker:</b> ${match.ticker} &nbsp; <b>CIK:</b> ${cik}</p><p><b>Total Debt:</b> ${money(totalDebt)}</p></div>
      <div class="card"><h2>Normalized SEC facts</h2><table><thead><tr><th>Metric</th><th>Value</th><th>Form</th><th>Period End</th><th>Filed</th></tr></thead><tbody>
        ${row('Revenue', picked.revenue)}
        ${row('Assets', picked.assets)}
        ${row('Cash', picked.cash)}
        ${row('Current Debt', picked.debtCurrent)}
        ${row('Long-Term Debt', picked.debtLongTerm)}
        ${row('Net Income', picked.netIncome)}
        ${row('Operating Cash Flow', picked.operatingCashFlow)}
        ${row('Capital Expenditures', picked.capex)}
        ${row('Shares Outstanding', picked.shares, num)}
      </tbody></table></div>
      <div class="card"><h2>Model handoff</h2><p>This is the live SEC import layer. The next step is feeding these returned facts directly into the valuation model fields.</p></div>`;
    $('raw').textContent = JSON.stringify({ company: facts.entityName, ticker: match.ticker, cik, picked }, null, 2);
  } catch (err) {
    $('status').textContent = 'Import failed.';
    $('results').innerHTML = `<div class="card error"><b>Error:</b> ${err.message}</div>`;
  }
}

$('importBtn').addEventListener('click', importTicker);
$('ticker').addEventListener('keydown', (e) => { if (e.key === 'Enter') importTicker(); });
