import React from "react";

export default function RevenueBreakdown({ revenueData }) {
  if (!revenueData) return <p className="text-muted-foreground text-sm">No revenue data available.</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between py-2">
        <span className="text-sm text-muted-foreground">Total Revenue</span>
        <span className="text-lg font-bold text-foreground">{revenueData.total_revenue || "N/A"}</span>
      </div>
      {revenueData.revenue_growth && (
        <div className="flex items-center justify-between py-2 border-t border-border">
          <span className="text-sm text-muted-foreground">Revenue Growth</span>
          <span className="text-sm font-semibold text-emerald-600">{revenueData.revenue_growth}</span>
        </div>
      )}
      {revenueData.segments && revenueData.segments.length > 0 && (
        <div className="border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Segment Breakdown</p>
          <div className="space-y-2">
            {revenueData.segments.map((seg, i) => (
              <div key={i} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-accent" />
                  <span className="text-sm text-foreground">{seg.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-foreground">{seg.amount}</span>
                  {seg.percentage && (
                    <span className="text-xs text-muted-foreground">({seg.percentage})</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}