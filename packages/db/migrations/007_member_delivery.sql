-- Additive upgrade: retain existing identities, Owner, sessions and node data.
ALTER TABLE member_registrations
 ADD COLUMN challenge_hash text UNIQUE,
 ADD COLUMN code_hash text,
 ADD COLUMN code_expires_at timestamptz,
 ADD COLUMN code_attempts integer NOT NULL DEFAULT 0 CHECK(code_attempts BETWEEN 0 AND 5);
ALTER TABLE users
 ADD COLUMN node_access_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN node_access_until timestamptz,
 ADD COLUMN server_connect_until timestamptz,
 ADD COLUMN codex_tasks_until timestamptz;
-- Existing accounts retain their previous capabilities. Only future accounts default closed.
UPDATE users SET node_access_enabled=true;
CREATE TABLE member_mail_events (
 id uuid PRIMARY KEY,
 owner_id uuid REFERENCES users(id),
 purpose text NOT NULL CHECK(purpose IN ('VERIFY','RESET','CODE','VERIFIED','RESET_SUCCESS','PASSWORD_CHANGED')),
 status text NOT NULL CHECK(status IN ('PENDING','ACCEPTED','FAILED')),
 failure_code text,
 provider_status integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_mail_events_owner ON member_mail_events(owner_id,created_at DESC);
REVOKE ALL ON member_mail_events,auto_grant_records FROM PUBLIC;

ALTER TABLE auto_grant_records DROP CONSTRAINT auto_grant_records_kind_check;
ALTER TABLE auto_grant_records ADD CHECK(kind IN ('node','server','token','codex'));
