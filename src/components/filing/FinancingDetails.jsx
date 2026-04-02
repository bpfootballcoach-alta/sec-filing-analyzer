import React, { useState } from "react";
import { Landmark, ChevronDown, ChevronUp, DollarSign, Percent, Calendar, Tag, Users, FileText, TrendingUp, PieChart } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function DetailRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between py-2 gap-4">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-xs font-medium text-foreground text-right">{value}</span>
    </div>
  );
}

function TransactionCard({ tx, index }) {
  const [expanded, setExpanded] = useState(false);

  const typeColors = {
    "Equity": "bg-blue-50 text-blue-700 border-blue-200",
    "Debt": "bg-amber-50 text-amber-700 border-amber-200",
    "Convertible": "bg-purple-50 text-purple-700 border-purple-200",
    "Credit Facility": "bg-emerald-50 text-emerald-700 border-emerald-200",
    "IPO": "bg-pink-50 text-pink-700 border-pink-200",
    "Secondary Offering": "bg-blue-50 text-blue-700 border-blue-200",
  };

  const badgeClass = typeColors[tx.type] || "bg-muted text-muted-foreground border-border";

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-start justify-between p-4 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Landmark className="w-4 h-4 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              {tx.type && (
                <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${badgeClass}`}>
                  {tx.type}
                </span>
              )}
              {tx.date && (
                <span className="text-xs text-muted-foreground">{tx.date}</span>
              )}
            </div>
            <p className="text-sm font-semibold text-foreground">
              {tx.instrument || tx.type || "Financing Transaction"}
            </p>
            {tx.amount && (
              <p className="text-sm font-bold text-accent mt-0.5">{tx.amount}</p>
            )}
            {!expanded && tx.structure && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{tx.structure}</p>
            )}
          </div>
        </div>
        <div className="ml-2 flex-shrink-0 mt-1">
          {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border bg-muted/20">
          <div className="divide-y divide-border">
            {tx.structure && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Structure</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.structure}</p>
              </div>
            )}
            <DetailRow label="Cost Basis / Issue Price" value={tx.cost_basis} />
            <DetailRow label="Interest Rate / Yield" value={tx.interest_rate_or_yield} />
            <DetailRow label="Rate Type" value={tx.interest_rate_type} />
            <DetailRow label="Benchmark & Spread" value={tx.benchmark_and_spread} />
            <DetailRow label="Rate Floor" value={tx.rate_floor} />
            <DetailRow label="Maturity / Term" value={tx.maturity_or_term} />
            <DetailRow label="Amortization" value={tx.amortization} />
            {tx.use_of_proceeds && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Use of Proceeds</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.use_of_proceeds}</p>
              </div>
            )}
            {tx.collateral_or_security && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Collateral / Security</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.collateral_or_security}</p>
              </div>
            )}
            {tx.covenants && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Covenants</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.covenants}</p>
              </div>
            )}
            {tx.call_put_conversion && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Call / Put / Conversion</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.call_put_conversion}</p>
              </div>
            )}
            <DetailRow label="Underwriters / Parties" value={tx.underwriters_or_parties} />
            {tx.key_terms && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Key Terms</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.key_terms}</p>
              </div>
            )}
            {tx.amendments_or_waivers && (
              <div className="py-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Amendments / Waivers</p>
                <p className="text-sm text-foreground leading-relaxed">{tx.amendments_or_waivers}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DebtInstrumentRow({ instrument }) {
  return (
    <div className="p-3 rounded-lg bg-muted/40 border border-border/50 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{instrument.name}</span>
        {instrument.amount && <span className="text-sm font-bold text-foreground">{instrument.amount}</span>}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {instrument.type && <span className="text-xs text-muted-foreground">Type: <span className="text-foreground">{instrument.type}</span></span>}
        {instrument.interest_rate && <span className="text-xs text-muted-foreground">Rate: <span className="text-accent font-medium">{instrument.interest_rate}</span></span>}
        {instrument.cost_basis && <span className="text-xs text-muted-foreground">Cost Basis: <span className="text-foreground">{instrument.cost_basis}</span></span>}
        {instrument.maturity && <span className="text-xs text-muted-foreground">Maturity: <span className="text-foreground">{instrument.maturity}</span></span>}
      </div>
      {instrument.notes && <p className="text-xs text-muted-foreground">{instrument.notes}</p>}
    </div>
  );
}

export default function FinancingDetails({ financing, capitalStructure, financingActivity }) {
  const hasCapitalStructure = capitalStructure && (
    capitalStructure.summary ||
    capitalStructure.equity ||
    capitalStructure.debt
  );

  const hasFinancingActivity = financingActivity?.has_recent_financing &&
    financingActivity?.transactions?.length > 0;

  const hasLegacyFinancing = financing && (financing.summary || financing.details?.length > 0);

  if (!hasCapitalStructure && !hasFinancingActivity && !hasLegacyFinancing) {
    return <p className="text-muted-foreground text-sm">No financing or capital structure data available.</p>;
  }

  return (
    <div className="space-y-6">

      {/* Capital Structure */}
      {hasCapitalStructure && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <PieChart className="w-4 h-4 text-accent" />
            <h4 className="text-sm font-semibold text-foreground">Capital Structure</h4>
            {capitalStructure.total_capitalization && (
              <span className="ml-auto text-sm font-bold text-foreground">{capitalStructure.total_capitalization}</span>
            )}
          </div>

          {capitalStructure.summary && (
            <p className="text-sm text-muted-foreground leading-relaxed">{capitalStructure.summary}</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Equity */}
            {capitalStructure.equity && (
              <div className="border border-border rounded-lg p-4 space-y-1">
                <div className="flex items-center gap-2 mb-2">
                  <TrendingUp className="w-3.5 h-3.5 text-accent" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Equity</span>
                  {capitalStructure.equity.equity_percentage_of_cap && (
                    <Badge variant="secondary" className="ml-auto text-xs">{capitalStructure.equity.equity_percentage_of_cap}</Badge>
                  )}
                </div>
                <div className="divide-y divide-border">
                  <DetailRow label="Common Equity" value={capitalStructure.equity.common_equity} />
                  <DetailRow label="Preferred Equity" value={capitalStructure.equity.preferred_equity} />
                  <DetailRow label="Shares Outstanding" value={capitalStructure.equity.shares_outstanding} />
                  <DetailRow label="Market Cap" value={capitalStructure.equity.market_cap} />
                  <DetailRow label="Book Value / Share" value={capitalStructure.equity.book_value_per_share} />
                </div>
              </div>
            )}

            {/* Debt Overview */}
            {capitalStructure.debt && (
              <div className="border border-border rounded-lg p-4 space-y-1">
                <div className="flex items-center gap-2 mb-2">
                  <Landmark className="w-3.5 h-3.5 text-accent" />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Debt</span>
                  {capitalStructure.debt.debt_percentage_of_cap && (
                    <Badge variant="secondary" className="ml-auto text-xs">{capitalStructure.debt.debt_percentage_of_cap}</Badge>
                  )}
                </div>
                <div className="divide-y divide-border">
                  <DetailRow label="Total Debt" value={capitalStructure.debt.total_debt} />
                  <DetailRow label="Short-Term Debt" value={capitalStructure.debt.short_term_debt} />
                  <DetailRow label="Long-Term Debt" value={capitalStructure.debt.long_term_debt} />
                  <DetailRow label="Avg. Interest Rate" value={capitalStructure.debt.weighted_average_interest_rate} />
                </div>
              </div>
            )}
          </div>

          {/* Debt Instruments */}
          {capitalStructure.debt?.debt_instruments?.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Debt Instruments</p>
              <div className="space-y-2">
                {capitalStructure.debt.debt_instruments.map((inst, i) => (
                  <DebtInstrumentRow key={i} instrument={inst} />
                ))}
              </div>
            </div>
          )}

          {/* Other components */}
          {capitalStructure.other_components?.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other Components</p>
              <div className="space-y-2">
                {capitalStructure.other_components.map((item, i) => (
                  <div key={i} className="flex items-start justify-between p-3 rounded-lg bg-muted/40">
                    <div>
                      <p className="text-sm font-medium text-foreground">{item.name}</p>
                      {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
                    </div>
                    {item.amount && <span className="text-sm font-bold text-foreground ml-4">{item.amount}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Financing Activity */}
      {hasFinancingActivity && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 border-t border-border pt-4">
            <DollarSign className="w-4 h-4 text-accent" />
            <h4 className="text-sm font-semibold text-foreground">Financing Transactions</h4>
          </div>
          {financingActivity.summary && (
            <p className="text-sm text-muted-foreground leading-relaxed">{financingActivity.summary}</p>
          )}
          <div className="space-y-3">
            {financingActivity.transactions.map((tx, i) => (
              <TransactionCard key={i} tx={tx} index={i} />
            ))}
          </div>
        </div>
      )}

      {/* Legacy fallback */}
      {!hasCapitalStructure && !hasFinancingActivity && hasLegacyFinancing && (
        <div className="space-y-3">
          {financing.summary && (
            <p className="text-sm text-muted-foreground leading-relaxed">{financing.summary}</p>
          )}
          {financing.details?.map((item, i) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/40">
              <Landmark className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-foreground">{item.type}</span>
                  {item.amount && <span className="text-sm font-bold text-foreground">{item.amount}</span>}
                </div>
                <p className="text-sm text-muted-foreground">{item.description}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}