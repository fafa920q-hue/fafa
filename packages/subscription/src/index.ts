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
    alterId: z.number().int().min(0).max(65535).optional(),
    security: z
      .enum(['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'])
      .optional(),
    country: z.string().max(32).optional(),
    tags: z.array(z.string().max(200)).max(100).optional(),
    aliases: z.array(z.string().max(200)).max(100).optional(),
    tls: z.boolean().default(false),
    sni: z.string().optional(),
    transport: z.enum(['tcp', 'ws']).default('tcp'),
    path: z.string().optional(),
    wsHost: z.string().optional(),
  })
  .transform((n) => ({
    ...n,
    ...labelsForName(n.name),
    alterId: n.protocol === 'vmess' ? n.alterId || 0 : undefined,
    security: n.protocol === 'vmess' ? n.security || 'auto' : undefined,
    sni: n.tls ? n.sni || n.host : undefined,
    cipher: n.protocol === 'ss' ? n.cipher : undefined,
    path: n.transport === 'ws' ? n.path || '/' : undefined,
    wsHost: n.transport === 'ws' ? n.wsHost || n.host : undefined,
  }));
export type Node = z.infer<typeof schema>;
export function identity(node: Node) {
  const {
    name: _name,
    country: _country,
    tags: _tags,
    aliases: _aliases,
    ...value
  } = node;
  if (node.protocol === 'vmess') {
    value.alterId = node.alterId || 0;
    value.security = node.security || 'auto';
  }
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(Object.entries(value).sort())))
    .digest('hex');
}
export function deduplicate(nodes: Node[]) {
  const result = new Map<string, Node>();
  for (const node of nodes) {
    const key = identity(node);
    const existing = result.get(key);
    result.set(
      key,
      existing
        ? {
            ...existing,
            tags: [
              ...new Set([...(existing.tags || []), ...(node.tags || [])]),
            ],
            aliases: [
              ...new Set([
                ...(existing.aliases || []),
                node.name,
                ...(node.aliases || []),
              ]),
            ]
              .filter((name) => name !== existing.name)
              .slice(0, 100),
          }
        : node,
    );
  }
  return [...result.values()];
}
const b64 = (v: string) => Buffer.from(v, 'base64').toString('utf8');
export function parseNodeUri(line: string): Node {
  if (!line.includes('://') && /^(ss|vmess)%3a/i.test(line))
    line = decodeURIComponent(line);
  if (line.startsWith('vmess://'))
    return vmess(JSON.parse(b64(decodeURIComponent(line.slice(8)))));
  let raw = line;
  if (line.startsWith('ss://') && !line.slice(5).split('#')[0].includes('@')) {
    const separator = line.indexOf('#');
    const body = separator < 0 ? line.slice(5) : line.slice(5, separator);
    const fragment = separator < 0 ? '' : line.slice(separator + 1);
    const decoded = b64(body);
    const at = decoded.lastIndexOf('@');
    const colon = decoded.indexOf(':');
    if (at < 0 || colon < 1 || colon > at) throw Error('SS 凭据无效');
    raw = 'ss://' + encodeURIComponent(decoded.slice(0, colon)) + ':' +
      encodeURIComponent(decoded.slice(colon + 1, at)) + '@' + decoded.slice(at + 1) +
      (fragment ? '#' + fragment : '');
  }
  if (raw.startsWith('ss://')) {
    const at = raw.indexOf('@');
    const userinfo = raw.slice(5, at);
    if (at > 5 && !userinfo.includes(':'))
      raw = 'ss://' + Buffer.from(b64(decodeURIComponent(userinfo))).toString('base64url') + raw.slice(at);
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
    if (!u.port) throw Error('SS 缺少端口');
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
    v.plugin ||
    v['skip-cert-verify'] ||
    v.tls?.insecure
  )
    throw Error('暂不支持此高级节点配置');
  return schema.parse({
    name: v.name || v.tag || v.server,
    protocol,
    host: v.server,
    port: v.port || v.server_port,
    credential: v.uuid || v.password,
    cipher: protocol === 'ss' ? v.cipher || v.method : undefined,
    security: protocol === 'vmess' ? (sing ? v.security : v.cipher) : undefined,
    alterId: v.alterId || v.alter_id || 0,
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
  if (/^(ss|vmess)%3a/i.test(text)) text = decodeURIComponent(text);
  let nodes: Node[];
  if (text.startsWith('{')) {
    const v = JSON.parse(text);
    if (v.add && v.id) return [vmess(v)];
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
      .map(parseNodeUri);
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
            ? { cipher: n.security || 'auto', alterId: n.alterId || 0 }
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
              ? { security: n.security || 'auto', alter_id: n.alterId || 0 }
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
              aid: String(n.alterId || 0),
              scy: n.security || 'auto',
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
          ? n.cipher?.startsWith('2022-')
            ? `${encodeURIComponent(n.cipher)}:${encodeURIComponent(n.credential)}`
            : Buffer.from(`${n.cipher}:${n.credential}`).toString('base64url')
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

export function labelsForName(name: string) {
  const regions: [string, RegExp][] = [
    ['香港', /香港|hong.?kong|🇭🇰/i],
    ['台湾', /台湾|台灣|taiwan|🇹🇼/i],
    ['日本', /日本|东京|大阪|japan|tokyo|🇯🇵/i],
    ['新加坡', /新加坡|singapore|🇸🇬/i],
    ['美国', /美国|美國|洛杉矶|united.?states|🇺🇸/i],
    ['英国', /英国|英國|united.?kingdom|🇬🇧/i],
    ['德国', /德国|德國|germany|🇩🇪/i],
    ['法国', /法国|法國|france|🇫🇷/i],
    ['韩国', /韩国|韓國|korea|🇰🇷/i],
    ['加拿大', /加拿大|canada|🇨🇦/i],
    ['澳大利亚', /澳大利亚|澳洲|australia|🇦🇺/i],
    ['印度', /印度|india|🇮🇳/i],
    ['荷兰', /荷兰|荷蘭|netherlands|🇳🇱/i],
    ['爱尔兰', /爱尔兰|愛爾蘭|ireland|🇮🇪/i],
  ];
  const flag = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)?.[0];
  const iso = flag
    ? [...flag]
        .map((character) =>
          String.fromCharCode(character.codePointAt(0)! - 0x1f1e6 + 65),
        )
        .join('')
    : undefined;
  return {
    country:
      regions.find(([, pattern]) => pattern.test(name))?.[0] ||
      (iso
        ? new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(iso)
        : undefined) ||
      '未标注',
    tags: [
      ...new Set(
        name.match(
          /IEPL|IPLC|(?:下载|下載)(?:专用|專用)?|download(?:.?only)?|\d+(?:\.\d+)?\s*(?:倍|[xX])/gi,
        ) || [],
      ),
    ],
  };
}
function vmess(v: any): Node {
  if (
    (v.net && !['tcp', 'ws'].includes(v.net)) ||
    (v.type && v.type !== 'none') ||
    (v.tls && v.tls !== 'tls' && v.tls !== true) ||
    v.allowInsecure === true ||
    v.allowInsecure === '1' ||
    v.alpn ||
    v.fp
  )
    throw Error('不支持的 VMess 参数，未改写配置');
  if (!z.uuid().safeParse(v.id).success) throw Error('VMess 身份格式无效');
  return schema.parse({
    name: v.ps || v.add,
    protocol: 'vmess',
    host: v.add,
    port: Number(v.port),
    credential: v.id,
    alterId: Number(v.aid || 0),
    security: v.scy || 'auto',
    tls: v.tls === 'tls' || v.tls === true,
    sni: v.sni,
    transport: v.net || 'tcp',
    path: v.path,
    wsHost: v.host,
  });
}
export function parseBatch(input: string) {
  if (Buffer.byteLength(input) > 1048576) throw Error('订阅超过大小限制');
  let text = input.trim();
  if (/^(ss|vmess)%3a/i.test(text)) text = decodeURIComponent(text);
  if (
    !text.includes('://') &&
    !text.startsWith('{') &&
    !text.startsWith('proxies') &&
    !/^(ss|vmess)%3a/i.test(text)
  )
    text = b64(text);
  const entries =
    text.startsWith('{') || /^proxies\s*:/m.test(text)
      ? [text]
      : text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
  if (!entries.length || entries.length > 5000)
    throw Error('节点数必须在 1 至 5000 之间');
  const accepted: Node[] = [];
  const failures: { line: number; code: string }[] = [];
  entries.forEach((entry, index) => {
    try {
      accepted.push(...parseSubscription(entry));
    } catch {
      failures.push({ line: index + 1, code: 'PARSE_FAILED' });
    }
  });
  const nodes = deduplicate(accepted);
  return { nodes, failures, duplicates: accepted.length - nodes.length };
}
export function nodeMetadata(node: Node, country = '未标注') {
  return {
    name: node.name,
    protocol: node.protocol,
    country: node.country === '未标注' ? country : node.country,
    tags: node.tags || [],
    aliases: node.aliases || [],
    enabled: true,
    status: 'PENDING_VERIFICATION',
  };
}
