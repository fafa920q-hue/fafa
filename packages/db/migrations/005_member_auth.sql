-- Additive only: existing users, Google identities and Owner binding are untouched.
CREATE TABLE member_credentials (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 username text NOT NULL UNIQUE CHECK(username ~ '^[a-z0-9_]{3,32}$'),
 email_key text NOT NULL UNIQUE,
 password_hash text NOT NULL CHECK(password_hash LIKE '$argon2id$%'),
 email_verified_at timestamptz NOT NULL,
 password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE member_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text NOT NULL CHECK(username ~ '^[a-z0-9_]{3,32}$'),
 email_key text NOT NULL,
 password_hash text NOT NULL CHECK(password_hash LIKE '$argon2id$%'),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_registration_email ON member_registrations(email_key,expires_at);
CREATE TABLE member_action_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 purpose text NOT NULL CHECK(purpose='PASSWORD_RESET'),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_action_user ON member_action_tokens(user_id,expires_at);
CREATE TABLE member_auth_buckets (
 key_hash text PRIMARY KEY CHECK(key_hash ~ '^[0-9a-f]{64}$'),
 hits integer NOT NULL CHECK(hits>0),
 window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE member_google_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users(id),
 session_id uuid NOT NULL REFERENCES sessions(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 consumed_at timestamptz
);
INSERT INTO settings(key,value) VALUES ('member_registration_open','false') ON CONFLICT(key) DO NOTHING;
REVOKE ALL ON member_credentials,member_registrations,member_action_tokens,member_auth_buckets,member_google_links FROM PUBLIC;
