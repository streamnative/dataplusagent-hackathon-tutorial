-- Lab 2, step 1: peek at the live login stream in your Kafka cluster.
-- Before running: the source below is named exactly after the topic. If your
-- LOGIN_TOPIC in .env is not security.login_events, use your topic's name here.
-- SQL Workspace does not read .env.
--
-- The SQL catalog imported the topic as a source. Its name contains dots, so
-- always wrap it in double quotes.

SELECT event_time, account_id, ip_address, result, failure_reason
FROM "security.login_events"
ORDER BY event_time DESC
LIMIT 20;
