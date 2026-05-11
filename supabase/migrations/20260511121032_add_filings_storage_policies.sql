/*
  # Add storage policies for the filings bucket

  1. Security
    - Enable public read access to filings bucket (for viewing uploaded documents)
    - Enable authenticated and anon uploads to filings bucket
*/

-- Allow public read access
CREATE POLICY "Public read access for filings"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'filings');

-- Allow anyone to upload
CREATE POLICY "Allow uploads to filings"
  ON storage.objects FOR INSERT
  TO public
  WITH CHECK (bucket_id = 'filings');
