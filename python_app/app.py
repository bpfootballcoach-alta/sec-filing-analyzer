import io
import math
from dataclasses import dataclass

import pandas as pd
import plotly.express as px
import requests
import streamlit as st

SEC_HEADERS = {
    "User-Agent": "industrial-valuation-copilot beta bpfootballcoach@example.com",
    "Accept-Encoding": "gzip, deflate",
    "Host": "data.sec.gov",
}
TICKER_HEADERS = {
    "User-Agent": "industrial-valuation-copilot beta bpfootballcoach@example.com",
    "Accept-Encoding": "gzip, deflate",
}

st.set_page_config(page_title="Industrial Valuation Copilot", layout="wide")


def fmt_money(x):
    if x is None or pd.isna(x):
        return "n/a"
    sign = "-" if x < 0 else ""
    x = abs(float(x))
    if x >= 1_000_000_000:
        return f"{sign}${x / 1_000_000_000:,.2f}B"
    if x >= 1_000_000:
        return f"{sign}${x / 1_000_000:,.2f}M"
    if x >= 1_000:
        return f"{sign}${x / 1_000:,.2f}K"
    return f"{sign}${x:,.0f}"


def fmt_num(x):
    if x is None or pd.isna(x):
        return "n/a"
    return f"{float(x):,.0f}"


def pad_cik(cik):
    return str(cik).zfill(10)


@st.cache_data(show_spinner=False)
def load_ticker_map():
    url = "https://www.sec.gov/files/company_tickers.json"
    r = requests.get(url, headers=TICKER_HEADERS, timeout=30)
    r.raise_for_status()
    rows = list(r.json().values())
    df = pd.DataFrame(rows)
    df["ticker"] = df["ticker"].str.upper()
    return df


@st.cache_data(show_spinner=False)
def load_company_facts(cik10):
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10}.json"
    r = requests.get(url, headers=SEC_HEADERS, timeout=30)
    r.raise_for_status()
    return r.json()


def latest_fact(company_facts, tags, unit_preference="USD"):
    us_gaap = company_facts.get("facts", {}).get("us-gaap", {})
    for tag in tags:
        fact = us_gaap.get(tag)
        if not fact:
            continue
        units = fact.get("units", {})
        unit = unit_preference if unit_preference in units else None
        if unit is None:
            unit = "USD" if "USD" in units else "shares" if "shares" in units else next(iter(units), None)
        if unit is None:
            continue
        rows = []
        for row in units.get(unit, []):
            if row.get("val") is None or not row.get("end"):
                continue
            rows.append({**row, "tag": tag, "unit": unit})
        if rows:
            rows = sorted(rows, key=lambda x: (x.get("end", ""), x.get("filed", "")), reverse=True)
            return rows[0]
    return None


def fact_value(fact, default=0.0):
    try:
        return float(fact.get("val")) if fact else default
    except Exception:
        return default


def import_sec(ticker_or_cik):
    raw = ticker_or_cik.strip().upper()
    ticker_map = load_ticker_map()
    if raw.isdigit():
        cik_num = int(raw)
        match = ticker_map[ticker_map["cik_str"] == cik_num]
        if match.empty:
            title = raw
            ticker = raw
        else:
            row = match.iloc[0]
            title = row["title"]
            ticker = row["ticker"]
    else:
        match = ticker_map[ticker_map["ticker"] == raw]
        if match.empty:
            raise ValueError(f"Ticker not found in SEC ticker map: {raw}")
        row = match.iloc[0]
        cik_num = int(row["cik_str"])
        title = row["title"]
        ticker = row["ticker"]
    cik10 = pad_cik(cik_num)
    facts = load_company_facts(cik10)
    picked = {
        "Revenue": latest_fact(facts, ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]),
        "Assets": latest_fact(facts, ["Assets"]),
        "Cash": latest_fact(facts, ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
        "Current Debt": latest_fact(facts, ["LongTermDebtCurrent", "LongTermDebtAndFinanceLeaseObligationsCurrent"]),
        "Long-Term Debt": latest_fact(facts, ["LongTermDebtNoncurrent", "LongTermDebtAndFinanceLeaseObligationsNoncurrent"]),
        "Net Income": latest_fact(facts, ["NetIncomeLoss"]),
        "Operating Cash Flow": latest_fact(facts, ["NetCashProvidedByUsedInOperatingActivities"]),
        "Capex": latest_fact(facts, ["PaymentsToAcquirePropertyPlantAndEquipment", "CapitalExpendituresIncurredButNotYetPaid"]),
        "Shares": latest_fact(facts, ["EntityCommonStockSharesOutstanding"], "shares"),
    }
    company_name = facts.get("entityName") or title
    return {"ticker": ticker, "cik": cik10, "company": company_name, "facts": picked}


def build_facts_table(picked):
    rows = []
    for metric, fact in picked.items():
        rows.append({
            "Metric": metric,
            "Value": fact.get("val") if fact else None,
            "Display": fmt_num(fact.get("val")) if metric == "Shares" and fact else fmt_money(fact.get("val")) if fact else "n/a",
            "Tag": fact.get("tag") if fact else "n/a",
            "Unit": fact.get("unit") if fact else "n/a",
            "Form": fact.get("form") if fact else "n/a",
            "Period End": fact.get("end") if fact else "n/a",
            "Filed": fact.get("filed") if fact else "n/a",
            "Accession": fact.get("accn") if fact else "n/a",
        })
    return pd.DataFrame(rows)


def project_model(volume, price, unit_cost, sgna, startup_capex, sustaining_capex, working_capital, tax_rate, discount_rate, years, ramp_years):
    rows = []
    for year in range(1, int(years) + 1):
        ramp = min(1.0, year / max(1, ramp_years))
        production = volume * ramp
        revenue = production * price
        cash_opex = production * unit_cost
        ebitda = revenue - cash_opex - sgna
        taxes = max(0, ebitda * tax_rate)
        fcf = ebitda - taxes - sustaining_capex - working_capital
        discount_factor = 1 / ((1 + discount_rate) ** year)
        pv_fcf = fcf * discount_factor
        rows.append({
            "Year": year,
            "Production": production,
            "Revenue": revenue,
            "Cash Opex": cash_opex,
            "EBITDA": ebitda,
            "Taxes": taxes,
            "Sustaining Capex": sustaining_capex,
            "Working Capital": working_capital,
            "FCF": fcf,
            "Discount Factor": discount_factor,
            "PV FCF": pv_fcf,
        })
    return pd.DataFrame(rows)


def npv_and_irr(proj, startup_capex, grants, debt, terminal_multiple, discount_rate):
    initial = startup_capex - grants
    terminal_value = proj.iloc[-1]["EBITDA"] * terminal_multiple
    terminal_pv = terminal_value / ((1 + discount_rate) ** len(proj))
    dcf_ev = proj["PV FCF"].sum() + terminal_pv - initial
    equity_value = dcf_ev - debt
    npv = proj["PV FCF"].sum() - initial
    cashflows = [-initial] + proj["FCF"].tolist()
    irr = None
    try:
        import numpy_financial as npf
        irr = npf.irr(cashflows)
    except Exception:
        irr = None
    payback = None
    cumulative = -initial
    for _, row in proj.iterrows():
        previous = cumulative
        cumulative += row["FCF"]
        if cumulative >= 0 and payback is None:
            payback = row["Year"] - 1 + abs(previous) / row["FCF"] if row["FCF"] else None
    moic = equity_value / initial if initial else None
    owner_earnings = proj.iloc[-1]["EBITDA"] - proj.iloc[-1]["Taxes"] - proj.iloc[-1]["Sustaining Capex"] - proj.iloc[-1]["Working Capital"]
    no_growth_ev = owner_earnings / discount_rate if discount_rate else None
    return {
        "Initial Investment": initial,
        "DCF EV": dcf_ev,
        "Equity Value": equity_value,
        "NPV": npv,
        "IRR": irr,
        "Payback": payback,
        "MOIC": moic,
        "Terminal Value": terminal_value,
        "Terminal PV": terminal_pv,
        "Owner Earnings": owner_earnings,
        "No Growth EV": no_growth_ev,
    }


st.title("Industrial Valuation Copilot - Python Beta")
st.caption("Live SEC Company Facts import + operating model + valuation dashboard. No React. No Base44 login.")

with st.sidebar:
    st.header("SEC Import")
    ticker = st.text_input("Ticker or CIK", value="HPK")
    import_clicked = st.button("Import SEC Financials", type="primary")
    st.divider()
    st.header("Operating Model")
    volume = st.number_input("Production volume", value=40000.0, step=1000.0)
    price = st.number_input("Realized price per unit", value=25000.0, step=500.0)
    unit_cost = st.number_input("Cash cost per unit", value=6000.0, step=250.0)
    sgna = st.number_input("SG&A", value=40_000_000.0, step=1_000_000.0)
    startup_capex = st.number_input("Startup capex", value=1_200_000_000.0, step=10_000_000.0)
    sustaining_capex = st.number_input("Sustaining capex", value=50_000_000.0, step=1_000_000.0)
    working_capital = st.number_input("Working capital investment", value=15_000_000.0, step=1_000_000.0)
    tax_rate = st.number_input("Tax rate", value=0.21, step=0.01, format="%.2f")
    discount_rate = st.number_input("Discount rate", value=0.10, step=0.01, format="%.2f")
    years = st.number_input("Projection years", value=10, step=1)
    ramp_years = st.number_input("Ramp years", value=3, step=1)
    grants = st.number_input("Grants / incentives", value=100_000_000.0, step=1_000_000.0)
    terminal_multiple = st.number_input("Terminal EBITDA multiple", value=6.0, step=0.5)

if "sec_result" not in st.session_state:
    st.session_state.sec_result = None

if import_clicked:
    with st.spinner("Importing live SEC Company Facts..."):
        try:
            st.session_state.sec_result = import_sec(ticker)
            st.success("SEC import complete.")
        except Exception as e:
            st.error(str(e))

sec_result = st.session_state.sec_result
facts_df = None
if sec_result:
    facts_df = build_facts_table(sec_result["facts"])
    debt = fact_value(sec_result["facts"].get("Current Debt")) + fact_value(sec_result["facts"].get("Long-Term Debt"))
else:
    debt = 0.0

proj = project_model(volume, price, unit_cost, sgna, startup_capex, sustaining_capex, working_capital, tax_rate, discount_rate, years, ramp_years)
outputs = npv_and_irr(proj, startup_capex, grants, debt, terminal_multiple, discount_rate)

tab1, tab2, tab3, tab4, tab5 = st.tabs(["Dashboard", "SEC Data", "Model", "Valuation", "Export"])

with tab1:
    if sec_result:
        st.subheader(sec_result["company"])
        st.write(f"Ticker: **{sec_result['ticker']}** | CIK: **{sec_result['cik']}**")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Steady Revenue", fmt_money(proj.iloc[-1]["Revenue"]))
    c2.metric("Steady EBITDA", fmt_money(proj.iloc[-1]["EBITDA"]))
    c3.metric("NPV", fmt_money(outputs["NPV"]))
    c4.metric("IRR", "n/a" if outputs["IRR"] is None else f"{outputs['IRR']:.1%}")
    st.plotly_chart(px.line(proj, x="Year", y=["Revenue", "EBITDA", "FCF"], title="Projection"), use_container_width=True)

with tab2:
    st.subheader("Live SEC Company Facts")
    if facts_df is None:
        st.info("Enter a ticker in the sidebar and click Import SEC Financials.")
    else:
        st.dataframe(facts_df, use_container_width=True)

with tab3:
    st.subheader("Projection Schedule")
    st.dataframe(proj, use_container_width=True)

with tab4:
    st.subheader("Valuation Outputs")
    out_df = pd.DataFrame([{"Metric": k, "Value": v, "Display": fmt_money(v) if k not in ["IRR", "Payback", "MOIC"] else v} for k, v in outputs.items()])
    st.dataframe(out_df, use_container_width=True)
    st.markdown("### Audit Trail")
    st.write(f"Revenue = production x price = {fmt_num(volume)} x {fmt_money(price)}")
    st.write(f"EBITDA = revenue - cash opex - SG&A = {fmt_money(proj.iloc[-1]['EBITDA'])}")
    st.write(f"FCF = EBITDA - taxes - sustaining capex - working capital = {fmt_money(proj.iloc[-1]['FCF'])}")
    st.write(f"No-growth EV = owner earnings / discount rate = {fmt_money(outputs['No Growth EV'])}")

with tab5:
    st.subheader("Export")
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        proj.to_excel(writer, sheet_name="Projection", index=False)
        pd.DataFrame([outputs]).to_excel(writer, sheet_name="Valuation", index=False)
        if facts_df is not None:
            facts_df.to_excel(writer, sheet_name="SEC Facts", index=False)
    st.download_button("Download Excel Model", data=output.getvalue(), file_name="industrial_valuation_model.xlsx", mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
