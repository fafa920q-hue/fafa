import { z } from 'zod';
import { sql } from '../../db/src';
import { platformAiEnabled } from '../../shared/src/platform-ai';

export const codexCalls = 6;
export const activeAiStatuses = [
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'PAUSED',
  'TESTING',
] as const;
export const repositorySettings = z.object({
  githubOwner: z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/),
  githubRepo: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  enabled: z.boolean(),
  allowedUsers: z.array(z.uuid()).max(1000).nullable(),
  testRecipe: z.enum(['NONE', 'NODE_TEST']),
});
export function codexExecutionEnabled() {
  return process.env.PLATFORM_CODEX_EXEC_ENABLED === 'true';
}
export function platformAccountsEnabled() {
  return platformAiEnabled() || codexExecutionEnabled();
}
export async function codexWorkerReady(db: any = sql) {
  if (!codexExecutionEnabled() || process.env.DEMO_MODE === 'true')
    return false;
  const [worker] =
    await db`select 1 as alive from settings where key='codex_execution_heartbeat'
    and updated_at>now()-interval '30 seconds'`;
  return !!worker;
}
export async function repositoryForUser(db: any, userId: string, id: string) {
  const [r] =
    await db`select * from ai_codex_repositories where id=${id} and enabled
    and (allowed_users is null or ${userId}::uuid=any(allowed_users))`;
  return r;
}
