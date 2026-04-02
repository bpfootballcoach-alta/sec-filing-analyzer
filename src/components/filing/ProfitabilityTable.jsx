import React from "react";

export default function ProfitabilityTable({ profitability }) {
  if (!profitability) return <p className="text-muted-foreground text-sm">No profitability data available.</p>;

  const rows = [
    { label: "Gross Margin", value: profitability.gross_margin },
    { label: "Operating Margin", value: profitability.operating_margin },
    { label: "Net Margin", value: profitability.net_margin },
    { label: "EBITDA", value: profitability.ebitda },
    { label: "Earnings Per Share", value: profitability.eps },
  ].filter(r => r.value);

  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No profitability data available.</p>;

  return (
    <div className="divide-y divide-border">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center justify-between py-3">
          <span className="text-sm text-muted-foreground">{row.label}</span>
          <span className="text-sm font-semibold text-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  );
}