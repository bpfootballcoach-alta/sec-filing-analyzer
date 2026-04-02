import React from "react";

export default function CashFlowTable({ cashFlow }) {
  if (!cashFlow) return <p className="text-muted-foreground text-sm">No cash flow data available.</p>;

  const rows = [
    { label: "Operating Cash Flow", value: cashFlow.operating },
    { label: "Investing Cash Flow", value: cashFlow.investing },
    { label: "Financing Cash Flow", value: cashFlow.financing },
    { label: "Free Cash Flow", value: cashFlow.free_cash_flow },
  ].filter(r => r.value);

  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No cash flow data available.</p>;

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