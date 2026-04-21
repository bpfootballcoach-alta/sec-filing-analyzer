import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { url } = await req.json();
    if (!url) return Response.json({ error: "url is required" }, { status: 400 });

    // Fetch the filing from SEC EDGAR
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SEC-Filing-Analyzer contact@example.com",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return Response.json({ error: `Failed to fetch URL: ${res.status} ${res.statusText}` }, { status: 502 });
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();

    if (!text || text.length < 100) {
      return Response.json({ error: "Fetched content is empty or too short" }, { status: 502 });
    }

    // Upload the content as a file so the LLM can analyze it via file_urls
    // Always use .html extension — .htm is not a supported file type for LLM analysis
    const mimeType = "text/html";
    const fileName = "filing.html";
    const file = new File([text], fileName, { type: mimeType });
    const uploaded = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ file_url: uploaded.file_url, content_length: text.length });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});