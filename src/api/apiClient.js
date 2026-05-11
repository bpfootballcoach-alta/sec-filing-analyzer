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

// ── DB column names (snake_case) ───────────────────────────────────────────
// Frontend uses camelCase, DB uses snake_case. We map at the boundary.

const FE_TO_DB = {
  id: 'id',
  user_id: 'user_id',
  fileName: 'file_name',
  fileUrl: 'file_url',
  filingType: 'filing_type',
  companyName: 'company_name',
  ticker: 'ticker',
  filingDate: 'filing_date',
  periodCovered: 'period_covered',
  executiveSummary: 'executive_summary',
  narrativeHighlights: 'narrative_highlights',
  financialHighlights: 'financial_highlights',
  revenueData: 'revenue_data',
  profitability: 'profitability',
  balanceSheet: 'balance_sheet',
  cashFlow: 'cash_flow',
  capitalStructure: 'capital_structure',
  financingActivity: 'financing_activity',
  financingData: 'financing_data',
  riskFactors: 'risk_factors',
  keyInsights: 'key_insights',
  status: 'status',
  createdDate: 'created_at',
  updatedDate: 'updated_at',
  // Also accept snake_case keys directly
  file_name: 'file_name',
  file_url: 'file_url',
  filing_type: 'filing_type',
  company_name: 'company_name',
  filing_date: 'filing_date',
  period_covered: 'period_covered',
  executive_summary: 'executive_summary',
  narrative_highlights: 'narrative_highlights',
  financial_highlights: 'financial_highlights',
  revenue_data: 'revenue_data',
  balance_sheet: 'balance_sheet',
  cash_flow: 'cash_flow',
  capital_structure: 'capital_structure',
  financing_activity: 'financing_activity',
  financing_data: 'financing_data',
  risk_factors: 'risk_factors',
  key_insights: 'key_insights',
  created_date: 'created_at',
  updated_date: 'updated_at',
};

const DB_TO_FE = {
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

function mapFromDb(row) {
  const mapped = {};
  for (const [dbKey, feKey] of Object.entries(DB_TO_FE)) {
    if (row[dbKey] !== undefined) {
      mapped[feKey] = row[dbKey];
    }
  }
  return mapped;
}

function mapToDb(obj) {
  const mapped = {};
  for (const [key, value] of Object.entries(obj)) {
    const dbKey = FE_TO_DB[key];
    if (dbKey) {
      mapped[dbKey] = value;
    } else {
      // Pass through unknown keys as-is
      mapped[key] = value;
    }
  }
  return mapped;
}

// ── FilingAnalysis entity ──────────────────────────────────────────────────

export const FilingAnalysis = {
  async list(orderBy = '-created_date', limit = 50) {
    // Parse orderBy: "-created_date" means descending on created_date
    const desc = orderBy.startsWith('-');
    const field = desc ? orderBy.slice(1) : orderBy;
    const dbField = FE_TO_DB[field] || field;

    const { data, error } = await supabase
      .from('filing_analyses')
      .select('*')
      .order(dbField, { ascending: !desc })
      .limit(limit);
    if (error) throw error;
    return (data || []).map(mapFromDb);
  },

  async filter(filters) {
    let query = supabase.from('filing_analyses').select('*');
    for (const [key, value] of Object.entries(filters)) {
      const dbKey = FE_TO_DB[key] || key;
      query = query.eq(dbKey, value);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(mapFromDb);
  },

  async create(fields) {
    let userId = null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      userId = user?.id || null;
    } catch (_) { /* not authenticated — userId stays null */ }
    const dbFields = mapToDb({ ...fields, user_id: userId });
    const { data, error } = await supabase
      .from('filing_analyses')
      .insert(dbFields)
      .select()
      .single();
    if (error) throw error;
    return mapFromDb(data);
  },

  async update(id, fields) {
    const dbFields = mapToDb(fields);
    dbFields.updated_at = new Date().toISOString();
    const { data, error } = await supabase
      .from('filing_analyses')
      .update(dbFields)
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

// ── Functions ───────────────────────────────────────────────────────────────

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

// ── LLM Integration ────────────────────────────────────────────────────────

const GEMINI_KEY_STORAGE = 'gemini_api_key';

export function getGeminiApiKey() {
  return localStorage.getItem(GEMINI_KEY_STORAGE) || '';
}

export function setGeminiApiKey(key) {
  if (key) {
    localStorage.setItem(GEMINI_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(GEMINI_KEY_STORAGE);
  }
}

export const llm = {
  invoke: async ({ prompt, response_json_schema, model }) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      throw new Error('Gemini API key not configured. Click "Set API Key" in the header to add your key from Google AI Studio.');
    }
    const data = await invokeEdgeFunction('invoke-llm', {
      prompt,
      response_json_schema,
      model: model || 'gemini-2.0-flash',
      api_key: apiKey,
    });
    if (data.raw !== undefined) return data.raw;
    if (data.result !== undefined) return data.result;
    return data;
  },
};

// ── File upload ─────────────────────────────────────────────────────────────

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
