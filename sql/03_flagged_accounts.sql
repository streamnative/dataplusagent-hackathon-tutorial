-- L2 step 3: the table your agent will write to in L4 (with your approval).

CREATE TABLE flagged_accounts (
  account_id VARCHAR PRIMARY KEY,
  reason     VARCHAR,
  flagged_at TIMESTAMPTZ DEFAULT now()
);
