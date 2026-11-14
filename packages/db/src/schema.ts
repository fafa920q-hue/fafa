import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean,
} from 'drizzle-orm/pg-core';
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  disabled: boolean('disabled').notNull().default(false),
  nodeAccessEnabled: boolean('node_access_enabled').notNull().default(false),
  nodeAccessUntil: timestamp('node_access_until'),
  serverConnectEnabled: boolean('server_connect_enabled')
    .notNull()
    .default(false),
  serverConnectUntil: timestamp('server_connect_until'),
  codexTasksEnabled: boolean('codex_tasks_enabled').notNull().default(false),
  codexTasksUntil: timestamp('codex_tasks_until'),
  createdAt: timestamp('created_at').defaultNow(),
});
const resourceFields = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  data: jsonb('data').notNull(),
  secret: jsonb('secret'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  revokedAt: timestamp('revoked_at'),
});
const resource = (name: string) => pgTable(name, resourceFields());
export const invitations = resource('invitations');
export const roles = resource('roles');
export const permissions = resource('permissions');
export const user_role_grants = resource('user_role_grants');
export const node_sources = resource('node_sources');
export const nodes = resource('nodes');
export const node_groups = resource('node_groups');
export const node_group_grants = resource('node_group_grants');
export const subscription_profiles = resource('subscription_profiles');
export const subscription_tokens = resource('subscription_tokens');
export const subscription_sync_runs = resource('subscription_sync_runs');
export const node_health_checks = resource('node_health_checks');
export const traffic_usage_samples = resource('traffic_usage_samples');
export const ai_accounts = pgTable('ai_accounts', {
  ...resourceFields(),
  anthropicSecret: jsonb('anthropic_secret'),
});
export const ai_sessions = resource('ai_sessions');
export const ai_tasks = resource('ai_tasks');
export const server_connections = resource('server_connections');
export const server_access_grants = resource('server_access_grants');
export const ssh_sessions = resource('ssh_sessions');
export const location_presets = resource('location_presets');
export const background_jobs = resource('background_jobs');
