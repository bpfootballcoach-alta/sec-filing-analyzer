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

  const { data: analyses, isLoading } = useQuery({
    queryKey: ["filingAnalyses"],
    queryFn: () => base44.entities.FilingAnalysis.list("-created_date", 50),
    initialData: [],
  });

  const analyzeMutation = useMutation({
    mutationFn: async ({ file, url }) => {
      setIsProcessing(true);

      let file_url, fileName;

      if (url) {
        // Use URL directly
        file_url = url;
        fileName = url.split("/").pop().split("?")[0] || url;
      } else {
        // Upload the file
        const uploaded = await base44.integrations.Core.UploadFile({ file });
        file_url = uploaded.file_url;
        fileName = file.name;
      }

      // Create the record in processing state
      const record = await base44.entities.FilingAnalysis.create({
        file_name: fileName,
        file_url: file_url,
        status: "processing",
      });

      // Extract and analyze data using LLM
      const analysisResult = await base44.integrations.Core.InvokeLLM({
        prompt: `You are an expert SEC filing analyst. Analyze this SEC filing document thoroughly and extract ALL relevant financial data.

The file is located at: ${file_url}
File name: ${fileName}

Provide a comprehensive analysis including:
1. Filing metadata (company name, ticker, filing type like 10-K/10-Q/8-K/S-1, filing date, period covered)
2. Executive summary of the filing
3. ALL financial highlights/metrics with current values and YoY changes where available
4. Revenue data with segment breakdown if available
5. Profitability metrics (gross margin, operating margin, net margin, EBITDA, EPS)
6. Balance sheet highlights (total assets, liabilities, equity, cash, debt, debt-to-equity)
7. Cash flow summary (operating, investing, financing, free cash flow)
8. Financing and capital structure details (debt instruments, credit facilities, equity offerings, etc.)
9. Key risk factors with severity assessment
10. Notable insights and observations

Be thorough - extract every number, percentage, and financial metric you can find.`,
        file_urls: [file_url],
        model: "claude_sonnet_4_6",
        response_json_schema: {
          type: "object",
          properties: {
            company_name: { type: "string" },
            ticker: { type: "string" },
            filing_type: { type: "string" },
            filing_date: { type: "string" },
            period_covered: { type: "string" },
            executive_summary: { type: "string" },
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
            key_insights: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      });

      // Update the record with analysis results
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
                <AnalysisCard key={analysis.id} analysis={analysis} index={i} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}