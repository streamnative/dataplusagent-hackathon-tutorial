-- Start L2 over: drop what the tutorial created. The Kafka topic is untouched.

DROP TABLE IF EXISTS flagged_accounts;
DROP MATERIALIZED VIEW IF EXISTS login_failures;
