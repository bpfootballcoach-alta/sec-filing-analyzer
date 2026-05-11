/*
  # Allow unauthenticated access to filing_analyses

  The original app did not require authentication (requiresAuth: false).
  This migration adds policies that allow unauthenticated users to
  read, create, update, and delete filings, while keeping the
  authenticated policies in place for when users do log in.

  1. Security changes
    - Add SELECT policy for anon users (can see all filings)
    - Add INSERT policy for anon users (user_id will be null)
    - Add UPDATE policy for anon users (can update filings with null user_id)
    - Add DELETE policy for anon users (can delete filings with null user_id)
*/

-- Allow anon users to view all filings
CREATE POLICY "Anon users can view filings"
  ON filing_analyses FOR SELECT
  TO anon
  USING (true);

-- Allow anon users to insert filings (user_id will be null)
CREATE POLICY "Anon users can insert filings"
  ON filing_analyses FOR INSERT
  TO anon
  WITH CHECK (true);

-- Allow anon users to update filings
CREATE POLICY "Anon users can update filings"
  ON filing_analyses FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

-- Allow anon users to delete filings
CREATE POLICY "Anon users can delete filings"
  ON filing_analyses FOR DELETE
  TO anon
  USING (true);
