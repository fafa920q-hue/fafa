import { capabilityAllowed } from '../../../packages/auth/src/auto-grant';
import { assertServiceOpen } from '../../../packages/auth/src/service-policy';
import {
  activeGrant,
  resolveAccess,
  serverAllowed,
} from '../../../packages/auth/src/business-access';
import { Client } from 'ssh2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, audit } from '../../../packages/db/src';
import { unseal, token, hash } from '../../../packages/shared/src/crypto';
import { AppError, notFound, writable } from '../../../packages/shared/src';
import { resolvePublic } from '../../../packages/subscription/src/network';
export function hostKeyMatches(pinned: string, actual: string) {
  return !!pinned && pinned === actual;
}
async function target(row: any) {
  if (process.env.DEMO_MODE === 'true')
    throw new AppError(409, 'DEMO_BLOCKED', '演示模式不连接 SSH');
  const allowed = (process.env.SSH_ALLOWED_TARGETS || '')
    .split(',')
    .map((s) => s.trim());
  if (!allowed.includes(`${row.data.host}:${row.data.port}`))
    throw new AppError(403, 'EGRESS_DENIED', '请先在服务端授权此 SSH 目标');
  return resolvePublic(row.data.host);
}
async function accessible(id: string, userId: string) {
  const [raw] =
    await sql`SELECT * FROM users WHERE id=${userId} AND NOT disabled AND deleted_at IS NULL`;
  const user = raw ? await resolveAccess(raw) : null;
  if (!user || !capabilityAllowed(user, 'server') || !serverAllowed(user, id))
    throw notFound();
  const [r] =
    await sql`select s.*,g.data as grant_data from server_connections s join users u on u.id=s.owner_id left join server_access_grants g on g.server_id=s.id and g.user_id=${userId} and g.revoked_at is null where s.id=${id} and s.revoked_at is null and not u.disabled and u.deleted_at is null and (s.owner_id=${userId} or g.id is not null)`;
  if (!r || (r.owner_id !== userId && !activeGrant(r.grant_data)))
    throw notFound();
  return r;
}
function connectionOptions(row: any, address: string) {
  const credential = unseal(row.secret);
  return {
    host: address,
    port: row.data.port,
    username: row.data.username,
    readyTimeout: 10000,
    hostHash: 'sha256' as const,
    ...(row.data.authType === 'key'
      ? { privateKey: credential }
      : { password: credential }),
  };
}
export async function registerSsh(app: FastifyInstance, origins: string[]) {
  const tickets = new Map<
    string,
    {
      userId: string;
      serverId: string;
      expires: number;
      interactiveApproved: boolean;
    }
  >();
  const active = new Map<string, number>();
  app.get('/api/servers/shared', async (req) =>
    (
      await sql`select s.id,s.data from server_connections s join server_access_grants g on g.server_id=s.id where g.user_id=${req.actor.id} and g.revoked_at is null and s.revoked_at is null`
    )
      .filter((r) => serverAllowed(req.actor, r.id))
      .map((r) => ({ id: r.id, ...r.data, shared: true })),
  );
  app.post('/api/servers/:id/probe', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const row = await accessible(id, req.actor.id);
    const ip = await target(row);
    let observed = '';
    await new Promise<void>((resolve, reject) => {
      const c = new Client();
      c.on('error', () => {
        if (observed) resolve();
        else
          reject(
            new AppError(
              502,
              'SSH_FAILED',
              'SSH 握手失败，请检查目标与网络策略',
            ),
          );
      }).on('close', () =>
        observed
          ? resolve()
          : reject(new AppError(502, 'SSH_FAILED', 'SSH 握手失败')),
      );
      c.connect({
        ...connectionOptions(row, ip.address),
        hostVerifier: (key: string) => {
          observed = 'SHA256:' + key;
          return false;
        },
      });
    });
    if (
      row.data.fingerprint &&
      !hostKeyMatches(row.data.fingerprint, observed)
    ) {
      await audit(req.actor.id, 'ssh.hostkey_changed', id);
      throw new AppError(
        409,
        'HOST_KEY_CHANGED',
        '主机指纹发生变化，已阻止连接，请线下核验',
      );
    }
    await sql`update server_connections set data=data || ${sql.json({ pendingFingerprint: observed, probeAt: new Date().toISOString() })} where id=${id}`;
    await audit(req.actor.id, 'ssh.fingerprint_observed', id);
    return {
      fingerprint: observed,
      notice: '请通过可信渠道核验，探测未执行登录',
    };
  });
  app.post('/api/servers/:id/pin', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { fingerprint } = z
      .object({ fingerprint: z.string().min(16) })
      .parse(req.body);
    const row = await accessible(id, req.actor.id);
    if (row.owner_id !== req.actor.id) throw notFound();
    if (
      row.data.fingerprint ||
      fingerprint !== row.data.pendingFingerprint ||
      Date.now() - new Date(row.data.probeAt).getTime() > 300000
    )
      throw new AppError(
        409,
        'FINGERPRINT_INVALID',
        '指纹确认无效，请重新探测；已固定指纹不可直接覆盖',
      );
    await sql`update server_connections set data=(data-'pendingFingerprint') || ${sql.json({ fingerprint })} where id=${id}`;
    await audit(req.actor.id, 'ssh.fingerprint_pinned', id);
    return { ok: true };
  });
  app.post('/api/servers/:id/terminal-ticket', async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const approval = z
      .object({
        confirmed: z.literal(true),
        writeApproved: z.boolean().default(false),
      })
      .parse(req.body);
    if (Date.now() - new Date(req.actor.reauthenticated_at).getTime() > 600000)
      throw new AppError(403, 'REAUTH_REQUIRED', '开启终端需要重新登录');
    const row = await accessible(id, req.actor.id);
    await target(row);
    if (
      row.data.terminalMode === 'interactive' &&
      (process.env.SSH_INTERACTIVE_ENABLED !== 'true' ||
        !approval.writeApproved)
    )
      throw new AppError(
        403,
        'WRITE_APPROVAL_REQUIRED',
        '交互式写入需要服务端开关与额外显式批准',
      );
    if (!row.data.fingerprint)
      throw new AppError(409, 'PIN_REQUIRED', '请先核验并固定主机指纹');
    if ((active.get(req.actor.id) || 0) >= 2)
      throw new AppError(429, 'SESSION_LIMIT', '最多同时打开两个终端');
    for (const [key, t] of tickets)
      if (t.expires < Date.now()) tickets.delete(key);
    const raw = token();
    tickets.set(hash(raw), {
      userId: req.actor.id,
      serverId: id,
      expires: Date.now() + 30000,
      interactiveApproved:
        row.data.terminalMode === 'interactive' && approval.writeApproved,
    });
    await audit(req.actor.id, 'ssh.terminal_approved', id);
    return { ticket: raw };
  });
  app.get('/api/servers/:id/terminal', { websocket: true }, (ws, req) => {
    if (
      !origins.includes(req.headers.origin || '') ||
      !writable(req.actor.role)
    ) {
      ws.close(1008, '访问被拒绝');
      return;
    }
    let client: Client | undefined;
    let stream: any;
    let interactive = false;
    let initialized = false;
    let idle = Date.now();
    let sshId: string | undefined;
    const actor = req.actor;
    const deadline = setTimeout(() => {
      if (!initialized) ws.close(1008, '确认超时');
    }, 5000);
    const watchdog = setInterval(async () => {
      const [session] =
        await sql`select id from sessions where id=${actor.session_id} and revoked_at is null and expires_at>now()`;
      const [rawUser] =
        await sql`select * from users where id=${actor.id} and not disabled`;
      const u = rawUser ? await resolveAccess(rawUser) : null;
      let permitted = true;
      try {
        if (u) await assertServiceOpen(u);
        await accessible((req.params as any).id, actor.id);
      } catch {
        permitted = false;
      }
      if (
        Date.now() - idle > 300000 ||
        !session ||
        !u ||
        !capabilityAllowed(u, 'server') ||
        !permitted
      )
        ws.close(1008, '会话已过期');
    }, 10000);
    ws.on('message', async (raw: Buffer) => {
      try {
        const [rawLive] =
          await sql`select u.* from users u join sessions s on s.owner_id=u.id where u.id=${actor.id} and s.id=${actor.session_id} and s.revoked_at is null and s.expires_at>now() and not u.disabled and u.deleted_at is null`;
        const live = rawLive ? await resolveAccess(rawLive) : null;
        if (!live || !capabilityAllowed(live, 'server')) {
          ws.close(1008, '服务器授权已撤销或到期');
          return;
        }
        await assertServiceOpen(live);
        idle = Date.now();
        if (!initialized) {
          initialized = true;
          const { ticket, csrf } = z
            .object({ ticket: z.string(), csrf: z.string() })
            .parse(JSON.parse(raw.toString()));
          const t = tickets.get(hash(ticket));
          tickets.delete(hash(ticket));
          if (
            !t ||
            t.expires < Date.now() ||
            t.userId !== actor.id ||
            t.serverId !== (req.params as any).id ||
            csrf !== actor.csrf
          )
            throw Error('终端授权无效');
          if ((active.get(actor.id) || 0) >= 2) throw Error('会话超限');
          const row = await accessible(t.serverId, actor.id);
          const ip = await target(row);
          interactive = row.data.terminalMode === 'interactive';
          if (
            interactive &&
            (!t.interactiveApproved ||
              process.env.SSH_INTERACTIVE_ENABLED !== 'true')
          )
            throw Error('交互式写入批准已失效');
          active.set(actor.id, (active.get(actor.id) || 0) + 1);
          const [record] =
            await sql`insert into ssh_sessions(owner_id,server_id,data) values(${actor.id},${row.id},'{"status":"CONNECTING"}') returning id`;
          sshId = record.id;
          client = new Client();
          client
            .on('error', () => ws.close(1011, 'SSH 连接失败或指纹不匹配'))
            .on('ready', () => {
              void sql`update server_connections set data=data || ${sql.json({ status: 'ONLINE', lastConnected: new Date().toISOString() })} where id=${row.id}`;
              const onChannel: Parameters<Client['exec']>[1] = (err, s) => {
                if (err) {
                  ws.close(1011);
                  return;
                }
                stream = s;
                s.on('data', (data: Buffer) => {
                  if (ws.bufferedAmount > 1048576) ws.close(1009);
                  else ws.send(data.toString('utf8'));
                });
                s.on('close', () => ws.close());
              };
              if (row.data.terminalMode === 'interactive')
                client!.shell(
                  { term: 'xterm-256color', cols: 80, rows: 24 },
                  onChannel,
                );
              else client!.exec('uptime', onChannel);
            });
          client.connect({
            ...connectionOptions(row, ip.address),
            hostVerifier: (key: string) =>
              hostKeyMatches(row.data.fingerprint, 'SHA256:' + key),
          });
        } else if (stream && interactive) {
          const message = JSON.parse(raw.toString());
          if (message.type === 'resize')
            stream.setWindow(
              Math.min(200, Math.max(2, message.rows)),
              Math.min(300, Math.max(20, message.cols)),
              0,
              0,
            );
          else if (
            message.type === 'input' &&
            typeof message.data === 'string' &&
            message.data.length <= 8192
          )
            stream.write(message.data);
        }
      } catch {
        ws.close(1008, '终端授权或输入无效');
      }
    });
    ws.on('close', () => {
      clearTimeout(deadline);
      clearInterval(watchdog);
      client?.end();
      if (sshId) {
        active.set(actor.id, Math.max(0, (active.get(actor.id) || 1) - 1));
        void sql`update ssh_sessions set data='{"status":"CLOSED"}',updated_at=now() where id=${sshId}`;
        void audit(actor.id, 'ssh.session_closed', sshId);
      }
    });
  });
}
