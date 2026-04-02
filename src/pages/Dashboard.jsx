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

      const prompt = `You are an expert SEC filing analyst. Analyze this SEC filing thoroughly and extract ALL relevant financial data.

${isUrl ? `The filing URL is: ${file_url}\nFetch and read the full content at that URL.` : `File name: ${fileName}`}

Extract the following comprehensively:
1. Company name, ticker, filing type (10-K/10-Q/8-K/S-1/etc), filing date, period covered
2. Executive summary
3. ALL financial metrics with YoY changes
4. Revenue breakdown by segment
5. Profitability metrics (gross margin, operating margin, net margin, EBITDA, EPS)
6. Balance sheet highlights
7. Cash flow summary (operating, investing, financing, free cash flow)
8. CAPITAL STRUCTURE: Provide a full breakdown of the company's capital structure including:
   - Total capitalization and the equity/debt split (as % of total cap)
   - Equity: common equity, preferred equity, shares outstanding, market cap, book value per share
   - Debt: total debt, short-term vs long-term, weighted average interest rate
   - ALL individual debt instruments (bonds, notes, credit facilities, term loans, etc.) with: name, type, outstanding amount, maturity date, interest rate, and cost basis (issue price or yield-to-maturity if available)
   - Any other capital components (warrants, convertibles, etc.)
9. FINANCING ACTIVITY: Identify any recent or disclosed financing transactions in this filing period:
   - Type of financing (equity offering, debt issuance, credit facility, convertible notes, IPO, etc.)
   - Instrument name/description
   - Transaction date
   - Amount raised
   - Detailed structure of the financing
   - Cost basis (price per share, issue price, spread, yield, OID, etc.)
   - Interest rate or yield (if debt)
   - Maturity or term
   - Use of proceeds
   - Underwriters or counterparties
   - Key terms and covenants
10. Key risk factors with severity levels
11. Notable insights and observations

Be extremely thorough on capital structure and financing — extract every debt instrument and financing transaction mentioned.`;

      const analysisResult = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: JSON_SCHEMA,
        ...(isUrl
          ? { add_context_from_internet: true, model: "gemini_3_pro" }
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