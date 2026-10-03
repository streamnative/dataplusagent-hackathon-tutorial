-- Start Lab 2 over: drop what the lab created. The Kafka topic and its source are untouched.

DROP TABLE IF EXISTS flagged_accounts;
DROP MATERIALIZED VIEW IF EXISTS login_failures;
