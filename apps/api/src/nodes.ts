import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit, own } from '../../../packages/db/src';
import { AppError, notFound, isAdmin } from '../../../packages/shared/src';
import { seal } from '../../../packages/shared/src/crypto';
import { parseBatch, nodeMetadata, type Node } from '../../../packages/subscription/src';
const batchSchema = z.object({
  name: z.string().min(1).max(80),
  group: z.string().max(80).default(''),
  kind: z.enum(['OWNED_NODE', 'THIRD_PARTY_NODE']),
  content: z.string().min(1).max(1048576),
  authorized: z.literal(true),
  redistributionAuthorized: z.boolean().default(false),
  authorizationReference: z.string().max(200).default(''),
});
function summary(row: any) {
  return {
    id: row.id, sourceId: row.source_id, ownerId: row.owner_id,
    name: row.data.name, protocol: row.data.protocol, country: row.data.country,
    group: row.data.group || row.source_data?.group || row.source_data?.kind || '', tags: row.data.tags || [], aliases: row.data.aliases || [],
    enabled: row.data.enabled !== false,
    status: row.data.enabled === false ? 'DISABLED' : 'PENDING_VERIFICATION',
    latency: null, traffic: null,
  };
}
export async function registerNodes(app: FastifyInstance) {
  const importBatch = (data: z.infer<typeof batchSchema>, admin: boolean) => {
    if (data.kind === 'THIRD_PARTY_NODE' && (!admin || !data.redistributionAuthorized || !data.authorizationReference.trim()))
      throw new AppError(403, 'REDISTRIBUTION_REQUIRED', '第三方节点导入需要管理员权限与聚合、再分发授权确认');
    try { return parseBatch(data.content); }
    catch { throw new AppError(400, 'IMPORT_INVALID', '导入内容为空、过大或节点数量超限'); }
  };
  app.post('/api/node-import/preview', async (req) => {
    const data = batchSchema.parse(req.body);
    const result = importBatch(data, isAdmin(req.actor.role));
    return { valid: result.nodes.length, duplicates: result.duplicates, failures: result.failures,
      nodes: result.nodes.map((node) => nodeMetadata(node)) };
  });
  app.post('/api/node-import', async (req) => {
    const data = batchSchema.parse(req.body);
    const result = importBatch(data, isAdmin(req.actor.role));
    if (!result.nodes.length) throw new AppError(400, 'IMPORT_EMPTY', '没有有效节点，请先预览解析结果');
    const source = await sql.begin(async (tx) => {
      const [source] = await tx`insert into node_sources(owner_id,data) values(${req.actor.id},${tx.json({
        name: data.name, group: data.group, kind: data.kind, authorized: true,
        redistributionAuthorized: data.redistributionAuthorized, authorizationReference: data.authorizationReference,
        country: '多地区', enabled: true,
        status: 'READY', nodeCount: result.nodes.length, failedCount: result.failures.length,
      })}) returning id`;
      for (const node of result.nodes)
        await tx`insert into nodes(owner_id,source_id,data,secret) values(${req.actor.id},${source.id},${tx.json({ ...nodeMetadata(node), group: data.group })},${tx.json(seal(JSON.stringify(node)))})`;
      return source;
    });
    await audit(req.actor.id, 'nodes.imported', source.id, req.id);
    return { sourceId: source.id, imported: result.nodes.length, duplicates: result.duplicates, failures: result.failures };
  });
  app.get('/api/nodes', async (req) => {
    const rows = await sql`select n.*,s.data as source_data from nodes n join node_sources s on s.id=n.source_id join users u on u.id=s.owner_id where n.revoked_at is null and s.revoked_at is null and not u.disabled and u.deleted_at is null and (s.owner_id=${req.actor.id} or ((s.data->>'kind'='OWNED_NODE' or s.data->>'redistributionAuthorized'='true') and exists(select 1 from node_group_grants g where g.source_id=s.id and g.user_id=${req.actor.id} and g.revoked_at is null))) order by n.created_at limit 5000`;
    return rows.map(summary);
  });
  app.patch('/api/nodes/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const changes = z.object({
      name: z.string().min(1).max(200).optional(), country: z.string().max(32).optional(),
      group: z.string().max(80).optional(), enabled: z.boolean().optional(),
    }).parse(req.body);
    const node = await own('nodes', id, req.actor.id);
    if (!node) throw notFound();
    await sql`update nodes set data=data || ${sql.json({ ...changes, overrides: { ...(node.data.overrides || {}), ...changes } })},updated_at=now() where id=${id} and owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'node.updated', id, req.id);
    return { ok: true };
  });
  app.put('/api/nodes/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const data = z.object({ content: z.string().min(1).max(16384), authorized: z.literal(true) }).parse(req.body);
    const node = await own('nodes', id, req.actor.id);
    if (!node) throw notFound();
    const source = await own('node_sources', node.source_id, req.actor.id);
    if (!source || source.data.kind === 'REMOTE_SUBSCRIPTION')
      throw new AppError(400, 'REMOTE_MANAGED', '远程节点连接参数由上游管理，请编辑订阅源');
    const parsed = parseBatch(data.content);
    if (parsed.nodes.length !== 1 || parsed.failures.length)
      throw new AppError(400, 'NODE_INVALID', '请提供一个有效节点配置');
    const fresh = parsed.nodes[0] as Node;
    await sql`update nodes set secret=${sql.json(seal(JSON.stringify(fresh)))},data=${sql.json({ ...node.data, ...nodeMetadata(fresh), group: node.data.group || '' })},updated_at=now() where id=${id} and owner_id=${req.actor.id}`;
    await audit(req.actor.id, 'node.configuration_updated', id, req.id);
    return { ok: true };
  });
  app.delete('/api/nodes/:id', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const node = await own('nodes', id, req.actor.id);
    if (!node) throw notFound();
    await sql.begin(async (tx) => {
      await tx`select id from node_sources where id=${node.source_id} for update`;
      await tx`update nodes set revoked_at=now(),updated_at=now(),data=data || '{"userDeleted":true}'::jsonb where id=${id} and owner_id=${req.actor.id}`;
      const [count] = await tx`select count(*)::int as total from nodes where source_id=${node.source_id} and revoked_at is null`;
      await tx`update node_sources set data=data || ${tx.json({ nodeCount: count.total })},updated_at=now() where id=${node.source_id}`;
    });
    await audit(req.actor.id, 'node.deleted', id, req.id);
    return { ok: true };
  });
}
