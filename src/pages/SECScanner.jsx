import React, { useState } from "react";
import { functions } from "@/api/apiClient";

import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileSearch,
  Search,
  Loader2,
  ExternalLink,
  FileText,
  ArrowLeft,
  Hash,
} from "lucide-react";
import { isRegistrationForm } from "../../supabase/functions/_shared/registrationFilings.ts";

const EXAMPLE_TICKERS = ["ANNA", "AAPL", "NVDA", "TSLA", "GME"];

// Ticker or CIK lookup
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
      const res = await functions.invoke("fetchAndAnalyzeFiling", { ticker: t });
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
        <label htmlFor="scanner-company" className="block text-xs text-white/40 uppercase tracking-wider mb-2">
          Enter ticker or CIK
        </label>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              id="scanner-company"
              type="text"
              placeholder="e.g. AAPL or 0000320193"
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
            Find filings
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

// Filing list: native links open EDGAR without invoking application APIs.
export function FilingSelectStep({ ticker, companyName, cik, filings, onBack }) {
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
          <span className="text-xs text-white/40 uppercase tracking-wider">Registration statements</span>
          <span className="ml-2 text-sm font-semibold text-white">{companyName}</span>
          <span className="ml-2 text-xs font-mono text-emerald-400">{ticker || `CIK ${cik}`}</span>
        </div>
      </div>

      {filings.length === 0 && (
        <p className="text-sm text-white/50">No S/F registration statements found for this company.</p>
      )}
      <div className="space-y-2">
        {filings.map((filing) => {
          return (
            <a
              key={filing.accession}
              href={filing.url}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-between bg-white/[0.03] border border-white/[0.06] hover:border-emerald-500/30 hover:bg-white/[0.06] rounded-xl px-4 py-3.5 transition-all text-left group flex-wrap gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center flex-shrink-0">
                  <FileText className="w-4 h-4 text-white/30 group-hover:text-emerald-400 transition-colors" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                      {filing.form}
                    </span>
                  </div>
                  <p className="text-xs text-white/30 mt-0.5 flex items-center gap-1">
                    Filed {filing.date}
                  </p>
                  <p className="text-xs font-mono text-white/40 mt-1 break-all flex items-center gap-1">
                    <Hash className="w-3 h-3 shrink-0" /> {filing.accession}
                  </p>
                </div>
              </div>
              <span className="text-xs text-emerald-400 flex items-center gap-1 shrink-0 ml-3">
                Open on SEC EDGAR <ExternalLink className="w-3 h-3" />
              </span>
            </a>
          );
        })}
      </div>

      <p className="text-xs text-white/20 pt-2">
        Showing {filings.length} S/F registration statements. Click a filing to open it on SEC EDGAR.
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
      <p className="text-white/30 text-base font-medium">Enter a ticker or CIK above to get started</p>
      <p className="text-white/15 text-sm mt-1">Browse S/F registration statements, including S-4, F-4 and amendments</p>
    </motion.div>
  );
}

export default function SECScanner() {
  const [step, setStep] = useState("ticker"); // "ticker" | "select"
  const [tickerData, setTickerData] = useState(null);
  const navigate = useNavigate();
  const handleTickerNext = (data) => {
    setTickerData({ ...data, filings: (data.filings || []).filter(filing => isRegistrationForm(filing.form)) });
    setStep("select");
  };

  const handleBack = () => {
    setStep("ticker");
    setTickerData(null);
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
            Find S/F registration statements and amendments. Open filings directly on SEC EDGAR.
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
              cik={tickerData.cik}
              filings={tickerData.filings}
              onBack={handleBack}
            />
          )}
        </AnimatePresence>

        {/* Empty state — shown only on ticker step before a search */}
        {step === "ticker" && (
          <EmptyState />
        )}

      </div>
      </div>
    </div>
  );
}