-- 新用户前三天自动授权策略（005）。
-- 策略键存入 settings；授权本身复用 node_group_grants / server_access_grants，
-- 本表只记录自动授权的成功 / 待分配 / 失败轨迹（审计用），不构成第二套权限系统。
-- 活动窗口 2026-11-07 21:33 至 2026-11-10 21:33（UTC+8），此处以 UTC 存储。
INSERT INTO settings(key, value) VALUES
  ('auto_grant_enabled', 'false'),
  ('auto_grant_window_start', '"2026-11-07T13:33:00Z"'),
  ('auto_grant_window_end', '"2026-11-10T13:33:00Z"'),
  ('auto_grant_node_source_id', 'null'),
  ('auto_grant_node_limit', 'null'),
  ('auto_grant_trial_valid_days', '3')
ON CONFLICT (key) DO NOTHING;

-- 用户自带服务器（BYOC + BYOS）能力开关：既有用户默认开启（不收回
-- 已有功能），新用户默认关闭，由自动授权或管理员开通。
-- 注意：没有“体验服务器”——自动授权只开“连接自己的服务器”资格，
-- 不授予任何指定服务器行访问，不提供平台算力或共享 SSH 账号。
ALTER TABLE users ADD COLUMN server_connect_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN codex_tasks_enabled boolean NOT NULL DEFAULT false;
UPDATE users SET server_connect_enabled = true, codex_tasks_enabled = true;

CREATE TABLE auto_grant_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('node', 'server', 'token')),
  resource_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  status text NOT NULL CHECK (status IN ('GRANTED', 'PENDING', 'FAILED')),
  reason text,
  expires_at timestamptz,
  granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auto_grant_records_unique ON auto_grant_records(user_id, kind, resource_id);
CREATE INDEX auto_grant_records_user ON auto_grant_records(user_id);
CREATE INDEX auto_grant_records_status ON auto_grant_records(status);
