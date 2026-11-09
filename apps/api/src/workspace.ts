import type { FastifyInstance } from 'fastify';
import { sql } from '../../../packages/db/src';
import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import {
  activeGrant,
  resolveAccess,
  sourceAllowed,
} from '../../../packages/auth/src/business-access';
import {
  readServicePolicy,
  serviceOpen,
} from '../../../packages/auth/src/service-policy';

const activeAt = (value: unknown) =>
  !value ||
  (typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) > Date.now());
export async function memberNodeCatalog(actor: any) {
  actor = await resolveAccess(actor);
  if (actor.role === 'Member' && !actor._access.policy.catalogEnabled)
    return [];
  const open = serviceOpen(await readServicePolicy(), actor);
  const rows = await sql`
  SELECT n.id,n.source_id,n.data,s.data AS source_data,
   (SELECT g.data FROM node_group_grants g WHERE g.source_id=s.id AND g.user_id=${actor.id} AND g.revoked_at IS NULL LIMIT 1) AS grant_data
  FROM nodes n JOIN node_sources s ON s.id=n.source_id JOIN users u ON u.id=s.owner_id
  WHERE n.revoked_at IS NULL AND s.revoked_at IS NULL AND u.role IN ('Owner','Admin')
   AND NOT u.disabled AND u.deleted_at IS NULL AND n.data->>'catalogVisible' IS DISTINCT FROM 'false'
   AND s.data->>'demo' IS DISTINCT FROM 'true' AND n.data->>'demo' IS DISTINCT FROM 'true'
  ORDER BY n.created_at LIMIT 5000`;
  return rows.map((row) => {
    const node = row.data,
      source = row.source_data;
    const enabled = node.enabled !== false && source.enabled !== false;
    const sourceActive = activeAt(source.expiresAt);
    const legal =
      source.kind === 'OWNED_NODE' ||
      (source.authorized === true &&
        source.redistributionAuthorized === true &&
        Boolean(source.authorizationReference?.trim()));
    const baseGrant =
      actor._access.base.node && row.grant_data && activeGrant(row.grant_data);
    const authorized =
      open &&
      enabled &&
      sourceActive &&
      legal &&
      sourceAllowed(actor, row.source_id, node.group || source.group || '') &&
      (baseGrant || actor._access.overlaySources.includes(row.source_id)) &&
      capabilityAllowed(actor, 'node');
    return {
      id: row.id,
      sourceId: row.source_id,
      name: String(node.name || '未命名节点'),
      country: String(node.country || '未标注'),
      region: String(node.region || ''),
      protocol: String(node.protocol || ''),
      group: String(node.group || source.group || ''),
      enabled,
      health:
        enabled && sourceActive
          ? 'NOT_CHECKED'
          : !enabled
            ? 'DISABLED'
            : 'EXPIRED',
      latency: null,
      lastCheckedAt: null,
      authorized,
      canSubscribe:
        authorized &&
        (baseGrant ||
          actor._access.subscriptionSources.includes(row.source_id)) &&
        actor.subscription_enabled === true &&
        Number(actor.node_limit) > 0,
    };
  });
}
export async function registerWorkspace(app: FastifyInstance) {
  app.get('/api/catalog/nodes', async (req) => ({
    nodes: await memberNodeCatalog(req.actor),
    serverTime: new Date().toISOString(),
  }));
  app.get('/api/workspace', async (req) => {
    const id = req.actor.id;
    const policy = await readServicePolicy();
    const open = serviceOpen(policy, req.actor);
    const [identity] =
      await sql`SELECT c.username,c.email_verified_at,EXISTS(SELECT 1 FROM google_identities g WHERE g.user_id=u.id) AS google_linked FROM users u LEFT JOIN member_credentials c ON c.user_id=u.id WHERE u.id=${id}`;
    const [counts] = await sql`SELECT
   (SELECT count(*)::int FROM subscription_profiles WHERE owner_id=${id} AND revoked_at IS NULL) AS subscriptions,
   (SELECT count(*)::int FROM ai_accounts WHERE owner_id=${id} AND revoked_at IS NULL) AS ai_accounts,
   (SELECT count(*)::int FROM server_connections WHERE owner_id=${id} AND revoked_at IS NULL) AS servers`;
    const nodes = await memberNodeCatalog(req.actor);
    const history =
      await sql`SELECT id,action,created_at FROM audit_events WHERE owner_id=${id} ORDER BY created_at DESC LIMIT 8`;
    return {
      user: {
        name: req.actor.name,
        role: req.actor.role,
        username: identity?.username || null,
        emailVerified:
          Boolean(identity?.email_verified_at) ||
          identity?.google_linked === true,
      },
      statistics: {
        visibleNodes: nodes.length,
        authorizedNodes: nodes.filter((n) => n.authorized).length,
        subscriptions: counts.subscriptions,
        aiAccounts: counts.ai_accounts,
        servers: counts.servers,
      },
      capabilities: {
        node: open && capabilityAllowed(req.actor, 'node'),
        subscribe:
          open &&
          req.actor.subscription_enabled === true &&
          capabilityAllowed(req.actor, 'node'),
        server: open && capabilityAllowed(req.actor, 'server'),
        codex: open && capabilityAllowed(req.actor, 'codex'),
      },
      service: {
        open,
        schedule: {
          enabled:
            policy.schedule.enabled && policy.schedule.mode === 'WINDOW_ONLY',
          startsAt: policy.schedule.startsAt,
          endsAt: policy.schedule.endsAt,
        },
      },
      access: {
        overlays: (req.actor as any)._access?.overlays,
        traffic: (req.actor as any)._access?.traffic,
      },
      history,
      serverTime: new Date().toISOString(),
    };
  });
}
