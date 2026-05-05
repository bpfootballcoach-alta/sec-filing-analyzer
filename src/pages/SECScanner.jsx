import React, { useState } from "react";
import { base44 } from "@/api/base44Client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileSearch,
  Search,
  ArrowRight,
  Loader2,
  ExternalLink,
  FileText,
  ChevronRight,
  ArrowLeft,
  Calendar,
  Hash,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  EXTRACTION_SCHEMA,
  buildExtractionPrompt,
} from "@/lib/filingAnalysis";

const EXAMPLE_TICKERS = ["ANNA", "AAPL", "NVDA", "TSLA", "GME"];

const FILING_TYPE_COLORS = {
  "10-K":  "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "10-Q":  "bg-purple-500/10 text-purple-400 border-purple-500/20",
  "8-K":   "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  "S-1":   "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "S-3":   "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "DEF14A":"bg-orange-500/10 text-orange-400 border-orange-500/20",
  "20-F":  "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
};

function getFilingColor(form) {
  for (const [key, val] of Object.entries(FILING_TYPE_COLORS)) {
    if (form?.startsWith(key)) return val;
  }
  return "bg-white/10 text-white/50 border-white/10";
}

// Step 1 — Ticker input
function TickerStep({ onNext }) {
  const [ticker, setTicker] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    setLoading(true);
    setError("");
    try {
      const res = await base44.functions.invoke("fetchAndAnalyzeFiling", { ticker: t });
      if (res.data?.error) {
        setError(res.data.error);
        return;
      }
      onNext(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || "Failed to fetch filings from EDGAR");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="mb-6 max-w-md"
    >
      <form onSubmit={handleSubmit}>
        <label className="block text-xs text-white/40 uppercase tracking-wider mb-2">
          Step 1 — Enter Ticker
        </label>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              type="text"
              placeholder="e.g. ANNA, AAPL, NVDA"
              value={ticker}
              onChange={(e) => {
                setTicker(e.target.value.toUpperCase().replace(/\s/g, ""));
                setError("");
              }}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl text-white pl-10 pr-4 py-3 placeholder:text-white/20 focus:outline-none focus:border-emerald-500/40 transition-all text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={!ticker.trim() || loading}
            className="flex items-center gap-2 bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 disabled:opacity-40 text-white font-semibold rounded-xl px-5 py-3 transition-all text-sm"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            Next →
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          {EXAMPLE_TICKERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTicker(t); setError(""); }}
              className="px-3 py-1 text-xs font-mono text-white/30 border border-white/10 rounded-lg hover:border-emerald-500/40 hover:text-emerald-400 transition-all"
            >
              {t}
            </button>
          ))}
        </div>
      </form>
      {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
    </motion.div>
  );
}

// Step 2 — Filing selection
function FilingSelectStep({ ticker, companyName, filings, onBack, onSelect, isAnalyzing, selectedAccession }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="space-y-4"
    >
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-white/30 hover:text-white/60 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="h-4 w-px bg-white/10" />
        <div>
          <span className="text-xs text-white/40 uppercase tracking-wider">Step 2 — Select Filing</span>
          <span className="ml-2 text-sm font-semibold text-white">{companyName}</span>
          <span className="ml-2 text-xs font-mono text-emerald-400">{ticker}</span>
        </div>
      </div>

      <div className="space-y-2">
        {filings.map((filing) => {
          const isSelected = selectedAccession === filing.accession;
          const colorClass = getFilingColor(filing.form);
          return (
            <button
              key={filing.accession}
              onClick={() => onSelect(filing)}
              disabled={isAnalyzing}
              className="w-full flex items-center justify-between bg-white/[0.03] border border-white/[0.06] hover:border-emerald-500/30 hover:bg-white/[0.06] rounded-xl px-4 py-3.5 transition-all text-left group disabled:opacity-50"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-white/30 group-hover:text-emerald-400 transition-colors" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${colorClass}`}>
                      {filing.form}
                    </span>
                    {filing.period && (
                      <span className="text-xs text-white/30 flex items-center gap-1">
                        <Calendar className="w-3 h-3" /> {filing.period}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/30 mt-0.5 flex items-center gap-1">
                    <Hash className="w-3 h-3" /> Filed {filing.date}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={filing.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-white/20 hover:text-white/50 transition-colors flex items-center gap-1"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
                {isAnalyzing && isSelected ? (
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-emerald-400 transition-colors" />
                )}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-white/20 pt-2">
        Showing {filings.length} most recent filings. Click any row to analyze.
      </p>
    </motion.div>
  );
}

// Empty state
function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col items-center justify-center min-h-[300px] rounded-2xl border border-white/[0.04] bg-white/[0.01] text-center p-10 mt-4"
    >
      <FileSearch className="w-14 h-14 text-white/10 mb-4" />
      <p className="text-white/30 text-base font-medium">Enter a ticker above to get started</p>
      <p className="text-white/15 text-sm mt-1">Then paste a document link or auto-fetch the latest filing</p>
    </motion.div>
  );
}

export default function SECScanner() {
  const [step, setStep] = useState("ticker"); // "ticker" | "select"
  const [tickerData, setTickerData] = useState(null);
  const [selectedAccession, setSelectedAccession] = useState(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const analyzeMutation = useMutation({
    mutationFn: async (filing) => {
      setSelectedAccession(filing.accession);

      // Create a processing record
      const record = await base44.entities.FilingAnalysis.create({
        file_name: `${tickerData.ticker} ${filing.form} ${filing.date}`,
        file_url: filing.url,
        ticker: tickerData.ticker,
        company_name: tickerData.companyName,
        filing_type: filing.form,
        filing_date: filing.date,
        period_covered: filing.period,
        status: "processing",
      });

      try {
        // Fetch server-side to bypass CORS
        const fetchRes = await base44.functions.invoke("fetchAndAnalyzeFiling", { url: filing.url });
        if (!fetchRes.data?.file_url) {
          throw new Error(fetchRes.data?.error || "Failed to fetch filing from SEC EDGAR");
        }

        const extractionResult = await base44.integrations.Core.InvokeLLM({
          prompt: buildExtractionPrompt(fetchRes.data.file_url, false, null),
          response_json_schema: EXTRACTION_SCHEMA,
          model: "gemini_3_flash",
          file_urls: [fetchRes.data.file_url],
        });

        await base44.entities.FilingAnalysis.update(record.id, {
          ...extractionResult,
          status: "completed",
        });
      } catch (err) {
        await base44.entities.FilingAnalysis.update(record.id, { status: "failed" });
        throw err;
      }

      return record.id;
    },
    onSuccess: (recordId) => {
      queryClient.invalidateQueries({ queryKey: ["filingAnalyses"] });
      navigate(`/analysis/${recordId}`);
    },
    onError: (err) => {
      setSelectedAccession(null);
      const msg = err?.response?.data?.error || err?.message || "Failed to analyze filing";
      toast.error(msg);
    },
  });

  const handleTickerNext = (data) => {
    setTickerData(data);
    setStep("select");
  };

  const handleBack = () => {
    setStep("ticker");
    setTickerData(null);
    setSelectedAccession(null);
  };

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Nav */}
      <nav className="border-b border-white/[0.06] bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 md:px-8 py-3 flex items-center justify-between">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-2 text-sm text-white/30 hover:text-white/60 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Dashboard
          </button>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-emerald-500/20 flex items-center justify-center">
              <FileSearch className="w-3.5 h-3.5 text-emerald-400" />
            </div>
            <span className="text-sm font-semibold text-white/60">SEC Scanner</span>
          </div>
        </div>
      </nav>

      <div className="px-4 py-10 md:px-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <FileSearch className="w-6 h-6 text-emerald-400" />
            </div>
            <h1 className="text-3xl font-bold text-white">SEC Document Scanner</h1>
          </div>
          <p className="text-white/40 text-sm ml-14">
            AI-powered analysis of SEC filings — capital structure, financials, deals, warrants, and more.
          </p>
        </motion.div>

        {/* Steps */}
        <AnimatePresence mode="wait">
          {step === "ticker" && (
            <TickerStep key="ticker" onNext={handleTickerNext} />
          )}
          {step === "select" && tickerData && (
            <FilingSelectStep
              key="select"
              ticker={tickerData.ticker}
              companyName={tickerData.companyName}
              filings={tickerData.filings}
              onBack={handleBack}
              onSelect={(filing) => analyzeMutation.mutate(filing)}
              isAnalyzing={analyzeMutation.isPending}
              selectedAccession={selectedAccession}
            />
          )}
        </AnimatePresence>

        {/* Empty state — shown only on ticker step before a search */}
        {step === "ticker" && (
          <EmptyState />
        )}

        {/* Analyzing overlay hint */}
        {analyzeMutation.isPending && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-6 flex items-center gap-3 text-sm text-emerald-400/70"
          >
            <Zap className="w-4 h-4 animate-pulse" />
            Fetching filing and running AI analysis — this may take 30–60 seconds...
          </motion.div>
        )}
      </div>
      </div>
    </div>
  );
}