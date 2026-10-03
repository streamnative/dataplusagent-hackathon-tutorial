-- Lab 2, step 3: the table your agent will write to in Lab 4 (with your approval).

CREATE TABLE flagged_accounts (
  account_id VARCHAR PRIMARY KEY,
  reason     VARCHAR,
  flagged_at TIMESTAMPTZ DEFAULT now()
);
