-- G6: CRM A visits now point at a canonical parent job through jobs.parent_job_id, so the
-- payload-based parent key from 0005 is replaced by the canonical link. Same columns: parent_key
-- is now the parent job's id. A job listed here as a parent_key is a container for its visits.
CREATE OR REPLACE VIEW v_job_parents AS
SELECT j.id AS job_id, j.parent_job_id AS parent_key
  FROM jobs j
 WHERE j.parent_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_parent_job_id_idx ON jobs (parent_job_id);
