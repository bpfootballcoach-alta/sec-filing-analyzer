import React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { motion } from "framer-motion";

function MetricCard({ label, value, change, category, index }) {
  const getTrend = () => {
    if (!change) return null;
    if (change.includes("+") || change.includes("increase") || change.includes("up")) {
      return { icon: TrendingUp, color: "text-emerald-600" };
    }
    if (change.includes("-") || change.includes("decrease") || change.includes("down")) {
      return { icon: TrendingDown, color: "text-red-500" };
    }
    return { icon: Minus, color: "text-muted-foreground" };
  };

  const trend = getTrend();

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="bg-card border border-border rounded-xl p-5 hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
        {category && (
          <span className="text-[10px] font-medium bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
            {category}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-foreground mt-2 tracking-tight">{value}</p>
      {change && trend && (
        <div className={`flex items-center gap-1 mt-2 text-sm ${trend.color}`}>
          <trend.icon className="w-3.5 h-3.5" />
          <span className="font-medium">{change}</span>
        </div>
      )}
    </motion.div>
  );
}

export default function MetricsGrid({ metrics }) {
  if (!metrics || metrics.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {metrics.map((metric, i) => (
        <MetricCard key={i} {...metric} index={i} />
      ))}
    </div>
  );
}