import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Building2,
  Calendar,
  FileText,
  BarChart3,
  DollarSign,
  Landmark,
  AlertTriangle,
  Lightbulb,
  TrendingUp,
  Wallet,
  Loader2,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { motion } from "framer-motion";

import MetricsGrid from "@/components/filing/MetricsGrid";
import SectionCard from "@/components/filing/SectionCard";
import BalanceSheetTable from "@/components/filing/BalanceSheetTable";
import CashFlowTable from "@/components/filing/CashFlowTable";
import ProfitabilityTable from "@/components/filing/ProfitabilityTable";
import RevenueBreakdown from "@/components/filing/RevenueBreakdown";
import RiskFactorsList from "@/components/filing/RiskFactorsList";
import FinancingDetails from "@/components/filing/FinancingDetails";

export default function AnalysisDetail() {
  const urlParams = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split("/");
  const analysisId = pathParts[pathParts.length - 1];

  const { data: analysis, isLoading } = useQuery({
    queryKey: ["filingAnalysis", analysisId],
    queryFn: async () => {
      const items = await base44.entities.FilingAnalysis.filter({ id: analysisId });
      return items[0];
    },
    enabled: !!analysisId,
    refetchInterval: (query) => {
      return query.state.data?.status === "processing" ? 3000 : false;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!analysis) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Analysis not found.</p>
        <Link to="/">
          <Button variant="outline">Go Back</Button>
        </Link>
      </div>
    );
  }

  if (analysis.status === "processing") {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-6 py-4">
            <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back to Dashboard
            </Link>
          </div>
        </header>
        <div className="flex flex-col items-center justify-center py-32 gap-6">
          <Loader2 className="w-12 h-12 animate-spin text-accent" />
          <div className="text-center">
            <h2 className="text-xl font-semibold text-foreground">Analyzing Filing</h2>
            <p className="text-muted-foreground mt-2">Extracting financial data and insights...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          {analysis.file_url && (
            <a href={analysis.file_url} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm">
                <ExternalLink className="w-4 h-4 mr-2" /> View Original
              </Button>
            </a>
          )}
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {/* Filing Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            {analysis.filing_type && (
              <Badge className="bg-accent text-accent-foreground border-0 text-sm px-3 py-1">
                {analysis.filing_type}
              </Badge>
            )}
            {analysis.ticker && (
              <Badge variant="outline" className="text-sm px-3 py-1">
                {analysis.ticker}
              </Badge>
            )}
          </div>
          <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground tracking-tight">
            {analysis.company_name || analysis.file_name}
          </h1>
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
            {analysis.company_name && analysis.file_name && (
              <span className="flex items-center gap-1.5">
                <FileText className="w-4 h-4" /> {analysis.file_name}
              </span>
            )}
            {analysis.filing_date && (
              <span className="flex items-center gap-1.5">
                <Calendar className="w-4 h-4" /> Filed: {analysis.filing_date}
              </span>
            )}
            {analysis.period_covered && (
              <span className="flex items-center gap-1.5">
                <Building2 className="w-4 h-4" /> Period: {analysis.period_covered}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Calendar className="w-4 h-4" /> Analyzed: {format(new Date(analysis.created_date), "MMM d, yyyy")}
            </span>
          </div>
        </motion.div>

        {/* Executive Summary */}
        {analysis.executive_summary && (
          <SectionCard title="Executive Summary" icon={FileText} delay={0.05}>
            <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
              {analysis.executive_summary}
            </p>
          </SectionCard>
        )}

        {/* Financial Highlights */}
        {analysis.financial_highlights && analysis.financial_highlights.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
            <h2 className="font-display text-xl font-semibold text-foreground mb-4">Financial Highlights</h2>
            <MetricsGrid metrics={analysis.financial_highlights} />
          </motion.div>
        )}

        {/* Two-column layout for detailed sections */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Revenue */}
          <SectionCard title="Revenue" icon={DollarSign} delay={0.15}>
            <RevenueBreakdown revenueData={analysis.revenue_data} />
          </SectionCard>

          {/* Profitability */}
          <SectionCard title="Profitability" icon={TrendingUp} delay={0.2}>
            <ProfitabilityTable profitability={analysis.profitability} />
          </SectionCard>

          {/* Balance Sheet */}
          <SectionCard title="Balance Sheet" icon={BarChart3} delay={0.25}>
            <BalanceSheetTable balanceSheet={analysis.balance_sheet} />
          </SectionCard>

          {/* Cash Flow */}
          <SectionCard title="Cash Flow" icon={Wallet} delay={0.3}>
            <CashFlowTable cashFlow={analysis.cash_flow} />
          </SectionCard>
        </div>

        {/* Financing Details */}
        <SectionCard title="Financing & Capital Structure" icon={Landmark} delay={0.35}>
          <FinancingDetails financing={analysis.financing_data} />
        </SectionCard>

        {/* Key Insights */}
        {analysis.key_insights && analysis.key_insights.length > 0 && (
          <SectionCard title="Key Insights" icon={Lightbulb} delay={0.4}>
            <div className="space-y-3">
              {analysis.key_insights.map((insight, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-accent">{i + 1}</span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{insight}</p>
                </div>
              ))}
            </div>
          </SectionCard>
        )}

        {/* Risk Factors */}
        {analysis.risk_factors && analysis.risk_factors.length > 0 && (
          <SectionCard title="Risk Factors" icon={AlertTriangle} delay={0.45}>
            <RiskFactorsList risks={analysis.risk_factors} />
          </SectionCard>
        )}
      </main>

      {/* Footer spacer */}
      <div className="h-16" />
    </div>
  );
}