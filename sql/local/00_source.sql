-- Lab 2, step 1: connect RisingWave to the login topic.
--
-- A source is a topic RisingWave reads. This one reads the diskless topic
-- security.login_events and decodes each event with the Avro schema in the
-- schema registry; `(*)` takes every field of that schema as a column.
--
-- RisingWave runs in a container, so it reaches the broker and the registry by
-- their names on the stack's network (kafka, schema-registry), not by 127.0.0.1.
--
-- The source is named after the topic. The name contains a dot, so always wrap
-- it in double quotes.

CREATE SOURCE IF NOT EXISTS "security.login_events" (*)
WITH (
  connector = 'kafka',
  topic = 'security.login_events',
  properties.bootstrap.server = 'kafka:19092',
  scan.startup.mode = 'earliest'
) FORMAT PLAIN ENCODE AVRO (
  schema.registry = 'http://schema-registry:8081'
);
