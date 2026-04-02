import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, BarChart3, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import FileUploader from "@/components/filing/FileUploader";
import AnalysisCard from "@/components/filing/AnalysisCard";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.FilingAnalysis.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] }),
  });

  const { data: analyses, isLoading } = useQuery({
    queryKey: ["filingAnalyses"],
    queryFn: () => base44.entities.FilingAnalysis.list("-created_date", 50),
    initialData: [],
  });

  const JSON_SCHEMA = {
    type: "object",
    properties: {
      company_name: { type: "string" },
      ticker: { type: "string" },
      filing_type: { type: "string" },
      filing_date: { type: "string" },
      period_covered: { type: "string" },
      executive_summary: { type: "string" },
      financial_highlights: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, change: { type: "string" }, category: { type: "string" } } } },
      revenue_data: { type: "object", properties: { total_revenue: { type: "string" }, revenue_growth: { type: "string" }, segments: { type: "array", items: { type: "object", properties: { name: { type: "string" }, amount: { type: "string" }, percentage: { type: "string" } } } } } },
      profitability: { type: "object", properties: { gross_margin: { type: "string" }, operating_margin: { type: "string" }, net_margin: { type: "string" }, ebitda: { type: "string" }, eps: { type: "string" } } },
      balance_sheet: { type: "object", properties: { total_assets: { type: "string" }, total_liabilities: { type: "string" }, total_equity: { type: "string" }, cash_and_equivalents: { type: "string" }, total_debt: { type: "string" }, debt_to_equity: { type: "string" } } },
      cash_flow: { type: "object", properties: { operating: { type: "string" }, investing: { type: "string" }, financing: { type: "string" }, free_cash_flow: { type: "string" } } },
      financing_data: { type: "object", properties: { summary: { type: "string" }, details: { type: "array", items: { type: "object", properties: { type: { type: "string" }, description: { type: "string" }, amount: { type: "string" } } } } } },
      capital_structure: {
        type: "object", properties: {
          summary: { type: "string" },
          total_capitalization: { type: "string" },
          equity: { type: "object", properties: { common_equity: { type: "string" }, preferred_equity: { type: "string" }, shares_outstanding: { type: "string" }, market_cap: { type: "string" }, book_value_per_share: { type: "string" }, equity_percentage_of_cap: { type: "string" } } },
          debt: { type: "object", properties: { total_debt: { type: "string" }, short_term_debt: { type: "string" }, long_term_debt: { type: "string" }, debt_percentage_of_cap: { type: "string" }, weighted_average_interest_rate: { type: "string" }, debt_instruments: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, amount: { type: "string" }, maturity: { type: "string" }, interest_rate: { type: "string" }, cost_basis: { type: "string" }, notes: { type: "string" } } } } } },
          other_components: { type: "array", items: { type: "object", properties: { name: { type: "string" }, amount: { type: "string" }, description: { type: "string" } } } }
        }
      },
      financing_activity: {
        type: "object", properties: {
          has_recent_financing: { type: "boolean" },
          summary: { type: "string" },
          transactions: { type: "array", items: { type: "object", properties: { type: { type: "string" }, instrument: { type: "string" }, date: { type: "string" }, amount: { type: "string" }, structure: { type: "string" }, cost_basis: { type: "string" }, interest_rate_or_yield: { type: "string" }, maturity_or_term: { type: "string" }, use_of_proceeds: { type: "string" }, underwriters_or_parties: { type: "string" }, key_terms: { type: "string" } } } }
        }
      },
      narrative_highlights: {
        type: "object", properties: {
          management_commentary: { type: "string" },
          business_developments: { type: "string" },
          legal_regulatory: { type: "string" },
          going_concern_or_restatements: { type: "string" },
          guidance_and_outlook: { type: "string" },
          significant_events: { type: "string" },
          overall_tone: { type: "string" },
        }
      },
      risk_factors: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, severity: { type: "string" } } } },
      key_insights: { type: "array", items: { type: "string" } },
    },
  };

  const analyzeMutation = useMutation({
    mutationFn: async ({ file, url }) => {
      setIsProcessing(true);

      const isUrl = !!url;
      let file_url, fileName;

      if (isUrl) {
        file_url = url;
        fileName = url.split("/").pop().split("?")[0] || url;
      } else {
        const uploaded = await base44.integrations.Core.UploadFile({ file });
        file_url = uploaded.file_url;
        fileName = file.name;
      }

      const record = await base44.entities.FilingAnalysis.create({
        file_name: fileName,
        file_url: file_url,
        status: "processing",
      });

      const prompt = `You are an expert SEC filing analyst with deep expertise in reading financial statements, footnotes, and tables. Your job is to extract PRECISE numerical data directly from the filing — do NOT estimate or summarize if exact figures are present.

${isUrl
  ? `The filing is available at this URL: ${file_url}\nFetch and read the FULL document including all HTML tables, XBRL data, footnotes, and schedules.`
  : `Carefully read every page of the attached filing document including all tables, footnotes, and schedules.`}

CRITICAL INSTRUCTIONS:
1. Read EVERY section of this filing — not just the numbers. The narrative sections are just as important as the tables.
2. Parse all financial tables for exact figures (income statement, balance sheet, cash flows, debt schedules, segment tables).
3. READ AND SUMMARIZE the qualitative narrative sections: MD&A, Business Overview, Risk Factors, Legal Proceedings, CEO/management commentary, forward guidance, and any disclosed strategy or operational changes.

Extract ALL of the following:

1. Company name, ticker, filing type (10-K/10-Q/8-K/S-1/etc), filing date, period covered

2. EXECUTIVE SUMMARY — Write a rich 3-5 sentence summary of what this filing actually says. What happened this period? What is management saying? Are there any warnings, surprises, or notable events disclosed? What is the overall tone — optimistic, cautious, defensive?

3. WHAT IS IN THIS FILING — Summarize the key narrative disclosures:
   - What does management say about the business performance? (MD&A)
   - Are there any major business developments, acquisitions, divestitures, or strategic shifts?
   - Any disclosed legal issues, investigations, or regulatory actions?
   - Any going concern warnings, restatements, or auditor qualifications?
   - Forward-looking guidance or outlook statements from management
   - Any significant events disclosed (layoffs, restructuring, product launches, market changes)

4. Financial highlights with exact figures and YoY changes from tables

5. Revenue breakdown by segment

6. Profitability metrics — gross margin, operating margin, net margin, EBITDA, EPS (basic and diluted)

7. Balance sheet — major line items with exact values

8. Cash flow — operating, investing, financing totals

9. CAPITAL STRUCTURE (from balance sheet + notes):
   - Total capitalization, equity/debt split
   - Equity details: common equity, preferred, shares outstanding, market cap, book value per share
   - Every individual debt instrument: name, type, principal, maturity, rate, cost basis
   - Any convertibles, warrants, or other capital components

10. FINANCING ACTIVITY (from cash flow + notes + disclosures):
    - Every financing transaction with: type, instrument, date, amount, structure, cost basis, rate, maturity, use of proceeds, parties, key terms

11. RISK FACTORS — summarize the most important risks disclosed, not just list headings. What is the company actually warning investors about? Assign severity.

12. KEY INSIGHTS — analyst-level observations about what this filing reveals that may not be obvious from the headline numbers. Flag anything unusual, concerning, or noteworthy in the narrative.

Return exact numbers from tables AND rich qualitative summaries from the narrative sections. Both matter equally.`;

      const analysisResult = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: JSON_SCHEMA,
        ...(isUrl
          ? { add_context_from_internet: true, model: "gemini_3_1_pro" }
          : { file_urls: [file_url], model: "claude_sonnet_4_6" }),
      });

      await base44.entities.FilingAnalysis.update(record.id, {
        ...analysisResult,
        status: "completed",
      });

      return record.id;
    },
    onSuccess: (recordId) => {
      setIsProcessing(false);
      queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] });
      navigate(`/analysis/${recordId}`);
    },
    onError: () => {
      setIsProcessing(false);
    },
  });

  const filteredAnalyses = analyses.filter((a) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      a.company_name?.toLowerCase().includes(q) ||
      a.ticker?.toLowerCase().includes(q) ||
      a.filing_type?.toLowerCase().includes(q) ||
      a.file_name?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
              <BarChart3 className="w-5 h-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground tracking-tight">SEC Filing Analyzer</h1>
              <p className="text-xs text-muted-foreground">AI-powered financial analysis</p>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        {/* Upload Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="mb-5">
            <h2 className="font-display text-2xl font-semibold text-foreground">Upload Filing</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Drop any SEC filing to get a comprehensive financial analysis
            </p>
          </div>
          <FileUploader
            onFileSelected={(file) => analyzeMutation.mutate({ file })}
            onUrlSubmitted={(url) => analyzeMutation.mutate({ url })}
            isProcessing={isProcessing}
          />
        </motion.section>

        {/* Previous Analyses */}
        <section>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="font-display text-2xl font-semibold text-foreground">Analyses</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {analyses.length} filing{analyses.length !== 1 ? "s" : ""} analyzed
              </p>
            </div>
            {analyses.length > 0 && (
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search filings..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
            )}
          </div>

          {isLoading ? (
            <div className="grid gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-card border border-border rounded-xl p-5 animate-pulse">
                  <div className="flex items-start gap-4">
                    <div className="w-11 h-11 rounded-lg bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-muted rounded w-1/3" />
                      <div className="h-3 bg-muted rounded w-1/2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : filteredAnalyses.length === 0 ? (
            <div className="text-center py-16">
              <FileText className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground">
                {searchQuery ? "No filings match your search" : "No filings analyzed yet. Upload one above to get started."}
              </p>
            </div>
          ) : (
            <div className="grid gap-3">
              {filteredAnalyses.map((analysis, i) => (
                <AnalysisCard key={analysis.id} analysis={analysis} index={i} onDelete={(id) => deleteMutation.mutate(id)} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}