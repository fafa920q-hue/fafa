ALTER TABLE users ADD COLUMN node_limit integer NOT NULL DEFAULT 500 CHECK(node_limit >= 0 AND node_limit <= 5000), ADD COLUMN subscription_enabled boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX invite_email_active ON invitations(lower(data->>'email')) WHERE revoked_at IS NULL AND NOT(data ? 'usedAt');
