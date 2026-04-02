import React from "react";
import { MessageSquare, Briefcase, Scale, AlertOctagon, TrendingUp, Zap, Smile } from "lucide-react";

const ITEMS = [
  { key: "management_commentary", label: "Management Commentary", icon: MessageSquare },
  { key: "guidance_and_outlook", label: "Guidance & Outlook", icon: TrendingUp },
  { key: "business_developments", label: "Business Developments", icon: Briefcase },
  { key: "significant_events", label: "Significant Events", icon: Zap },
  { key: "legal_regulatory", label: "Legal & Regulatory", icon: Scale },
  { key: "going_concern_or_restatements", label: "Going Concern / Restatements", icon: AlertOctagon },
  { key: "overall_tone", label: "Overall Tone", icon: Smile },
];

export default function NarrativeHighlights({ narrative }) {
  if (!narrative) return <p className="text-muted-foreground text-sm">No narrative data available.</p>;

  const items = ITEMS.filter((item) => narrative[item.key]);

  if (items.length === 0) return <p className="text-muted-foreground text-sm">No narrative data available.</p>;

  return (
    <div className="space-y-5">
      {items.map(({ key, label, icon: Icon }) => (
        <div key={key} className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Icon className="w-4 h-4 text-accent" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</p>
            <p className="text-sm text-foreground leading-relaxed">{narrative[key]}</p>
          </div>
        </div>
      ))}
    </div>
  );
}