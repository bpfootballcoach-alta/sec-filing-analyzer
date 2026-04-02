import React, { useState, useRef } from "react";
import { Upload, FileText, Loader2, X, Link as LinkIcon, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { motion, AnimatePresence } from "framer-motion";

export default function FileUploader({ onFileSelected, onUrlSubmitted, isProcessing }) {
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const inputRef = useRef(null);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) setSelectedFile(file);
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) setSelectedFile(file);
  };

  const clearFile = () => {
    setSelectedFile(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleUrlSubmit = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
      setUrlError("");
      onUrlSubmitted(trimmed);
    } catch {
      setUrlError("Please enter a valid URL");
    }
  };

  return (
    <div className="w-full space-y-3">
      {/* File drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !selectedFile && inputRef.current?.click()}
        className={`
          relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer
          transition-all duration-300 ease-out
          ${dragOver
            ? "border-accent bg-accent/5 scale-[1.01]"
            : "border-border hover:border-accent/50 hover:bg-muted/50"
          }
          ${isProcessing ? "pointer-events-none opacity-60" : ""}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.html,.htm,.txt,.doc,.docx,.xlsx,.csv"
          onChange={handleFileChange}
          className="hidden"
        />

        <AnimatePresence mode="wait">
          {isProcessing ? (
            <motion.div
              key="processing"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
              <div>
                <p className="text-lg font-semibold text-foreground">Analyzing Filing...</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Extracting financial data, metrics, and key insights
                </p>
              </div>
              <div className="flex gap-1 mt-2">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    className="w-2 h-2 rounded-full bg-accent"
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                  />
                ))}
              </div>
            </motion.div>
          ) : selectedFile ? (
            <motion.div
              key="selected"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <FileText className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="text-lg font-semibold text-foreground">{selectedFile.name}</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <div className="flex gap-3">
                <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); clearFile(); }}>
                  <X className="w-4 h-4 mr-1" /> Remove
                </Button>
                <Button size="sm" onClick={(e) => { e.stopPropagation(); onFileSelected(selectedFile); }} className="bg-accent text-accent-foreground hover:bg-accent/90">
                  Analyze Filing
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                <Upload className="w-8 h-8 text-muted-foreground" />
              </div>
              <div>
                <p className="text-lg font-semibold text-foreground">Drop your SEC filing here</p>
                <p className="text-sm text-muted-foreground mt-1">
                  PDF, HTML, TXT, DOCX, XLSX — 10-K, 10-Q, 8-K, S-1, and more
                </p>
              </div>
              <Button variant="outline" size="sm" className="mt-1">
                Browse Files
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* URL input */}
      <div className={`transition-opacity ${isProcessing ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <LinkIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Or paste a URL (SEC EDGAR link, filing page, etc.)"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
              onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
              className="pl-9"
            />
          </div>
          <Button
            onClick={handleUrlSubmit}
            disabled={!urlInput.trim()}
            className="bg-accent text-accent-foreground hover:bg-accent/90 gap-2"
          >
            Analyze <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
        {urlError && <p className="text-xs text-destructive mt-1.5 ml-1">{urlError}</p>}
      </div>
    </div>
  );
}