import { z } from 'zod';
import { money, models } from './platform-ai';

export const modelId = models;
export const audience = z.array(z.uuid()).max(1000).nullable();
export const pricing = z
  .object({
    context: z.number().int().min(256).max(262144),
    input: money.max(100_000_000),
    cached: z.number().int().min(0).max(100_000_000),
    output: money.max(500_000_000),
    cacheWrite: z.number().int().min(0).max(125_000_000).optional(),
  })
  .refine((v) => v.cached <= v.input);
export const platformModelConfig = z
  .object({
    displayName: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    supportsChat: z.boolean(),
    supportsCodex: z.boolean(),
    defaultChat: z.boolean(),
    defaultCodex: z.boolean(),
    allowedUsers: audience,
    pricing,
    taskMicros: money,
  })
  .refine(
    (v) =>
      (!v.defaultChat || (v.supportsChat && v.enabled)) &&
      (!v.defaultCodex || (v.supportsCodex && v.enabled)),
  );

export async function modelForUser(db: any, id: string, userId: string) {
  const [row] =
    await db`select * from ai_platform_models where model_id=${id} and enabled and supports_chat
    and (allowed_users is null or ${userId}::uuid=any(allowed_users))`;
  return row;
}
