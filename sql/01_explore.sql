-- L2 step 1: peek at the live login stream in your team's Kafka cluster.
-- Before running: match the quoted "avro.security.login_events" source below
-- to LOGIN_TOPIC in .env ("avro.<LOGIN_TOPIC>"). SQL Workspace does not load .env.
--
-- SQL Workspace imported the topic as a source table. Its name contains dots,
-- so always wrap it in double quotes.

SELECT event_time, account_id, ip_address, result, failure_reason
FROM "avro.security.login_events"
ORDER BY event_time DESC
LIMIT 20;
