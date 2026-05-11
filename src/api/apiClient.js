import { supabase } from '@/lib/supabase';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const edgeFunctionHeaders = {
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

// ── Edge Function helpers ──────────────────────────────────────────────────

async function invokeEdgeFunction(slug, body) {
  const url = `${SUPABASE_URL}/functions/v1/${slug}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: edgeFunctionHeaders,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Edge function ${slug} failed: ${res.status}`);
  }
  return data;
}

// ── FilingAnalysis entity (replaces base44.entities.FilingAnalysis) ────────

export const FilingAnalysis = {
  async list(orderBy = '-created_at', limit = 50) {
    const { data, error } = await supabase
      .from('filing_analyses')
      .select('*')
      .order(orderBy.startsWith('-') ? orderBy.slice(1) : orderBy, { ascending: !orderBy.startsWith('-') })
      .limit(limit);
    if (error) throw error;
    // Map snake_case DB columns to camelCase for frontend compatibility
    return (data || []).map(mapFromDb);
  },

  async filter(filters) {
    let query = supabase.from('filing_analyses').select('*');
    for (const [key, value] of Object.entries(filters)) {
      query = query.eq(key, value);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(mapFromDb);
  },

  async create(fields) {
    const { data, error } = await supabase
      .from('filing_analyses')
      .insert(mapToDb({ ...fields, user_id: (await supabase.auth.getUser()).data.user?.id }))
      .select()
      .single();
    if (error) throw error;
    return mapFromDb(data);
  },

  async update(id, fields) {
    const { data, error } = await supabase
      .from('filing_analyses')
      .update({ ...mapToDb(fields), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return mapFromDb(data);
  },

  async delete(id) {
    const { error } = await supabase
      .from('filing_analyses')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },
};

// ── Functions (replaces base44.functions.invoke) ───────────────────────────

export const functions = {
  invoke: async (name, body) => {
    const slugMap = {
      fetchAndAnalyzeFiling: 'fetch-and-analyze-filing',
      checkRegistrationCurrency: 'check-registration-currency',
      checkRegStatementCurrency: 'check-reg-statement-currency',
    };
    const slug = slugMap[name] || name;
    const data = await invokeEdgeFunction(slug, body);
    return { data };
  },
};

// ── LLM Integration (replaces base44.integrations.Core.InvokeLLM) ─────────

export const llm = {
  invoke: async ({ prompt, response_json_schema, model, file_urls, add_context_from_internet }) => {
    const data = await invokeEdgeFunction('invoke-llm', {
      prompt,
      response_json_schema,
      model: model || 'gemini-2.0-flash',
    });
    // The edge function returns parsed JSON for schema requests, or { result } for text
    if (data.raw !== undefined) {
      // JSON parse failed — return raw text
      return data.raw;
    }
    if (data.result !== undefined) {
      return data.result;
    }
    // Direct JSON object returned (schema mode)
    return data;
  },
};

// ── File upload (replaces base44.integrations.Core.UploadFile) ─────────────

export const uploadFile = async ({ file }) => {
  const fileName = `${Date.now()}-${file.name}`;
  const { data, error } = await supabase.storage
    .from('filings')
    .upload(fileName, file, { upsert: false });

  if (error) throw error;

  const { data: urlData } = supabase.storage
    .from('filings')
    .getPublicUrl(data.path);

  return { file_url: urlData.publicUrl };
};

// ── DB <-> Frontend field mapping ──────────────────────────────────────────

const DB_TO_FRONTEND = {
  id: 'id',
  user_id: 'user_id',
  file_name: 'file_name',
  file_url: 'file_url',
  filing_type: 'filing_type',
  company_name: 'company_name',
  ticker: 'ticker',
  filing_date: 'filing_date',
  period_covered: 'period_covered',
  executive_summary: 'executive_summary',
  narrative_highlights: 'narrative_highlights',
  financial_highlights: 'financial_highlights',
  revenue_data: 'revenue_data',
  profitability: 'profitability',
  balance_sheet: 'balance_sheet',
  cash_flow: 'cash_flow',
  capital_structure: 'capital_structure',
  financing_activity: 'financing_activity',
  financing_data: 'financing_data',
  risk_factors: 'risk_factors',
  key_insights: 'key_insights',
  status: 'status',
  created_at: 'created_date',
  updated_at: 'updated_date',
};

const FRONTEND_TO_DB = Object.fromEntries(
  Object.entries(DB_TO_FRONTEND).map(([db, fe]) => [fe, db])
);

function mapFromDb(row) {
  const mapped = {};
  for (const [dbKey, feKey] of Object.entries(DB_TO_FRONTEND)) {
    if (row[dbKey] !== undefined) {
      mapped[feKey] = row[dbKey];
    }
  }
  return mapped;
}

function mapToDb(obj) {
  const mapped = {};
  for (const [feKey, dbKey] of Object.entries(FRONTEND_TO_DB)) {
    if (obj[feKey] !== undefined) {
      mapped[dbKey] = obj[feKey];
    }
  }
  // Also pass through any keys that are already in DB format
  for (const [key, value] of Object.entries(obj)) {
    if (!FRONTEND_TO_DB[key] && !DB_TO_FRONTEND[key]) {
      mapped[key] = value;
    }
  }
  return mapped;
}
