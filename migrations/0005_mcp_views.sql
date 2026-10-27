-- Read views the MCP tools need beyond 0004, and a login for the read-only role (R15, R16).
-- Neither view holds homeowner data: street segments are public reference geometry, and a job's
-- parent key is a CRM record id.

-- The reference street map, so a tool can normalize and geocode the caller's own address the
-- same way the pipeline normalized stored ones (Q1 origin, Q5 address key, Q3 street names).
CREATE VIEW v_street_segments AS
SELECT street_name, street_type, city, state, zip, from_number, to_number, start_lat, start_lon,
       end_lat, end_lon
  FROM street_segments;

-- CRM A visits of one job share a parent key (Q1 counts a job once, not each visit). jobs.
-- parent_job_id stays null when the parent job has no canonical row of its own, so the key comes
-- from the visit's source record: "<sourceSystem>:<sourceAccount>:<parent sourceRecordId>".
CREATE VIEW v_job_parents AS
SELECT DISTINCT l.job_id,
       sr.source_system || ':' || sr.source_account || ':' ||
         (sr.payload ->> 'parentSourceRecordId') AS parent_key
  FROM job_links l
  JOIN source_records sr ON sr.id = l.source_record_id
 WHERE sr.payload ->> 'parentSourceRecordId' IS NOT NULL;

GRANT SELECT ON v_street_segments, v_job_parents TO hsmcp_reader;

-- `npm start` connects as this role (src/cli/mcp.ts). Local-only credential, like the compose
-- superuser's; HSMCP_READER_PASSWORD overrides it on the client side if an operator changes it.
ALTER ROLE hsmcp_reader WITH LOGIN PASSWORD 'hsmcp_reader';
