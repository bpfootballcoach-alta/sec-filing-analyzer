import React from "react";
import { Landmark } from "lucide-react";

export default function FinancingDetails({ financing }) {
  if (!financing) return <p className="text-muted-foreground text-sm">No financing data available.</p>;

  return (
    <div className="space-y-4">
      {financing.summary && (
        <p className="text-sm text-muted-foreground leading-relaxed">{financing.summary}</p>
      )}
      {financing.details && financing.details.length > 0 && (
        <div className="space-y-3">
          {financing.details.map((item, i) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-muted/40">
              <Landmark className="w-4 h-4 text-accent mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-foreground">{item.type}</span>
                  {item.amount && (
                    <span className="text-sm font-bold text-foreground">{item.amount}</span>
                  )}
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