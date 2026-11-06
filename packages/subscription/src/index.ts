import { parseDocument, stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { z } from 'zod';
const schema = z
  .object({
    name: z.string().max(200),
    protocol: z.enum(['vless', 'vmess', 'trojan', 'ss', 'hysteria2']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    credential: z.string().min(1).max(4096),
    cipher: z.string().optional(),
    tls: z.boolean().default(false),
    sni: z.string().optional(),
    transport: z.enum(['tcp', 'ws']).default('tcp'),
    path: z.string().optional(),
    wsHost: z.string().optional(),
  })
  .transform((n) => ({
    ...n,
    sni: n.tls ? n.sni || n.host : undefined,
    cipher: n.protocol === 'ss' ? n.cipher : undefined,
    path: n.transport === 'ws' ? n.path || '/' : undefined,
    wsHost: n.transport === 'ws' ? n.wsHost || n.host : undefined,
  }));
export type Node = z.infer<typeof schema>;
export function identity(node: Node) {
  const { name: _name, ...value } = node;
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort())))
    .digest('hex');
}
export function deduplicate(nodes: Node[]) {
  return [...new Map(nodes.map((n) => [identity(n), n])).values()];
}
const b64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');
function uri(line: string): Node {
  if (line.startsWith('vmess://')) {
    const v = JSON.parse(b64(line.slice(8)));
    if (v.net && !['tcp', 'ws'].includes(v.net))
      throw Error('暂不支持此 VMess 传输');
    return schema.parse({
      name: v.ps || v.add,
      protocol: 'vmess',
      host: v.add,
      port: Number(v.port),
      credential: v.id,
      tls: v.tls === 'tls',
      sni: v.sni,
      transport: v.net || 'tcp',
      path: v.path,
      wsHost: v.host,
    });
  }
  let raw = line;
  if (line.startsWith('ss://') && !line.slice(5).includes('@')) {
    const [body, fragment] = line.slice(5).split('#');
    raw = 'ss://' + b64(body) + (fragment ? '#' + fragment : '');
  }
  const u = new URL(raw);
  const protocol =
    u.protocol.slice(0, -1) === 'hy2' ? 'hysteria2' : u.protocol.slice(0, -1);
  const get = (key: string) => u.searchParams.get(key) || undefined;
  if (
    get('flow') ||
    get('obfs') ||
    get('insecure') === '1' ||
    get('allowInsecure') === '1'
  )
    throw Error('暂不支持此高级或不安全配置');
  if (
    get('security') === 'reality' ||
    (get('type') && !['tcp', 'ws'].includes(get('type')!))
  )
    throw Error('暂不支持此传输或 Reality 配置');
  if (protocol === 'ss' && get('plugin')) throw Error('暂不支持 SS 插件');
  let credential = decodeURIComponent(u.username);
  let cipher;
  if (protocol === 'ss') {
    const auth = u.password
      ? credential + ':' + decodeURIComponent(u.password)
      : b64(credential);
    const at = auth.indexOf(':');
    if (at < 1) throw Error('SS 凭据无效');
    cipher = auth.slice(0, at);
    credential = auth.slice(at + 1);
  }
  return schema.parse({
    name: decodeURIComponent(u.hash.slice(1)) || u.hostname,
    protocol,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || 443),
    credential,
    cipher,
    tls:
      ['trojan', 'hysteria2'].includes(protocol) || get('security') === 'tls',
    sni: get('sni') || get('peer'),
    transport: get('type') || 'tcp',
    path: get('path'),
    wsHost: get('host'),
  });
}
function structured(v: any, sing = false): Node {
  const protocol = v.type === 'shadowsocks' ? 'ss' : v.type;
  if (
    (v.transport && !['tcp', 'ws'].includes(v.transport.type)) ||
    (v.network && !['tcp', 'ws'].includes(v.network)) ||
    v.tls?.reality?.enabled ||
    v['reality-opts'] ||
    v.plugin
  )
    throw Error('暂不支持此高级节点配置');
  return schema.parse({
    name: v.name || v.tag || v.server,
    protocol,
    host: v.server,
    port: v.port || v.server_port,
    credential: v.uuid || v.password,
    cipher: v.cipher || v.method,
    tls: sing
      ? !!v.tls?.enabled
      : !!v.tls || ['trojan', 'hysteria2'].includes(protocol),
    sni: v.servername || v.sni || v.tls?.server_name,
    transport: v.network || v.transport?.type || 'tcp',
    path: v['ws-opts']?.path || v.transport?.path,
    wsHost: v['ws-opts']?.headers?.Host || v.transport?.headers?.Host,
  });
}
export function parseSubscription(input: string): Node[] {
  if (Buffer.byteLength(input) > 1048576) throw Error('订阅超过大小限制');
  let text = input.trim();
  let nodes: Node[];
  if (text.startsWith('{')) {
    const v = JSON.parse(text);
    if (!Array.isArray(v.outbounds)) throw Error('缺少 outbounds');
    nodes = v.outbounds
      .filter(
        (n: any) =>
          !['direct', 'block', 'dns', 'selector', 'urltest'].includes(n.type),
      )
      .map((n: any) => structured(n, true));
  } else if (/^proxies\s*:/m.test(text)) {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw Error('YAML 无效');
    const v = doc.toJS({ maxAliasCount: 0 });
    if (!Array.isArray(v.proxies)) throw Error('缺少 proxies');
    nodes = v.proxies.map((n: any) => structured(n));
  } else {
    if (!text.includes('://')) text = b64(text);
    nodes = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(uri);
  }
  if (!nodes.length || nodes.length > 5000)
    throw Error('节点数必须在 1 至 5000 之间');
  return deduplicate(nodes);
}
export function exportSubscription(nodes: Node[], format: string) {
  if (format === 'mihomo')
    return stringify({
      proxies: nodes.map((n) => ({
        name: n.name,
        type: n.protocol,
        server: n.host,
        port: n.port,
        ...(['vless', 'vmess'].includes(n.protocol)
          ? { uuid: n.credential }
          : { password: n.credential }),
        ...(n.cipher
          ? { cipher: n.cipher }
          : n.protocol === 'vmess'
            ? { cipher: 'auto', alterId: 0 }
            : {}),
        tls: n.tls,
        servername: n.sni,
        network: n.transport,
        ...(n.transport === 'ws'
          ? {
              'ws-opts': {
                path: n.path || '/',
                headers: { Host: n.wsHost || n.host },
              },
            }
          : {}),
      })),
      'proxy-groups': [
        { name: 'FAFA ONE', type: 'select', proxies: nodes.map((n) => n.name) },
      ],
      rules: ['MATCH,FAFA ONE'],
    });
  if (format === 'sing-box')
    return JSON.stringify(
      {
        outbounds: nodes.map((n, i) => ({
          tag: `${n.name}-${i}`,
          type: n.protocol === 'ss' ? 'shadowsocks' : n.protocol,
          server: n.host,
          server_port: n.port,
          ...(['vless', 'vmess'].includes(n.protocol)
            ? { uuid: n.credential }
            : { password: n.credential }),
          ...(n.cipher
            ? { method: n.cipher }
            : n.protocol === 'vmess'
              ? { security: 'auto', alter_id: 0 }
              : {}),
          ...(n.tls
            ? { tls: { enabled: true, server_name: n.sni || n.host } }
            : {}),
          ...(n.transport === 'ws'
            ? {
                transport: {
                  type: 'ws',
                  path: n.path || '/',
                  headers: { Host: n.wsHost || n.host },
                },
              }
            : {}),
        })),
      },
      null,
      2,
    );
  const text = nodes
    .map((n) => {
      if (n.protocol === 'vmess')
        return (
          'vmess://' +
          Buffer.from(
            JSON.stringify({
              v: '2',
              ps: n.name,
              add: n.host,
              port: String(n.port),
              id: n.credential,
              aid: '0',
              net: n.transport,
              type: 'none',
              host: n.wsHost || '',
              path: n.path || '',
              tls: n.tls ? 'tls' : '',
              sni: n.sni || '',
            }),
          ).toString('base64')
        );
      const host = n.host.includes(':') ? '[' + n.host + ']' : n.host;
      const auth =
        n.protocol === 'ss'
          ? Buffer.from(`${n.cipher}:${n.credential}`).toString('base64url')
          : encodeURIComponent(n.credential);
      const q = new URLSearchParams();
      if (n.tls) q.set('security', 'tls');
      if (n.sni) q.set('sni', n.sni);
      if (n.transport === 'ws') {
        q.set('type', 'ws');
        if (n.path) q.set('path', n.path);
        if (n.wsHost) q.set('host', n.wsHost);
      }
      return `${n.protocol}://${auth}@${host}:${n.port}?${q}#${encodeURIComponent(n.name)}`;
    })
    .join('\n');
  return format === 'base64' ? Buffer.from(text).toString('base64') : text;
}
