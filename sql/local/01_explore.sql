-- Lab 2, step 1 (after 00_source.sql): peek at the login stream.
--
-- Each row is one login attempt, read from the topic as you ask.

SELECT event_time, account_id, ip_address, result, failure_reason
FROM "security.login_events"
ORDER BY event_time DESC
LIMIT 20;
