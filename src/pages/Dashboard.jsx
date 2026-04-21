import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, BarChart3, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { motion } from "framer-motion";
import FileUploader from "@/components/filing/FileUploader";
import AnalysisCard from "@/components/filing/AnalysisCard";
import { useNavigate } from "react-router-dom";
import {
  DETECTION_SCHEMA,
  EXTRACTION_SCHEMA,
  buildDetectionPrompt,
  buildExtractionPrompt,
  buildDetectionPromptJson,
  buildExtractionPromptJson,
  parseJsonFromText,
} from "@/lib/filingAnalysis";

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

  const analyzeMutation = useMutation({
    mutationFn: async ({ file, url }) => {
      setIsProcessing(true);

      const isUrl = !!url;
      let file_url, fileName;

      if (isUrl) {
        // Convert SEC iXBRL viewer URLs (ix?doc=...) to the direct document URL
        let resolvedUrl = url;
        const ixMatch = url.match(/[?&]doc=([^&]+)/);
        if (ixMatch) {
          const docPath = decodeURIComponent(ixMatch[1]);
          resolvedUrl = docPath.startsWith("http") ? docPath : `https://www.sec.gov${docPath}`;
        }
        file_url = resolvedUrl;
        fileName = resolvedUrl.split("/").pop().split("?")[0] || resolvedUrl;
      } else {
        const uploaded = await base44.integrations.Core.UploadFile({ file });
        file_url = uploaded.file_url;
        fileName = file.name;
      }

      // Create record immediately so user can see it processing
      const record = await base44.entities.FilingAnalysis.create({
        file_name: fileName,
        file_url: file_url,
        status: "processing",
      });

      // Determine how to pass the document to the LLM
      // PDFs → file_urls + response_json_schema (gemini_3_flash)
      // HTML URLs → add_context_from_internet (gemini_3_1_pro) but gemini does NOT support
      // response_json_schema with search. So for URLs we ask for JSON in the prompt and parse it.
      const isPdf = file_url.toLowerCase().endsWith(".pdf");

      let detectionResult, extractionResult;

      if (isPdf) {
        // PDF path: structured JSON schema supported
        detectionResult = await base44.integrations.Core.InvokeLLM({
          prompt: buildDetectionPrompt(file_url, false),
          response_json_schema: DETECTION_SCHEMA,
          model: "gemini_3_flash",
          file_urls: [file_url],
        });

        const filingType = detectionResult.filing_type || "Unknown";
        await base44.entities.FilingAnalysis.update(record.id, {
          company_name: detectionResult.company_name,
          ticker: detectionResult.ticker,
          filing_type: filingType,
          filing_date: detectionResult.filing_date,
          period_covered: detectionResult.period_covered,
        });

        extractionResult = await base44.integrations.Core.InvokeLLM({
          prompt: buildExtractionPrompt(file_url, false, filingType),
          response_json_schema: EXTRACTION_SCHEMA,
          model: "gemini_3_flash",
          file_urls: [file_url],
        });
      } else {
        // URL path: gemini + search cannot use response_json_schema — ask for JSON in prompt, parse result
        const detectionRaw = await base44.integrations.Core.InvokeLLM({
          prompt: buildDetectionPromptJson(file_url),
          model: "gemini_3_1_pro",
          add_context_from_internet: true,
        });
        detectionResult = parseJsonFromText(detectionRaw);

        const filingType = detectionResult.filing_type || "Unknown";
        await base44.entities.FilingAnalysis.update(record.id, {
          company_name: detectionResult.company_name,
          ticker: detectionResult.ticker,
          filing_type: filingType,
          filing_date: detectionResult.filing_date,
          period_covered: detectionResult.period_covered,
        });

        const extractionRaw = await base44.integrations.Core.InvokeLLM({
          prompt: buildExtractionPromptJson(file_url, filingType),
          model: "gemini_3_1_pro",
          add_context_from_internet: true,
        });
        extractionResult = parseJsonFromText(extractionRaw);
      }

      await base44.entities.FilingAnalysis.update(record.id, {
        ...extractionResult,
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