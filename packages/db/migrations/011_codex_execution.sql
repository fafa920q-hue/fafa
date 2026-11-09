CREATE TABLE ai_codex_repositories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 github_owner text NOT NULL,
 github_repo text NOT NULL,
 commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
 enabled boolean NOT NULL DEFAULT false,
 allowed_users uuid[],
 test_recipe text NOT NULL DEFAULT 'NONE' CHECK (test_recipe IN ('NONE','NODE_TEST')),
 UNIQUE(github_owner,github_repo,commit_sha)
);
ALTER TABLE ai_tasks ADD COLUMN kind text NOT NULL DEFAULT 'GPT' CHECK (kind IN ('GPT','CODEX'));
ALTER TABLE ai_tasks ADD COLUMN codex_repo_id uuid REFERENCES ai_codex_repositories(id);
ALTER TABLE ai_tasks ADD COLUMN requested_action text CHECK (requested_action IN ('PAUSE','RESUME','CANCEL'));
ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_codex_repository_check CHECK ((kind='CODEX') = (codex_repo_id IS NOT NULL)) NOT VALID;
CREATE INDEX ai_tasks_codex_queue ON ai_tasks(created_at) WHERE kind='CODEX' AND data->>'status'='QUEUED';

CREATE UNIQUE INDEX ai_tasks_codex_request ON ai_tasks(owner_id,client_request_id) WHERE kind='CODEX' AND client_request_id IS NOT NULL;
