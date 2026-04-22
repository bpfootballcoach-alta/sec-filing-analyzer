import React, { useState } from "react";
import RegStatementChat from "./RegStatementChat";
import { base44 } from "@/api/base44Client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck, ShieldAlert, ShieldX, Search, ArrowRight,
  ChevronDown, ChevronUp, ExternalLink, ArrowLeft, Loader2,
  FileText, Info
} from "lucide-react";

// Status config for INDIVIDUAL checks — "pass" means this specific item checks out, NOT that the whole reg is current
const STATUS_CONFIG = {
  pass: { icon: ShieldCheck, color: "text-emerald-600", bg: "bg-emerald-50 border-emerald-200", badge: "bg-emerald-100 text-emerald-700", label: "OK" },
  warn: { icon: ShieldAlert, color: "text-amber-600", bg: "bg-amber-50 border-amber-200", badge: "bg-amber-100 text-amber-700", label: "Warning" },
  fail: { icon: ShieldX, color: "text-red-600", bg: "bg-red-50 border-red-200", badge: "bg-red-100 text-red-700", label: "Deficient" },
  info: { icon: Info, color: "text-blue-600", bg: "bg-blue-50 border-blue-200", badge: "bg-blue-100 text-blue-700", label: "Info" },
};

// Overall verdict config — this is the only place "Current" / "Not Current" appears
const VERDICT_CONFIG = {
  pass: { icon: ShieldCheck, color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-300", badge: "bg-emerald-600 text-white", label: "REGISTRATION IS CURRENT" },
  warn: { icon: ShieldAlert, color: "text-amber-700", bg: "bg-amber-50 border-amber-300", badge: "bg-amber-500 text-white", label: "ISSUES REQUIRE REVIEW" },
  fail: { icon: ShieldX, color: "text-red-700", bg: "bg-red-50 border-red-300", badge: "bg-red-600 text-white", label: "REGISTRATION IS NOT CURRENT" },
};

function CheckRow({ check }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[check.status] || STATUS_CONFIG.info;
  const Icon = cfg.icon;

  return (
    <div className={`border rounded-lg overflow-hidden ${cfg.bg}`}>
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left gap-3"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
          <span className="text-sm font-medium text-foreground truncate">{check.label}</span>
          {check.count !== undefined && (
            <span className="text-xs text-muted-foreground flex-shrink-0">({check.count} filed)</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge className={`text-xs border-0 ${cfg.badge}`}>{cfg.label}</Badge>
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-0 space-y-2 border-t border-border/40">
          <p className="text-sm text-muted-foreground leading-relaxed">{check.detail}</p>
          {check.filingDate && (
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{check.filingForm} — {check.filingDate}</span>
              {check.filingUrl && (
                <a href={check.filingUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline">
                  View on EDGAR <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RegStatementChecker() {
  const [ticker, setTicker] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [regList, setRegList] = useState(null);     // list mode result
  const [detailResult, setDetailResult] = useState(null); // detail mode result
  const [selectedReg, setSelectedReg] = useState(null);

  const handleTickerSearch = async () => {
    const t = ticker.trim().toUpperCase();
    if (!t) return;

    // Validate it looks like a ticker (1–6 uppercase letters/numbers, optional dot)
    if (t.length > 10 || t.includes("/") || t.includes("\\") || t.startsWith("HTTP")) {
      setError("Please enter a ticker symbol (e.g. AAPL, MSFT) — not a URL.");
      return;
    }

    setLoading(true);
    setError("");
    setRegList(null);
    setDetailResult(null);
    setSelectedReg(null);
    const res = await base44.functions.invoke("checkRegStatementCurrency", { ticker: t });
    setLoading(false);
    if (res.data?.error) { setError(res.data.error); return; }
    if (res.data?.registrationStatements?.length === 0) {
      setError(`No registration statements found for ${t} on EDGAR.`);
      return;
    }
    setRegList(res.data);
  };

  const handleSelectReg = async (reg) => {
    setSelectedReg(reg);
    setLoading(true);
    setError("");
    setDetailResult(null);
    const res = await base44.functions.invoke("checkRegStatementCurrency", {
      ticker: regList.ticker,
      accession: reg.accession,
    });
    setLoading(false);
    if (res.data?.error) { setError(res.data.error); return; }
    setDetailResult(res.data);
  };

  const handleReset = () => {
    setDetailResult(null);
    setSelectedReg(null);
  };

  const overallCfg = detailResult ? (VERDICT_CONFIG[detailResult.overallStatus] || VERDICT_CONFIG.warn) : null;

  return (
    <div className="bg-card border border-border rounded-xl p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Registration Statement Currency</h2>
          <p className="text-xs text-muted-foreground">Check if a company's registration statements are current under Section 10(a)(3)</p>
        </div>
      </div>

      {/* Ticker Input */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Enter ticker symbol (e.g. ANNA, AAPL)"
            value={ticker}
            onChange={e => { setTicker(e.target.value.toUpperCase().replace(/\s/g, "")); setError(""); }}
            onKeyDown={e => e.key === "Enter" && handleTickerSearch()}
            className="pl-9 uppercase"
          />
        </div>
        <Button onClick={handleTickerSearch} disabled={!ticker.trim() || loading} className="gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
          Search
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Step 1: List of registration statements */}
      {regList && !detailResult && (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-semibold text-foreground">{regList.companyName}</p>
            <p className="text-xs text-muted-foreground">{regList.registrationStatements.length} registration statement(s) found — select one to deep-check its currency</p>
          </div>
          <div className="space-y-2">
            {regList.registrationStatements.map((reg) => (
              <button
                key={reg.accession}
                onClick={() => handleSelectReg(reg)}
                disabled={loading && selectedReg?.accession === reg.accession}
                className="w-full flex items-center justify-between bg-background border border-border rounded-lg px-4 py-3 hover:border-accent/50 hover:bg-muted/40 transition-all text-left group"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-muted-foreground group-hover:text-accent transition-colors" />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary" className="text-xs">{reg.form}</Badge>
                      <span className="text-sm font-medium text-foreground">{reg.date}</span>
                      {reg.registrationNumber && (
                        <span className="text-xs font-mono text-muted-foreground">Reg. No. {reg.registrationNumber}</span>
                      )}
                      {reg.effective === false && (
                        <Badge className="text-xs border-0 bg-red-100 text-red-700">Not Effective</Badge>
                      )}
                      {reg.effective === true && (
                        <Badge className="text-xs border-0 bg-emerald-100 text-emerald-700">Effective</Badge>
                      )}

                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{reg.daysOld} days ago{reg.effectDate ? ` · Effective ${reg.effectDate}` : ""}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {reg.url && (
                    <a href={reg.url} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1">
                      EDGAR <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {loading && selectedReg?.accession === reg.accession
                    ? <Loader2 className="w-4 h-4 animate-spin text-accent" />
                    : <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-accent transition-colors" />
                  }
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 2: Detail result */}
      {detailResult && (
        <div className="space-y-4">
          {/* Back button */}
          <button onClick={handleReset} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back to all statements
          </button>

          {/* Overall verdict banner — the ONLY place "current" / "not current" appears */}
          <div className={`rounded-xl border-2 p-5 ${overallCfg.bg}`}>
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                {React.createElement(overallCfg.icon, { className: `w-7 h-7 flex-shrink-0 ${overallCfg.color}` })}
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className={`text-sm font-bold px-3 py-1 border-0 ${overallCfg.badge}`}>{overallCfg.label}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {detailResult.registration.form} filed {detailResult.registration.date} · {detailResult.companyName} ({detailResult.ticker}) · {detailResult.registration.isShelf ? "Shelf" : "Non-Shelf"}{detailResult.registration.isFPI ? " · FPI" : ""}{detailResult.registration.isFForm ? ` · F-form (${detailResult.registration.annualLimitMonths}mo annual / ${detailResult.registration.interimLimitMonths}mo interim)` : ""}
                  </p>
                </div>
              </div>
              {detailResult.registration.url && (
                <a href={detailResult.registration.url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs">
                    EDGAR <ExternalLink className="w-3 h-3" />
                  </Button>
                </a>
              )}
            </div>

            {/* AI-generated plain-English summary */}
            {detailResult.aiSummary && (
              <div className="mt-4 pt-4 border-t border-border/40 space-y-2">
                <p className="text-sm font-medium text-foreground leading-relaxed">{detailResult.aiSummary.summary}</p>
                {detailResult.aiSummary.key_issue && (
                  <p className="text-xs text-muted-foreground"><span className="font-semibold">Key Issue:</span> {detailResult.aiSummary.key_issue}</p>
                )}
                {detailResult.aiSummary.required_action && (
                  <p className="text-xs text-muted-foreground"><span className="font-semibold">Required Action:</span> {detailResult.aiSummary.required_action}</p>
                )}
              </div>
            )}
          </div>

          {/* Individual checks */}
          <div className="space-y-2">
            {detailResult.checks.map(check => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>

          <p className="text-xs text-muted-foreground text-right">
            Checked {new Date(detailResult.checkedAt).toLocaleString()}
          </p>

          {/* AI Follow-Up Chat */}
          <RegStatementChat detailResult={detailResult} />
        </div>
      )}
    </div>
  );
}