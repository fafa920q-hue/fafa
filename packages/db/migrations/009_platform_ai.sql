CREATE TABLE ai_platform_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id text NOT NULL,
 service_account_id text NOT NULL,
 name text NOT NULL,
 note text NOT NULL DEFAULT '',
 models text[] NOT NULL,
 secret jsonb,
 enabled boolean NOT NULL DEFAULT false,
 health text NOT NULL DEFAULT 'UNCHECKED' CHECK (health IN ('UNCHECKED','CHECK_PENDING','CHECK_RUNNING','READY','ERROR','THROTTLED','REVOKED')),
 revision integer NOT NULL DEFAULT 1,
 daily_micros bigint NOT NULL CHECK (daily_micros > 0),
 monthly_micros bigint NOT NULL CHECK (monthly_micros >= daily_micros),
 concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 20),
 checked_at timestamptz,
 last_error text,
 UNIQUE (project_id, service_account_id)
);

ALTER TABLE ai_tasks ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE ai_tasks ADD COLUMN platform_account_id uuid REFERENCES ai_platform_accounts(id);
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_one_account CHECK (
 (account_id IS NOT NULL) <> (platform_account_id IS NOT NULL)
) NOT VALID;

CREATE TABLE ai_platform_usage (
 task_id uuid PRIMARY KEY REFERENCES ai_tasks(id),
 user_id uuid NOT NULL REFERENCES users(id),
 account_id uuid NOT NULL REFERENCES ai_platform_accounts(id),
 project_id text NOT NULL,
 model text NOT NULL,
 account_revision integer NOT NULL,
 reserved_micros bigint NOT NULL CHECK (reserved_micros > 0),
 charged_micros bigint CHECK (charged_micros >= 0),
 input_tokens integer,
 cached_tokens integer,
 output_tokens integer,
 response_id text,
 dispatched_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_platform_usage_recent ON ai_platform_usage(created_at);
