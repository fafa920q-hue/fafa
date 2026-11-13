import { z } from 'zod';
export const roles = ['Owner', 'Admin', 'Member', 'Viewer'] as const;
export type Role = (typeof roles)[number];
export type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  serverConnectEnabled?: boolean;
  codexTasksEnabled?: boolean;
};
export const isAdmin = (role: Role) => role === 'Owner' || role === 'Admin';
export const writable = (role: Role) => role !== 'Viewer';
export const sourceSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['OWNED_NODE', 'REMOTE_SUBSCRIPTION', 'THIRD_PARTY_NODE']),
  group: z.string().max(80).default(''),
  redistributionAuthorized: z.boolean().default(false),
  authorizationReference: z.string().max(200).default(''),
  url: z.string().max(4096).optional(),
  content: z.string().max(1048576).optional(),
  country: z.string().max(16).default('未标注'),
  provider: z.string().max(80).default(''),
  enabled: z.boolean().default(true),
  authorized: z.literal(true),
  expiresAt: z.iso.datetime().optional(),
});
export const aiSchema = z.object({
  name: z.string().min(1).max(80),
  apiKey: z.string().min(10).max(1024),
});
export const serverSchema = z.object({
  name: z.string().min(1).max(80),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9.:[\]-]+$/),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  terminalMode: z.enum(['readonly', 'interactive']).default('readonly'),
  authType: z.enum(['key', 'password']),
  credential: z.string().min(1).max(32768),
  country: z.string().max(32).default('未标注'),
  group: z.string().max(80).default(''),
  environment: z.string().max(80).default(''),
  authorized: z.literal(true),
});
export const locationSchema = z.object({
  name: z.string().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  country: z.string().max(32).default(''),
});
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const notFound = () =>
  new AppError(404, 'NOT_FOUND', '资源不存在或无权访问');
