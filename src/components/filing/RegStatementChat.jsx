import React, { useState, useRef, useEffect } from "react";
import { llm } from "@/api/apiClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Loader2, MessageCircle, Bot, User } from "lucide-react";

export default function RegStatementChat({ detailResult }) {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: `I've analyzed the **${detailResult.registration.form}** registration for **${detailResult.companyName} (${detailResult.ticker})**. The overall status is **${detailResult.overallStatus.toUpperCase()}**. Ask me anything about this registration statement, the compliance checks, or what actions are needed.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const checkSummary = detailResult.checks
    .map((c) => `[${c.status.toUpperCase()}] ${c.label}: ${c.detail}`)
    .join("\n");

  const systemContext = `You are a securities law compliance expert advising on SEC registration statement currency.

Company: ${detailResult.companyName} (${detailResult.ticker})
CIK: ${detailResult.cik}
Registration Form: ${detailResult.registration.form} filed ${detailResult.registration.date}
Type: ${detailResult.registration.isShelf ? "Shelf" : "Non-Shelf"} | FPI: ${detailResult.registration.isFPI ? "Yes" : "No"} | F-form: ${detailResult.registration.isFForm ? "Yes" : "No"}
Annual FS limit: ${detailResult.registration.annualLimitMonths} months | Interim FS limit: ${detailResult.registration.interimLimitMonths} months
Overall Status: ${detailResult.overallStatus.toUpperCase()}

AI Verdict: ${detailResult.aiSummary?.summary || "N/A"}
Key Issue: ${detailResult.aiSummary?.key_issue || "N/A"}
Required Action: ${detailResult.aiSummary?.required_action || "N/A"}

Compliance checks:
${checkSummary}

Answer the user's questions about this specific registration statement concisely and accurately. Reference specific check results where relevant.`;

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const newMessages = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    const conversationHistory = newMessages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    const result = await llm.invoke({
      prompt: `${systemContext}\n\nConversation so far:\n${conversationHistory}\n\nRespond as the assistant:`,
      model: "gemini-2.0-flash",
    });

    setMessages((prev) => [...prev, { role: "assistant", content: result }]);
    setLoading(false);
  };

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/40">
        <MessageCircle className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Ask a Follow-Up Question</span>
        <span className="text-xs text-muted-foreground ml-1">— AI compliance advisor</span>
      </div>

      {/* Messages */}
      <div className="flex flex-col gap-3 px-4 py-4 max-h-80 overflow-y-auto">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
            <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${msg.role === "user" ? "bg-primary" : "bg-muted"}`}>
              {msg.role === "user"
                ? <User className="w-3 h-3 text-primary-foreground" />
                : <Bot className="w-3 h-3 text-muted-foreground" />
              }
            </div>
            <div className={`text-sm leading-relaxed rounded-xl px-3 py-2 max-w-[85%] whitespace-pre-wrap ${
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground"
            }`}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-2 items-center">
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
              <Bot className="w-3 h-3 text-muted-foreground" />
            </div>
            <div className="bg-muted rounded-xl px-3 py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-4 pt-2 border-t border-border flex gap-2">
        <Input
          placeholder="e.g. What exactly needs to be filed to cure the gap?"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          disabled={loading}
          className="flex-1"
        />
        <Button onClick={handleSend} disabled={!input.trim() || loading} size="icon">
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}