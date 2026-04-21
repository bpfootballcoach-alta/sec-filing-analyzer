import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { ShieldCheck, ShieldAlert, ShieldX, Info, ExternalLink, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion";

const STATUS_CONFIG = {
  pass: {
    icon: ShieldCheck,
    color: "text-emerald-600",
    bg: "bg-emerald-50 border-emerald-200",
    badge: "bg-emerald-50 text-emerald-700 border-emerald-200",
    label: "Current",
  },
  warn: {
    icon: ShieldAlert,
    color: "text-amber-600",
    bg: "bg-amber-50 border-amber-200",
    badge: "bg-amber-50 text-amber-700 border-amber-200",
    label: "Review",
  },
  fail: {
    icon: ShieldX,
    color: "text-red-600",
    bg: "bg-red-50 border-red-200",
    badge: "bg-red-50 text-red-700 border-red-200",
    label: "Deficient",
  },
  info: {
    icon: Info,
    color: "text-blue-500",
    bg: "bg-blue-50 border-blue-200",
    badge: "bg-blue-50 text-blue-700 border-blue-200",
    label: "Info",
  },
};

function CheckRow({ check }) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[check.status] || STATUS_CONFIG.info;
  const Icon = cfg.icon;

  return (
    <div className={`border rounded-lg overflow-hidden ${check.status === "fail" ? "border-red-200" : check.status === "warn" ? "border-amber-200" : "border-border"}`}>
      <button
        className="w-full flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
        <span className="flex-1 text-sm font-medium text-foreground">{check.label}</span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${cfg.badge}`}>
          {cfg.label}
        </span>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className={`px-4 pb-3 pt-2 border-t text-sm text-muted-foreground leading-relaxed ${cfg.bg}`}>
              <p>{check.detail}</p>
              {check.filingDate && (
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-xs">Most recent {check.filingForm}: <strong className="text-foreground">{check.filingDate}</strong></span>
                  {check.filingUrl && (
                    <a
                      href={check.filingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View on EDGAR <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function RegistrationCurrencyCheck({ ticker }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const runCheck = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    const res = await base44.functions.invoke("checkRegistrationCurrency", { ticker });
    setLoading(false);
    if (res.data?.error) {
      setError(res.data.error);
    } else {
      setResult(res.data);
    }
  };

  const overallCfg = result ? STATUS_CONFIG[result.overallStatus] || STATUS_CONFIG.info : null;
  const OverallIcon = overallCfg?.icon;

  if (!ticker) {
    return (
      <p className="text-sm text-muted-foreground">No ticker symbol available for this filing. Cannot perform registration currency check.</p>
    );
  }

  return (
    <div className="space-y-4">
      {!result && !loading && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Checks annual report timeliness, periodic filings, and Section 10(a)(3) prospectus currency against SEC EDGAR for <strong className="text-foreground">{ticker}</strong>.
          </p>
          <Button onClick={runCheck} size="sm" className="ml-4 flex-shrink-0 bg-accent text-accent-foreground hover:bg-accent/90">
            <ShieldCheck className="w-4 h-4 mr-2" /> Run Check
          </Button>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-3 py-4 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin text-accent" />
          <span className="text-sm">Querying SEC EDGAR for {ticker}...</span>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={runCheck}>Retry</Button>
        </div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
          {/* Overall status banner */}
          <div className={`flex items-center justify-between p-3 rounded-lg border ${overallCfg.bg}`}>
            <div className="flex items-center gap-2">
              <OverallIcon className={`w-5 h-5 ${overallCfg.color}`} />
              <div>
                <span className="text-sm font-semibold text-foreground">
                  {result.overallStatus === "pass" ? "Registration Appears Current" :
                   result.overallStatus === "warn" ? "Registration Requires Review" :
                   "Registration Deficiency Detected"}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {result.isFPI ? "Foreign Private Issuer" : "Domestic Issuer"} · CIK {result.cik} · checked {new Date(result.checkedAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={runCheck} className="flex-shrink-0">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Individual checks */}
          <div className="space-y-2">
            {result.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Data sourced from SEC EDGAR. This is informational only and does not constitute legal advice. Always verify with counsel.
          </p>
        </motion.div>
      )}
    </div>
  );
}