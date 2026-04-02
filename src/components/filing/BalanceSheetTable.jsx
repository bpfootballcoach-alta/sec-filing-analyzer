import React from "react";

export default function BalanceSheetTable({ balanceSheet }) {
  if (!balanceSheet) return <p className="text-muted-foreground text-sm">No balance sheet data available.</p>;

  const rows = [
    { label: "Total Assets", value: balanceSheet.total_assets },
    { label: "Total Liabilities", value: balanceSheet.total_liabilities },
    { label: "Total Equity", value: balanceSheet.total_equity },
    { label: "Cash & Equivalents", value: balanceSheet.cash_and_equivalents },
    { label: "Total Debt", value: balanceSheet.total_debt },
    { label: "Debt-to-Equity Ratio", value: balanceSheet.debt_to_equity },
  ].filter(r => r.value);

  if (rows.length === 0) return <p className="text-muted-foreground text-sm">No balance sheet data available.</p>;

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