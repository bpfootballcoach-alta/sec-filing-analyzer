const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { prompt, response_json_schema, model, api_key } = body;

    if (!prompt) {
      return new Response(JSON.stringify({ error: "prompt is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = api_key || Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: "GEMINI_API_KEY not configured. Click 'Set API Key' in the app header to add your free key from Google AI Studio (https://aistudio.google.com/apikey).",
        code: "MISSING_API_KEY",
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const modelName = model || "gemini-2.0-flash";

    const geminiBody: Record<string, any> = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    };

    if (response_json_schema) {
      geminiBody.generationConfig.responseMimeType = "application/json";
      geminiBody.generationConfig.responseSchema = response_json_schema;
    }

    // Retry up to 3 times on 429 (rate limit) or 503 (overloaded)
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
        await sleep(backoff);
      }

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiBody),
        }
      );

      if (geminiRes.ok) {
        const geminiData = await geminiRes.json();
        const textContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textContent) {
          const blockReason = geminiData.candidates?.[0]?.finishReason;
          if (blockReason === "SAFETY") {
            return new Response(JSON.stringify({ error: "Response blocked by safety filters. Try rephrasing your request." }), {
              status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ error: "No content in Gemini response" }), {
            status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (response_json_schema) {
          try {
            const parsed = JSON.parse(textContent);
            return new Response(JSON.stringify(parsed), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch {
            return new Response(JSON.stringify({ raw: textContent }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        return new Response(JSON.stringify({ result: textContent }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Read error body
      const errBody = await geminiRes.text();
      lastError = `Gemini API error: ${geminiRes.status}`;

      // Only retry on 429 and 503
      if (geminiRes.status !== 429 && geminiRes.status !== 503) {
        console.error("Gemini API error:", geminiRes.status, errBody);
        // For 400 errors, include more detail
        if (geminiRes.status === 400) {
          try {
            const errJson = JSON.parse(errBody);
            lastError = `Gemini API error: ${errJson?.error?.message || geminiRes.status}`;
          } catch (_) {}
        }
        break;
      }

      console.error(`Gemini API ${geminiRes.status}, retry ${attempt + 1}/3`);
    }

    return new Response(JSON.stringify({ error: lastError + (lastError.includes("429") ? " — rate limit hit. Wait a minute and try again, or use a different API key." : "") }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
