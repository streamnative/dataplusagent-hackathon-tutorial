-- Start Lab 2 over: drop what the lab created. The Kafka topic is untouched.

DROP TABLE IF EXISTS flagged_accounts;
DROP MATERIALIZED VIEW IF EXISTS login_failures;
DROP SOURCE IF EXISTS "security.login_events";
