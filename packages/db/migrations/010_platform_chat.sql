CREATE TABLE ai_platform_models (
 model_id text PRIMARY KEY,
 display_name text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 supports_chat boolean NOT NULL DEFAULT true,
 default_chat boolean NOT NULL DEFAULT false,
 allowed_users uuid[],
 pricing jsonb NOT NULL,
 task_micros bigint NOT NULL CHECK (task_micros > 0)
);
CREATE UNIQUE INDEX ai_platform_models_one_chat_default ON ai_platform_models(default_chat) WHERE default_chat;
INSERT INTO ai_platform_models (model_id,display_name,enabled,pricing,task_micros) VALUES
 ('gpt-4.1-mini','GPT-4.1 mini',true,'{"context":262144,"input":400000,"cached":100000,"output":1600000}',1000000),
 ('gpt-5.4-mini-2026-03-17','GPT-5.4 mini',true,'{"context":262144,"input":750000,"cached":75000,"output":4500000}',1000000);
ALTER TABLE ai_platform_accounts ADD COLUMN priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 1000);
ALTER TABLE ai_platform_accounts ADD COLUMN allowed_users uuid[];
CREATE TABLE ai_platform_chats (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 deleted_at timestamptz
);
CREATE INDEX ai_platform_chats_owner ON ai_platform_chats(owner_id,updated_at DESC) WHERE deleted_at IS NULL;
ALTER TABLE ai_tasks ADD COLUMN chat_id uuid REFERENCES ai_platform_chats(id);
ALTER TABLE ai_tasks ADD COLUMN client_request_id uuid;
CREATE UNIQUE INDEX ai_tasks_chat_idempotency ON ai_tasks(chat_id,client_request_id) WHERE chat_id IS NOT NULL;
ALTER TABLE ai_platform_usage ADD COLUMN pricing jsonb;
ALTER TABLE ai_platform_usage ADD COLUMN reserved_tokens integer;
ALTER TABLE ai_platform_usage ADD COLUMN cache_write_tokens integer;
