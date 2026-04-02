import React from "react";
import { motion } from "framer-motion";

export default function SectionCard({ title, icon: Icon, children, delay = 0 }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      className="bg-card border border-border rounded-xl overflow-hidden"
    >
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        {Icon && (
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
            <Icon className="w-4 h-4 text-accent" />
          </div>
        )}
        <h3 className="font-semibold text-foreground">{title}</h3>
      </div>
      <div className="p-6">
        {children}
      </div>
    </motion.div>
  );
}