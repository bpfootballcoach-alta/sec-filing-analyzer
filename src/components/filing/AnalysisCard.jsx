import React from "react";
import { Link } from "react-router-dom";
import { FileText, Building2, Calendar, ArrowRight, Loader2, AlertCircle, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { motion } from "framer-motion";

export default function AnalysisCard({ analysis, index, onDelete }) {
  const statusConfig = {
    processing: { color: "bg-accent/10 text-accent", icon: Loader2, label: "Processing" },
    completed: { color: "bg-emerald-50 text-emerald-700", icon: FileText, label: "Completed" },
    failed: { color: "bg-destructive/10 text-destructive", icon: AlertCircle, label: "Failed" },
  };

  const status = statusConfig[analysis.status] || statusConfig.processing;
  const StatusIcon = status.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
    >
      <Link
        to={`/analysis/${analysis.id}`}
        className="group block bg-card rounded-xl border border-border p-5 hover:shadow-lg hover:border-accent/30 transition-all duration-300"
      >
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4 flex-1 min-w-0">
            <div className="w-11 h-11 rounded-lg bg-primary/5 flex items-center justify-center flex-shrink-0 group-hover:bg-accent/10 transition-colors">
              <FileText className="w-5 h-5 text-primary group-hover:text-accent transition-colors" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                {analysis.filing_type && (
                  <Badge variant="secondary" className="text-xs font-medium">
                    {analysis.filing_type}
                  </Badge>
                )}
                <Badge className={`text-xs ${status.color} border-0`}>
                  <StatusIcon className={`w-3 h-3 mr-1 ${analysis.status === 'processing' ? 'animate-spin' : ''}`} />
                  {status.label}
                </Badge>
              </div>
              <h3 className="font-semibold text-foreground truncate group-hover:text-accent transition-colors">
                {analysis.company_name || analysis.file_name}
              </h3>
              <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                {analysis.company_name && (
                  <span className="flex items-center gap-1">
                    <Building2 className="w-3.5 h-3.5" />
                    {analysis.ticker || analysis.company_name}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5" />
                  {format(new Date(analysis.created_date), "MMM d, yyyy")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 mt-1">
            <button
              onClick={(e) => { e.preventDefault(); onDelete?.(analysis.id); }}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <ArrowRight className="w-5 h-5 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
          </div>
        </div>
      </Link>
    </motion.div>
  );
}