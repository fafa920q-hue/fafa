import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { AppError, notFound } from '../../../packages/shared/src';
import {
  allowed,
  configuration,
  models,
} from '../../../packages/auth/src/platform-ai';
import {
  codexExecutionEnabled,
  codexWorkerReady,
  repositorySettings,
} from '../../../packages/auth/src/codex-execution';
import { submitPlatformTask } from './platform-ai';

const params = z.object({ id: z.uuid() });
function admin(role: string) {
  if (!codexExecutionEnabled() || role !== 'Owner') throw notFound();
}
export async function registerCodexExecution(app: FastifyInstance) {
  app.get('/api/ai/codex/config', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const enabled = codexExecutionEnabled();
    const ready = enabled && (await codexWorkerReady());
    const { policy, quota } = ready
      ? await configuration(sql, req.actor.id)
      : { policy: null, quota: null };
    if (!ready || !policy?.enabled || !quota?.enabled || !allowed(req.actor)) {
      return { enabled, ready, repositories: [], models: [] };
    }
    const repositories =
      await sql`select id,github_owner,github_repo,commit_sha,test_recipe from ai_codex_repositories
      where enabled and (allowed_users is null or ${req.actor.id}::uuid=any(allowed_users))
      order by github_owner,github_repo,commit_sha`;
    const rows =
      await sql`select m.model_id as id,m.display_name as label,m.default_codex as "default"
      from ai_platform_models m where m.enabled and m.supports_codex and m.model_id=any(${quota.models}::text[])
      and (m.allowed_users is null or ${req.actor.id}::uuid=any(m.allowed_users))
      and exists (select 1 from ai_platform_accounts a where a.enabled and a.health='READY' and a.secret is not null
        and m.model_id=any(a.models) and (a.allowed_users is null or ${req.actor.id}::uuid=any(a.allowed_users))
        and (${policy.routing} <> 'ACCOUNT' or a.id::text=${policy.target})
        and (${policy.routing} <> 'PROJECT' or a.project_id=${policy.target})
        and not exists (select 1 from settings s where s.key='platform_ai_pause:'||a.project_id
          and (s.value #>> '{}')::timestamptz > now()))
      order by m.default_codex desc,m.display_name`;
    return { enabled, ready, repositories, models: rows };
  });
  app.post('/api/ai/codex/tasks', async (req) => {
    if (!codexExecutionEnabled())
      throw new AppError(
        503,
        'AI_CODEX_RUNTIME_UNAVAILABLE',
        '隔离执行服务尚未配置',
      );
    const d = z
      .strictObject({
        model: models,
        repositoryId: z.uuid(),
        requestId: z.uuid(),
        approveTests: z.boolean(),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(10000)
          .refine((v) => !v.includes(String.fromCharCode(0))),
      })
      .parse(req.body);
    return submitPlatformTask(
      req.actor,
      { model: d.model, prompt: d.prompt, workspace: '' },
      undefined,
      d,
    );
  });
  app.post('/api/ai/codex/tasks/:id/control', async (req) => {
    const { id } = params.parse(req.params);
    const { action } = z
      .strictObject({ action: z.enum(['PAUSE', 'RESUME', 'CANCEL']) })
      .parse(req.body);
    const accepted = await sql.begin(async (tx) => {
      const [row] =
        await tx`select data->>'status' as status from ai_tasks where id=${id}
        and owner_id=${req.actor.id} and kind='CODEX' and revoked_at is null for update`;
      if (!row) throw notFound();
      if (
        (action === 'PAUSE' && row.status !== 'RUNNING') ||
        (action === 'RESUME' && row.status !== 'PAUSED') ||
        (action === 'CANCEL' &&
          !['QUEUED', 'PREPARING', 'RUNNING', 'PAUSED', 'TESTING'].includes(
            row.status,
          ))
      )
        throw new AppError(409, 'AI_CODEX_STATE', '任务当前状态不支持此操作');
      if (action === 'CANCEL' && row.status === 'QUEUED') {
        await tx`update ai_tasks set data=data||'{"status":"CANCELLED"}',updated_at=now() where id=${id}`;
        await tx`update ai_platform_usage set charged_micros=0 where task_id=${id} and dispatched_at is null and charged_micros is null`;
      } else {
        await tx`update ai_tasks set requested_action=${action},updated_at=now() where id=${id}
          and requested_action is distinct from 'CANCEL'`;
      }
      return { accepted: true };
    });
    await audit(
      req.actor.id,
      'ai.codex_' + action.toLowerCase() + '_requested',
      id,
    );
    return accepted;
  });
  app.get('/api/admin/codex/repositories', async (req) => {
    admin(req.actor.role);
    return sql`select * from ai_codex_repositories order by github_owner,github_repo,commit_sha`;
  });
  app.post('/api/admin/codex/repositories', async (req) => {
    admin(req.actor.role);
    const d = repositorySettings.parse(req.body);
    const [r] =
      await sql`insert into ai_codex_repositories(github_owner,github_repo,commit_sha,enabled,allowed_users,test_recipe)
      values(${d.githubOwner},${d.githubRepo},${d.commitSha},${d.enabled},${d.allowedUsers},${d.testRecipe})
      on conflict(github_owner,github_repo,commit_sha) do nothing returning id`;
    if (!r) throw new AppError(409, 'AI_CODEX_REPO_EXISTS', '仓库版本已经登记');
    await audit(req.actor.id, 'ai.codex_repo_added', r.id);
    return r;
  });
  app.patch('/api/admin/codex/repositories/:id', async (req) => {
    admin(req.actor.role);
    const { id } = params.parse(req.params);
    const d = repositorySettings
      .pick({ enabled: true, allowedUsers: true, testRecipe: true })
      .parse(req.body);
    const [r] =
      await sql`update ai_codex_repositories set enabled=${d.enabled},allowed_users=${d.allowedUsers},test_recipe=${d.testRecipe}
      where id=${id} returning id`;
    if (!r) throw notFound();
    await audit(req.actor.id, 'ai.codex_repo_updated', id);
    return r;
  });
}
