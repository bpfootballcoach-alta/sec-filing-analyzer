import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
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
  Trash2,
  MessageSquare,
  Download,
  ShieldCheck,
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
import NarrativeHighlights from "@/components/filing/NarrativeHighlights";
import RegistrationCurrencyCheck from "@/components/filing/RegistrationCurrencyCheck";

export default function AnalysisDetail() {
  const pathParts = window.location.pathname.split("/");
  const analysisId = pathParts[pathParts.length - 1];
  const navigate = useNavigate();

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

  const deleteMutation = useMutation({
    mutationFn: () => base44.entities.FilingAnalysis.delete(analysisId),
    onSuccess: () => navigate("/"),
  });

  const exportHtml = () => {
    const a = analysis;
    const rows = (arr) => arr?.map(r => `<tr><td>${r.label||r.title||r.name||''}</td><td>${r.value||r.description||r.amount||''}</td></tr>`).join("") || "";
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${a.company_name || a.file_name} — ${a.filing_type || "SEC Filing"}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; }
  h1 { font-size: 2rem; margin-bottom: 4px; }
  h2 { font-size: 1.2rem; border-bottom: 2px solid #c9a84c; padding-bottom: 6px; margin-top: 32px; color: #1a1a2e; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
  .badge { display: inline-block; background: #c9a84c; color: #fff; padding: 2px 10px; border-radius: 4px; font-size: 0.85rem; margin-right: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  td, th { padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  td:last-child { font-weight: 600; text-align: right; }
  p { line-height: 1.7; font-size: 0.95rem; color: #333; }
  .insight { padding: 6px 0; font-size: 0.9rem; color: #333; border-bottom: 1px solid #f0f0f0; }
  .risk { margin-bottom: 12px; }
  .risk-title { font-weight: 600; }
  .risk-desc { font-size: 0.9rem; color: #555; }
</style>
</head>
<body>
<span class="badge">${a.filing_type||''}</span>${a.ticker ? `<span class="badge" style="background:#1a1a2e">${a.ticker}</span>` : ''}
<h1>${a.company_name || a.file_name}</h1>
<div class="meta">
  ${a.filing_date ? `Filed: ${a.filing_date} &nbsp;|&nbsp;` : ''}
  ${a.period_covered ? `Period: ${a.period_covered} &nbsp;|&nbsp;` : ''}
  Analyzed: ${new Date(a.created_date).toLocaleDateString()}
</div>

${a.executive_summary ? `<h2>Executive Summary</h2><p>${a.executive_summary}</p>` : ''}

${a.financial_highlights?.length ? `<h2>Financial Highlights</h2><table>${rows(a.financial_highlights)}</table>` : ''}

${a.revenue_data?.total_revenue ? `<h2>Revenue</h2><table>
  <tr><td>Total Revenue</td><td>${a.revenue_data.total_revenue}</td></tr>
  ${a.revenue_data.revenue_growth ? `<tr><td>Revenue Growth</td><td>${a.revenue_data.revenue_growth}</td></tr>` : ''}
  ${a.revenue_data.segments?.map(s=>`<tr><td>${s.name}</td><td>${s.amount||''} ${s.percentage?`(${s.percentage})`:''}</td></tr>`).join('')||''}
</table>` : ''}

${a.profitability ? `<h2>Profitability</h2><table>
  ${a.profitability.gross_margin?`<tr><td>Gross Margin</td><td>${a.profitability.gross_margin}</td></tr>`:''}
  ${a.profitability.operating_margin?`<tr><td>Operating Margin</td><td>${a.profitability.operating_margin}</td></tr>`:''}
  ${a.profitability.net_margin?`<tr><td>Net Margin</td><td>${a.profitability.net_margin}</td></tr>`:''}
  ${a.profitability.ebitda?`<tr><td>EBITDA</td><td>${a.profitability.ebitda}</td></tr>`:''}
  ${a.profitability.eps?`<tr><td>EPS</td><td>${a.profitability.eps}</td></tr>`:''}
</table>` : ''}

${a.balance_sheet ? `<h2>Balance Sheet</h2><table>
  ${a.balance_sheet.total_assets?`<tr><td>Total Assets</td><td>${a.balance_sheet.total_assets}</td></tr>`:''}
  ${a.balance_sheet.total_liabilities?`<tr><td>Total Liabilities</td><td>${a.balance_sheet.total_liabilities}</td></tr>`:''}
  ${a.balance_sheet.total_equity?`<tr><td>Total Equity</td><td>${a.balance_sheet.total_equity}</td></tr>`:''}
  ${a.balance_sheet.cash_and_equivalents?`<tr><td>Cash & Equivalents</td><td>${a.balance_sheet.cash_and_equivalents}</td></tr>`:''}
  ${a.balance_sheet.total_debt?`<tr><td>Total Debt</td><td>${a.balance_sheet.total_debt}</td></tr>`:''}
  ${a.balance_sheet.debt_to_equity?`<tr><td>Debt-to-Equity</td><td>${a.balance_sheet.debt_to_equity}</td></tr>`:''}
</table>` : ''}

${a.cash_flow ? `<h2>Cash Flow</h2><table>
  ${a.cash_flow.operating?`<tr><td>Operating</td><td>${a.cash_flow.operating}</td></tr>`:''}
  ${a.cash_flow.investing?`<tr><td>Investing</td><td>${a.cash_flow.investing}</td></tr>`:''}
  ${a.cash_flow.financing?`<tr><td>Financing</td><td>${a.cash_flow.financing}</td></tr>`:''}
  ${a.cash_flow.free_cash_flow?`<tr><td>Free Cash Flow</td><td>${a.cash_flow.free_cash_flow}</td></tr>`:''}
</table>` : ''}

${a.key_insights?.length ? `<h2>Key Insights</h2>${a.key_insights.map((ins,i)=>`<div class="insight">${i+1}. ${ins}</div>`).join('')}` : ''}

${a.risk_factors?.length ? `<h2>Risk Factors</h2>${a.risk_factors.map(r=>`<div class="risk"><div class="risk-title">${r.title}</div><div class="risk-desc">${r.description||''}</div></div>`).join('')}` : ''}

</body></html>`;

    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(a.company_name || a.file_name || "analysis").replace(/[^a-z0-9]/gi, "_")}_${a.filing_type || "filing"}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

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
          <Button
            variant="outline"
            size="sm"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="text-destructive border-destructive/30 hover:bg-destructive/10"
          >
            {deleteMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Trash2 className="w-4 h-4 mr-2" />}
            Cancel & Delete
          </Button>
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={exportHtml}>
              <Download className="w-4 h-4 mr-2" /> Export HTML
            </Button>
            {analysis.file_url && (
              <a href={analysis.file_url} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="w-4 h-4 mr-2" /> View Original
                </Button>
              </a>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            </Button>
          </div>
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

        {/* Narrative Highlights */}
        {analysis.narrative_highlights && (
          <SectionCard title="What's In This Filing" icon={MessageSquare} delay={0.08}>
            <NarrativeHighlights narrative={analysis.narrative_highlights} />
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
          <FinancingDetails
            financing={analysis.financing_data}
            capitalStructure={analysis.capital_structure}
            financingActivity={analysis.financing_activity}
          />
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

        {/* Registration Currency Check */}
        <SectionCard title="Registration Statement Currency" icon={ShieldCheck} delay={0.48}>
          <RegistrationCurrencyCheck ticker={analysis.ticker} />
        </SectionCard>

        {/* Risk Factors */}
        {analysis.risk_factors && analysis.risk_factors.length > 0 && (
          <SectionCard title="Risk Factors" icon={AlertTriangle} delay={0.5}>
            <RiskFactorsList risks={analysis.risk_factors} />
          </SectionCard>
        )}
      </main>

      {/* Footer spacer */}
      <div className="h-16" />
    </div>
  );
}