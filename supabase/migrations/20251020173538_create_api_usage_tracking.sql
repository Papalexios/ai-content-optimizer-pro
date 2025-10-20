/*
  # API Usage Tracking System

  1. New Table
    - `api_usage_tracking` - Track API usage per provider per day
      - `id` (uuid, primary key)
      - `provider` (text) - API provider name (gemini, openai, etc.)
      - `date` (date) - Usage date
      - `request_count` (int) - Total requests for the day
      - `token_count` (bigint) - Total tokens used
      - `estimated_cost` (decimal) - Estimated cost in USD
      - `last_updated` (timestamptz) - Last update timestamp
      - Unique constraint on (provider, date)

  2. Security
    - Enable RLS
    - Public access for tracking usage

  3. Indexes
    - Index on provider and date for fast lookups
    - Index on date for cleanup operations
*/

-- API Usage Tracking Table
CREATE TABLE IF NOT EXISTS api_usage_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  date date NOT NULL,
  request_count int DEFAULT 0,
  token_count bigint DEFAULT 0,
  estimated_cost decimal(10, 6) DEFAULT 0,
  last_updated timestamptz DEFAULT now(),
  UNIQUE(provider, date)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_provider_date ON api_usage_tracking(provider, date);
CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage_tracking(date DESC);

-- Enable RLS
ALTER TABLE api_usage_tracking ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Allow public read access to usage"
  ON api_usage_tracking FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Allow public insert to usage"
  ON api_usage_tracking FOR INSERT
  TO public
  WITH CHECK (true);

CREATE POLICY "Allow public update to usage"
  ON api_usage_tracking FOR UPDATE
  TO public
  USING (true);

-- Function to cleanup old usage data (keep 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_api_usage()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM api_usage_tracking
  WHERE date < CURRENT_DATE - INTERVAL '90 days';
END;
$$;

-- Auto-update last_updated timestamp
CREATE OR REPLACE FUNCTION update_api_usage_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.last_updated = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_api_usage_tracking_timestamp
  BEFORE UPDATE ON api_usage_tracking
  FOR EACH ROW
  EXECUTE FUNCTION update_api_usage_timestamp();