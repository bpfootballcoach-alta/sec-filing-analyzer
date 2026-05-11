/*
  # Create filing_analyses table

  1. New Tables
    - `filing_analyses`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references auth.users)
      - `file_name` (text)
      - `file_url` (text)
      - `filing_type` (text)
      - `company_name` (text)
      - `ticker` (text)
      - `filing_date` (text)
      - `period_covered` (text)
      - `executive_summary` (text)
      - `narrative_highlights` (jsonb)
      - `financial_highlights` (jsonb)
      - `revenue_data` (jsonb)
      - `profitability` (jsonb)
      - `balance_sheet` (jsonb)
      - `cash_flow` (jsonb)
      - `capital_structure` (jsonb)
      - `financing_activity` (jsonb)
      - `financing_data` (jsonb)
      - `risk_factors` (jsonb)
      - `key_insights` (jsonb)
      - `status` (text, default 'processing')
      - `created_at` (timestamptz, default now())
      - `updated_at` (timestamptz, default now())

  2. Security
    - Enable RLS on `filing_analyses` table
    - Add policies for authenticated users to CRUD their own records
*/

CREATE TABLE IF NOT EXISTS filing_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  file_url text NOT NULL,
  filing_type text DEFAULT '',
  company_name text DEFAULT '',
  ticker text DEFAULT '',
  filing_date text DEFAULT '',
  period_covered text DEFAULT '',
  executive_summary text DEFAULT '',
  narrative_highlights jsonb DEFAULT '{}',
  financial_highlights jsonb DEFAULT '[]',
  revenue_data jsonb DEFAULT '{}',
  profitability jsonb DEFAULT '{}',
  balance_sheet jsonb DEFAULT '{}',
  cash_flow jsonb DEFAULT '{}',
  capital_structure jsonb DEFAULT '{}',
  financing_activity jsonb DEFAULT '{}',
  financing_data jsonb DEFAULT '{}',
  risk_factors jsonb DEFAULT '[]',
  key_insights jsonb DEFAULT '[]',
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE filing_analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own filings"
  ON filing_analyses FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own filings"
  ON filing_analyses FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own filings"
  ON filing_analyses FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own filings"
  ON filing_analyses FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_filing_analyses_user_id ON filing_analyses(user_id);
CREATE INDEX IF NOT EXISTS idx_filing_analyses_status ON filing_analyses(status);
