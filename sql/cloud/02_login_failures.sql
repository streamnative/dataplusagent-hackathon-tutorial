-- Lab 2, step 2: turn the stream into always-fresh context for the agent.
-- Before running: the source below is named exactly after the topic. If your
-- LOGIN_TOPIC in .env is not security.login_events, use your topic's name here.
-- SQL Workspace does not read .env.
--
-- A materialized view is maintained incrementally: every new login event
-- updates the counts within seconds. No batch job, no refresh.

CREATE MATERIALIZED VIEW login_failures AS
SELECT
  account_id,
  COUNT(*) FILTER (WHERE result = 'FAILURE') AS failed_logins,
  COUNT(*) FILTER (WHERE result = 'SUCCESS') AS successful_logins,
  COUNT(DISTINCT ip_address)                AS distinct_ips,
  MAX(event_time)                           AS last_seen
FROM "security.login_events"
GROUP BY account_id;

-- Check it: the accounts with the most failed logins.
SELECT *
FROM login_failures
ORDER BY failed_logins DESC
LIMIT 10;
