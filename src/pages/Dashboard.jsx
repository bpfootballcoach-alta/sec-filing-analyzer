import React, { useState } from "react";
import { FilingAnalysis, functions, llm, uploadFile, getGeminiApiKey, setGeminiApiKey } from "@/api/apiClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, BarChart3, Search, FileSearch, Settings, Key, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { toast } from "sonner";
import FileUploader from "@/components/filing/FileUploader";
import AnalysisCard from "@/components/filing/AnalysisCard";
import RegStatementChecker from "@/components/filing/RegStatementChecker";
import { useNavigate, Link } from "react-router-dom";
import {
  EXTRACTION_SCHEMA,
  buildExtractionPrompt,
} from "@/lib/filingAnalysis";

export default function Dashboard() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const deleteMutation = useMutation({
    mutationFn: (id) => FilingAnalysis.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] }),
  });

  const { data: analyses, isLoading } = useQuery({
    queryKey: ["filingAnalyses"],
    queryFn: () => FilingAnalysis.list("-created_date", 50),
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
        const uploaded = await uploadFile({ file });
        file_url = uploaded.file_url;
        fileName = file.name;
      }

      // Create record immediately so user can see it processing
      const record = await FilingAnalysis.create({
        file_name: fileName,
        file_url: file_url,
        status: "processing",
      });

      try {
        let extractionResult;
        if (isUrl) {
          // For SEC URLs: fetch server-side (bypasses CORS/bot blocking)
          const fetchRes = await functions.invoke("fetchAndAnalyzeFiling", { url: file_url });
          if (!fetchRes.data?.content) {
            throw new Error(fetchRes.data?.error || "Failed to fetch filing from URL");
          }
          // Use the fetched content as context for LLM extraction
          const contentSnippet = fetchRes.data.content.slice(0, 200000);
          extractionResult = await llm.invoke({
            prompt: buildExtractionPrompt(file_url, false, null) + `\n\nFILING CONTENT:\n${contentSnippet}`,
            response_json_schema: EXTRACTION_SCHEMA,
            model: "gemini-2.0-flash",
          });
        } else {
          // For uploaded files: include the file URL reference
          extractionResult = await llm.invoke({
            prompt: buildExtractionPrompt(file_url, false, null),
            response_json_schema: EXTRACTION_SCHEMA,
            model: "gemini-2.0-flash",
          });
        }

        await FilingAnalysis.update(record.id, {
          ...extractionResult,
          status: "completed",
        });
      } catch (err) {
        // Mark as failed so the user can see it and delete it
        await FilingAnalysis.update(record.id, { status: "failed" });
        throw err;
      }

      return record.id;
    },
    onSuccess: (recordId) => {
      setIsProcessing(false);
      queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] });
      navigate(`/analysis/${recordId}`);
    },
    onError: (err) => {
      setIsProcessing(false);
      queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] });
      const errMsg = err?.response?.data?.error || err?.message || "Failed to analyze filing";
      toast.error(errMsg);
      console.error("Analysis error:", err);
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

  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(getGeminiApiKey());

  const handleSaveApiKey = () => {
    setGeminiApiKey(apiKeyInput.trim());
    setShowSettings(false);
    toast.success(apiKeyInput.trim() ? "API key saved" : "API key removed");
  };

  const hasApiKey = !!getGeminiApiKey();

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
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 transition-all ${
                hasApiKey
                  ? 'text-muted-foreground hover:text-foreground border-border hover:border-accent/50'
                  : 'text-amber-600 border-amber-300 bg-amber-50 hover:bg-amber-100'
              }`}
            >
              <Settings className="w-4 h-4" />
              {hasApiKey ? 'Settings' : 'Set API Key'}
            </button>
            <Link to="/sec-scanner">
              <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground border border-border hover:border-accent/50 rounded-lg px-3 py-2 transition-all">
                <FileSearch className="w-4 h-4" /> SEC Scanner
              </button>
            </Link>
          </div>
        </div>
      </header>

      {/* API Key Settings Banner */}
      {showSettings && (
        <div className="bg-card border-b border-border">
          <div className="max-w-6xl mx-auto px-6 py-4">
            <div className="flex items-start gap-3">
              <Key className="w-5 h-5 text-muted-foreground mt-0.5" />
              <div className="flex-1 space-y-2">
                <h3 className="text-sm font-semibold text-foreground">Gemini API Key</h3>
                <p className="text-xs text-muted-foreground">
                  Required for AI analysis features (filing extraction, chat, source lookup). Get a free key from{' '}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    Google AI Studio
                  </a>.
                  The key is stored locally in your browser only.
                </p>
                <div className="flex gap-2 max-w-lg">
                  <Input
                    type="password"
                    placeholder="AIza..."
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    className="text-sm"
                  />
                  <Button size="sm" onClick={handleSaveApiKey} className="gap-1">
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setShowSettings(false)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Missing API Key Warning */}
      {!hasApiKey && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-2">
            <Key className="w-4 h-4 text-amber-600" />
            <p className="text-sm text-amber-800">
              AI features require a Gemini API key.{' '}
              <button onClick={() => setShowSettings(true)} className="font-semibold underline hover:no-underline">
                Set your key
              </button>{' '}
              to enable filing analysis, chat, and source lookup.
            </p>
          </div>
        </div>
      )}

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-10">
        {/* Registration Statement Currency Checker */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <RegStatementChecker />
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