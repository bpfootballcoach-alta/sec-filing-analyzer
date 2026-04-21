import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// Resolve the real document URL from SEC EDGAR inline viewer URLs
// e.g. https://www.sec.gov/ix?doc=/Archives/edgar/data/.../file.htm
//   -> https://www.sec.gov/Archives/edgar/data/.../file.htm
function resolveEdgarUrl(url) {
  try {
    const parsed = new URL(url);
    // Handle inline XBRL viewer: /ix?doc=...
    if (parsed.pathname === '/ix' || parsed.pathname.startsWith('/ix')) {
      const docParam = parsed.searchParams.get('doc');
      if (docParam) {
        // docParam may be relative (starts with /) or absolute
        if (docParam.startsWith('http')) return docParam;
        return `https://www.sec.gov${docParam}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { url } = await req.json();
    if (!url) return Response.json({ error: "url is required" }, { status: 400 });

    // Resolve the actual document URL (handles SEC EDGAR /ix?doc= viewer URLs)
    const resolvedUrl = resolveEdgarUrl(url);

    // Fetch the filing from SEC EDGAR
    const res = await fetch(resolvedUrl, {
      headers: {
        "User-Agent": "SEC-Filing-Analyzer contact@example.com",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return Response.json({ error: `Failed to fetch URL: ${res.status} ${res.statusText}` }, { status: 502 });
    }

    const text = await res.text();

    if (!text || text.length < 100) {
      return Response.json({ error: "Fetched content is empty or too short" }, { status: 502 });
    }

    // Upload as .html file so the LLM can analyze it via file_urls
    const file = new File([text], "filing.html", { type: "text/html" });
    const uploaded = await base44.asServiceRole.integrations.Core.UploadFile({ file });

    return Response.json({ file_url: uploaded.file_url, content_length: text.length, resolved_url: resolvedUrl });
  } catch (err) {
    return Response.json({ error: err.message || String(err) }, { status: 500 });
  }
});