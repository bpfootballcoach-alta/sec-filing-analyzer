import React from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const severityColors = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export default function RiskFactorsList({ risks }) {
  if (!risks || risks.length === 0) return <p className="text-muted-foreground text-sm">No risk factors identified.</p>;

  return (
    <div className="space-y-3">
      {risks.map((risk, i) => (
        <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/40">
          <AlertTriangle className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold text-foreground">{risk.title}</span>
              {risk.severity && (
                <Badge variant="outline" className={`text-[10px] ${severityColors[risk.severity?.toLowerCase()] || ""}`}>
                  {risk.severity}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{risk.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}