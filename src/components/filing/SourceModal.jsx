import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { BookOpen, X, Loader2, ExternalLink, AlertCircle } from "lucide-react";

/**
 * SourceModal — fetches the original filing and asks the LLM to locate
 * the exact passage(s) for a given topic, then displays them highlighted.
 *
 * Props:
 *   fileUrl   — URL of the original filing document
 *   topic     — e.g. "total revenue", "risk factors", "balance sheet"
 *   label     — short human label shown on the trigger button
 */
export default function SourceModal({ fileUrl, topic, label = "Source" }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleOpen = async () => {
    setOpen(true);
    if (result || loading) return; // already fetched
    setLoading(true);
    setError(null);

    try {
      // Pass the filing URL directly to the LLM — it can fetch SEC documents itself
      const llmRes = await base44.integrations.Core.InvokeLLM({
        prompt: `You are a financial document analyst. The user wants to find where "${topic}" is discussed in this SEC filing document.

Find ALL relevant passages that directly support the data shown in the analysis for "${topic}". For each passage:
1. Quote the EXACT text verbatim (up to 3-4 sentences).
2. Identify the section heading it appears under (e.g. "Notes to Financial Statements", "Management's Discussion and Analysis", "Risk Factors").
3. Estimate the approximate location as a percentage through the document (e.g. "~15% through the document").

Return up to 3 of the most relevant passages. If none found, say so clearly.`,
        file_urls: [fileUrl],
        response_json_schema: {
          type: "object",
          properties: {
            found: { type: "boolean" },
            passages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  quote: { type: "string" },
                  section: { type: "string" },
                  location: { type: "string" }
                }
              }
            },
            not_found_reason: { type: ["string", "null"] }
          }
        }
      });

      setResult(llmRes);
    } catch (e) {
      setError(e.message || "Failed to locate source.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={handleOpen}
        className="inline-flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors underline-offset-2 hover:underline"
        title={`Find source in original filing for: ${topic}`}
      >
        <BookOpen className="w-3 h-3" />
        {label}
      </button>

      {/* Modal overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* Panel */}
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-primary" />
                <span className="font-semibold text-sm text-foreground">Source in Original Filing</span>
                <span className="text-xs text-muted-foreground">— {topic}</span>
              </div>
              <div className="flex items-center gap-2">
                {fileUrl && (
                  <a href={fileUrl} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1">
                      Open Filing <ExternalLink className="w-3 h-3" />
                    </Button>
                  </a>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-muted transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {loading && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <Loader2 className="w-7 h-7 animate-spin text-primary" />
                  <p className="text-sm">Locating passages in the original document…</p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 text-destructive bg-destructive/10 rounded-lg p-4">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              {result && !loading && (
                <>
                  {!result.found || result.passages?.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-8 text-center">
                      {result.not_found_reason || "No specific passage found for this topic in the document."}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <p className="text-xs text-muted-foreground">
                        {result.passages.length} passage{result.passages.length > 1 ? "s" : ""} found in the filing:
                      </p>
                      {result.passages.map((p, i) => (
                        <div key={i} className="rounded-lg border border-border overflow-hidden">
                          {/* Passage meta */}
                          <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border">
                            <span className="text-xs font-semibold text-foreground truncate">{p.section || "Unknown Section"}</span>
                            {p.location && (
                              <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">{p.location}</span>
                            )}
                          </div>
                          {/* Quoted text */}
                          <blockquote className="px-4 py-3 text-sm text-foreground leading-relaxed border-l-4 border-accent bg-accent/5 italic">
                            "{p.quote}"
                          </blockquote>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}