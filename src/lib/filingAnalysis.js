// Filing type detection schema — lightweight first pass
export const DETECTION_SCHEMA = {
  type: "object",
  properties: {
    filing_type: { type: "string" },
    company_name: { type: "string" },
    ticker: { type: "string" },
    filing_date: { type: "string" },
    period_covered: { type: "string" },
  },
};

// Full extraction schema — shared across all filing types
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    company_name: { type: "string" },
    ticker: { type: "string" },
    filing_type: { type: "string" },
    filing_date: { type: "string" },
    period_covered: { type: "string" },
    executive_summary: { type: "string" },
    narrative_highlights: {
      type: "object",
      properties: {
        management_commentary: { type: "string" },
        business_developments: { type: "string" },
        legal_regulatory: { type: "string" },
        going_concern_or_restatements: { type: "string" },
        guidance_and_outlook: { type: "string" },
        significant_events: { type: "string" },
        overall_tone: { type: "string" },
      },
    },
    financial_highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          change: { type: "string" },
          category: { type: "string" },
        },
      },
    },
    revenue_data: {
      type: "object",
      properties: {
        total_revenue: { type: "string" },
        revenue_growth: { type: "string" },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              amount: { type: "string" },
              percentage: { type: "string" },
            },
          },
        },
      },
    },
    profitability: {
      type: "object",
      properties: {
        gross_margin: { type: "string" },
        operating_margin: { type: "string" },
        net_margin: { type: "string" },
        ebitda: { type: "string" },
        eps: { type: "string" },
      },
    },
    balance_sheet: {
      type: "object",
      properties: {
        total_assets: { type: "string" },
        total_liabilities: { type: "string" },
        total_equity: { type: "string" },
        cash_and_equivalents: { type: "string" },
        total_debt: { type: "string" },
        debt_to_equity: { type: "string" },
      },
    },
    cash_flow: {
      type: "object",
      properties: {
        operating: { type: "string" },
        investing: { type: "string" },
        financing: { type: "string" },
        free_cash_flow: { type: "string" },
      },
    },
    capital_structure: {
      type: "object",
      properties: {
        summary: { type: "string" },
        total_capitalization: { type: "string" },
        equity: {
          type: "object",
          properties: {
            common_equity: { type: "string" },
            preferred_equity: { type: "string" },
            shares_outstanding: { type: "string" },
            market_cap: { type: "string" },
            book_value_per_share: { type: "string" },
            equity_percentage_of_cap: { type: "string" },
          },
        },
        debt: {
          type: "object",
          properties: {
            total_debt: { type: "string" },
            short_term_debt: { type: "string" },
            long_term_debt: { type: "string" },
            debt_percentage_of_cap: { type: "string" },
            weighted_average_interest_rate: { type: "string" },
            debt_instruments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  type: { type: "string" },
                  amount: { type: "string" },
                  maturity: { type: "string" },
                  interest_rate: { type: "string" },
                  cost_basis: { type: "string" },
                  notes: { type: "string" },
                },
              },
            },
          },
        },
        other_components: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              amount: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    },
    financing_activity: {
      type: "object",
      properties: {
        has_recent_financing: { type: "boolean" },
        summary: { type: "string" },
        transactions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              instrument: { type: "string" },
              date: { type: "string" },
              amount: { type: "string" },
              structure: { type: "string" },
              cost_basis: { type: "string" },
              interest_rate_or_yield: { type: "string" },
              interest_rate_type: { type: "string" },
              benchmark_and_spread: { type: "string" },
              rate_floor: { type: "string" },
              maturity_or_term: { type: "string" },
              amortization: { type: "string" },
              use_of_proceeds: { type: "string" },
              collateral_or_security: { type: "string" },
              covenants: { type: "string" },
              call_put_conversion: { type: "string" },
              underwriters_or_parties: { type: "string" },
              key_terms: { type: "string" },
              amendments_or_waivers: { type: "string" },
            },
          },
        },
      },
    },
    financing_data: {
      type: "object",
      properties: {
        summary: { type: "string" },
        details: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              description: { type: "string" },
              amount: { type: "string" },
            },
          },
        },
      },
    },
    risk_factors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          severity: { type: "string" },
        },
      },
    },
    key_insights: { type: "array", items: { type: "string" } },
  },
};

// Per-filing-type extraction instructions
const FILING_INSTRUCTIONS = {
  "10-K": `This is an Annual Report (10-K). Extract:
- BUSINESS OVERVIEW: What does the company do, what markets, what products/services, any major changes this year
- FULL YEAR FINANCIALS: Complete income statement (revenue, COGS, gross profit, OpEx, operating income, net income), balance sheet, and cash flow statement with exact figures
- SEGMENT BREAKDOWN: Every business segment with revenue, operating income, margins
- MD&A: Management's full discussion of results, what drove changes YoY, forward outlook
- RISK FACTORS: Summarize the top 5-8 most material risks with detail (not just headings)
- CAPITAL STRUCTURE: Every debt instrument on the balance sheet — name, principal, rate, maturity, covenants
- FINANCING ACTIVITY: Any new debt, equity issuances, refinancings, or credit facility changes disclosed in the notes or MD&A liquidity section
- AUDITOR REPORT: Any qualifications, going concern language, or critical audit matters
- LEGAL PROCEEDINGS: Any material lawsuits, regulatory actions, or investigations
- KEY INSIGHTS: 5-7 analyst-level observations — what is notable, unusual, or concerning about this year's results`,

  "10-Q": `This is a Quarterly Report (10-Q). Extract:
- QUARTERLY FINANCIALS: Revenue, gross profit, operating income, net income for the quarter AND year-to-date, with prior year comparisons — exact figures from all tables
- SEQUENTIAL CHANGES: How did this quarter compare to the prior quarter (if disclosed)?
- MD&A: What management says drove this quarter's results, any one-time items, guidance changes
- BALANCE SHEET: Snapshot of assets, liabilities, equity as of quarter end vs. prior year end
- CASH FLOW: YTD operating, investing, financing cash flows
- FINANCING ACTIVITY: Any new debt, drawdowns, repayments, equity issuances, or credit facility amendments since the last 10-K — read the debt notes and liquidity section carefully
- CAPITAL STRUCTURE CHANGES: Any changes to the debt stack or equity since last annual report
- LEGAL/REGULATORY: Any new developments in legal proceedings or regulatory matters
- KEY INSIGHTS: What changed materially this quarter? What is management emphasizing or downplaying?`,

  "8-K": `This is a Current Report (8-K) which discloses a specific material event. Extract:
- ITEM TYPE: What specific Item(s) are being reported (e.g., Item 1.01 Entry into Material Agreement, Item 2.01 Completion of Acquisition, Item 8.01 Other Events, etc.)
- EVENT DESCRIPTION: What exactly happened? Describe the event in full detail
- FINANCIAL IMPACT: Any disclosed financial figures, consideration amounts, or projected impacts
- FINANCING DETAILS (if applicable): If this 8-K involves any debt, credit facility, equity offering, or financing transaction — extract EVERY detail: instrument name, amount, rate, maturity, structure, cost basis, covenants, collateral, call/put features, use of proceeds, parties involved
- TRANSACTION TERMS: For M&A or asset transactions — purchase price, structure, financing, conditions, timeline
- STRATEGIC CONTEXT: Why is this event significant? What does it signal about the company's strategy or financial condition?
- KEY INSIGHTS: What should an investor or analyst take away from this disclosure?`,

  "S-1": `This is an IPO Registration Statement (S-1). Extract:
- BUSINESS DESCRIPTION: What does the company do, its market, competitive position, and growth strategy
- IPO DETAILS: Proposed offering size, price range (if disclosed), shares being offered, use of proceeds
- FINANCIAL STATEMENTS: Revenue, gross profit, operating loss/income, net loss/income for the last 2-3 years and any interim periods — exact figures
- GROWTH METRICS: Key operating metrics the company highlights (MAUs, ARR, GMV, etc.)
- CAPITAL STRUCTURE PRE/POST IPO: Existing debt, equity, cap table, and how it changes post-offering
- FINANCING HISTORY: All prior funding rounds, convertible notes, credit facilities — terms, amounts, investors
- RISK FACTORS: The most critical risks specific to this company and IPO
- USE OF PROCEEDS: Exactly how the company plans to use IPO funds
- KEY INSIGHTS: What makes this company compelling or concerning as a public investment?`,

  "DEFAULT": `Extract all available information from this filing, focusing on:
- What type of event or disclosure this filing represents
- All financial figures present in the document with exact values
- The narrative context: what management is saying, what happened, what it means
- Any financing transactions, debt, or capital structure information disclosed
- Risk factors and legal/regulatory matters
- Key insights about what this filing reveals`,
};

export function buildDetectionPrompt(fileRef, isUrl) {
  const source = isUrl
    ? `Fetch and read the document at this exact URL: ${fileRef}`
    : `Read the attached filing document.`;

  return `${source}

You are reading an SEC filing. Extract the following facts ONLY from the document itself — do NOT use any external knowledge or web search results.

Return EXACTLY what is printed on the cover page of this specific document:
- company_name: The exact legal name of the registrant as printed on the cover
- ticker: The trading symbol listed on the cover page
- filing_type: The form type (10-K, 10-Q, 8-K, S-1, etc.) as stated on the cover
- filing_date: The filing date
- period_covered: The fiscal period this filing covers

CRITICAL: Base your answer solely on the text in this document. Do not guess or use outside information.`;
}

export function buildExtractionPrompt(fileRef, isUrl, filingType) {
  const normalizedType = Object.keys(FILING_INSTRUCTIONS).find(
    (k) => filingType?.toUpperCase().includes(k)
  ) || "DEFAULT";

  const instructions = FILING_INSTRUCTIONS[normalizedType];

  const source = isUrl
    ? `Fetch and read the COMPLETE document at this exact URL: ${fileRef} — every page, every table, every footnote, every exhibit reference. Base ALL answers ONLY on the content of this specific document.`
    : `Read every page of the attached filing document — every table, footnote, and schedule. Base ALL answers ONLY on the content of this specific document.`;

  return `You are an expert SEC filing analyst. This is a ${filingType || "SEC filing"}.

${source}

CRITICAL: Do NOT leave fields blank if the information exists anywhere in the document. Read the ENTIRE filing including all notes, exhibits, and schedules before responding.

${instructions}

UNIVERSAL REQUIREMENTS (apply to all filing types):
- Use EXACT figures from tables — never estimate or round unless the filing itself does
- For every financial figure, note the units (millions, thousands, etc.)
- For narrative sections: write substantive summaries, not one-line descriptions
- For financing transactions: extract every field available — rate type, benchmark, spread, floor, maturity, amortization, collateral, covenants, call/put features, underwriters
- executive_summary: Write 4-6 sentences capturing what this filing says, what happened, management's tone, and anything notable or concerning
- key_insights: Provide 5-8 analyst-quality observations — things that are unusual, significant, or worth flagging that may not be obvious from headline numbers`;
}