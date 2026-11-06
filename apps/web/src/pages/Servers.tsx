import { useEffect, useRef, useState } from 'react';
import {
  Server,
  Plus,
  Terminal as TerminalIcon,
  ShieldCheck,
} from 'lucide-react';
import {
  Card,
  PageTitle,
  useData,
  useApp,
  FormDialog,
  ConfirmDialog,
  Dialog,
  Empty,
  Badge,
  DataState,
  type Row,
  type Field,
} from '../../../../packages/ui/src/core';
const fields: Field[] = [
  { name: 'name', label: '备注名称', required: true },
  {
    name: 'host',
    label: 'IPv4 / IPv6 / 域名',
    required: true,
    help: '仅可连接你有权管理且已加入服务端白名单的公网目标。',
  },
  {
    name: 'port',
    label: 'SSH 端口',
    type: 'number',
    value: '22',
    min: 1,
    max: 65535,
    required: true,
  },
  { name: 'username', label: 'SSH 用户名', value: 'deploy', required: true },
  {
    name: 'authType',
    label: '认证方式',
    options: [
      { label: 'SSH 私钥（推荐）', value: 'key' },
      { label: '密码', value: 'password' },
    ],
  },
  {
    name: 'terminalMode',
    label: '终端模式',
    options: [
      { label: '只读诊断（uptime）', value: 'readonly' },
      { label: '交互终端（需服务端开关及额外批准）', value: 'interactive' },
    ],
  },
  {
    name: 'credential',
    label: '私钥或密码',
    type: 'textarea',
    required: true,
    help: '保存后仅显示「已配置」，不支持回显。',
  },
  { name: 'country', label: '所在地区', value: '未标注' },
  { name: 'group', label: '分组' },
  { name: 'environment', label: '环境标签', placeholder: '开发 / 测试 / 生产' },
  {
    name: 'authorized',
    label: '我拥有此服务器管理权限并授权连接',
    type: 'checkbox',
    required: true,
  },
];
export function Servers() {
  const { request, toast, session } = useApp();
  const data = useData<Row[]>('/api/server_connections');
  const shared = useData<Row[]>('/api/servers/shared');
  const [edit, setEdit] = useState<Row | null | undefined>();
  const [remove, setRemove] = useState<Row>();
  const [pin, setPin] = useState<{ row: Row; fingerprint: string }>();
  const [writeApprove, setWriteApprove] = useState<Row>();
  const [approve, setApprove] = useState<Row>();
  const [terminal, setTerminal] = useState<{ row: Row; ticket: string }>();
  const writable = session.user.role !== 'Viewer';
  return (
    <>
      <PageTitle
        title="我的服务器"
        description="自己的基础设施，独立凭据、固定指纹与可审计的连接。"
        action={
          writable && (
            <button className="primary" onClick={() => setEdit(null)}>
              <Plus size={16} />
              添加服务器
            </button>
          )
        }
      />
      <div className="stack">
        <div className="callout">
          <ShieldCheck size={15} /> 安全连接流程：服务端授权目标 → 探测主机指纹
          → 通过可信渠道核验并固定 → 显式批准终端。内网目标暂不开放，请规划受控
          agent / Tailscale 接入。
        </div>
        <Card
          title="服务器列表"
          description="状态来自真实连接；未连接的服务器显示未知"
          icon={Server}
        >
          <DataState
            error={data.error}
            loading={!data.data}
            onRetry={data.refresh}
          />
          <div className="resource-grid">
            {[...(data.data || []), ...(shared.data || [])].map((r) => (
              <article className="resource-card" key={r.id}>
                <div className="resource-top">
                  <h3>{r.name}</h3>
                  <Badge>
                    {r.demo
                      ? '演示 · 未连接'
                      : r.lastConnected
                        ? '曾成功连接'
                        : '未知'}
                  </Badge>
                </div>
                <div className="resource-meta">
                  <span>
                    {r.username}@{r.host}:{r.port}
                  </span>
                  <span>
                    {r.country} · {r.group || '未分组'} ·{' '}
                    {r.environment || '未标注环境'}
                  </span>
                  <span>
                    凭据：{r.credentialConfigured ? '已配置' : '未配置'} ·{' '}
                    {r.shared ? '获授权共享' : '我的资源'}
                  </span>
                  <span>主机指纹：{r.fingerprint || '尚未固定'}</span>
                  <span>
                    最近成功：
                    {r.lastConnected
                      ? new Date(r.lastConnected).toLocaleString('zh-CN')
                      : '从未连接'}
                  </span>
                </div>
                {writable && (
                  <div className="actions">
                    {!r.shared && (
                      <button onClick={() => setEdit(r)}>编辑</button>
                    )}
                    <button
                      disabled={r.demo}
                      onClick={() =>
                        request(`/api/servers/${r.id}/probe`, 'POST')
                          .then((result) => {
                            if (r.fingerprint) toast('指纹与已固定记录一致');
                            else
                              setPin({
                                row: r,
                                fingerprint: result.fingerprint,
                              });
                          })
                          .catch(() => {})
                      }
                    >
                      探测 / 测试
                    </button>
                    <button
                      disabled={r.demo || !r.fingerprint}
                      onClick={() => setApprove(r)}
                    >
                      <TerminalIcon size={13} />
                      终端
                    </button>
                    {!r.shared && (
                      <button className="danger" onClick={() => setRemove(r)}>
                        删除
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
          </div>
          {data.data?.length === 0 && shared.data?.length === 0 && (
            <Empty
              title="尚无服务器"
              description="添加配置不会立即发起连接。SSH 目标须由管理员在服务端明确授权。"
            />
          )}
        </Card>
      </div>
      <FormDialog
        open={edit !== undefined}
        onClose={() => setEdit(undefined)}
        title={edit ? '编辑服务器' : '添加服务器'}
        fields={fields.map((f) => ({
          ...f,
          value: edit?.[f.name] !== undefined ? String(edit[f.name]) : f.value,
        }))}
        notice="编辑时须重新提供凭据，已固定的主机指纹将要求重新核验。加密私钥的 passphrase 暂未支持。"
        onSubmit={async (d) => {
          await request(
            '/api/server_connections' + (edit ? '/' + edit.id : ''),
            edit ? 'PUT' : 'POST',
            d,
          );
          data.refresh();
          toast('服务器配置已保存，尚未连接');
        }}
      />
      <ConfirmDialog
        open={!!remove}
        title="删除服务器？"
        description="此配置将不可连接，审计记录仍保留。"
        onClose={() => setRemove(undefined)}
        onConfirm={async () => {
          await request('/api/server_connections/' + remove!.id, 'DELETE');
          data.refresh();
        }}
      />
      <ConfirmDialog
        open={!!pin}
        title="核验首次主机指纹"
        description={`请通过服务器控制台等可信渠道核对以下 SHA-256 十六进制指纹：${pin?.fingerprint}。确认后固定，变化时拒绝连接。`}
        onClose={() => setPin(undefined)}
        onConfirm={async () => {
          await request(`/api/servers/${pin!.row.id}/pin`, 'POST', {
            fingerprint: pin!.fingerprint,
          });
          data.refresh();
        }}
      />
      <ConfirmDialog
        open={!!approve}
        title="批准交互式 SSH 终端？"
        description="终端具备远程账户权限。所有输入会直接发给服务器，请逐条审查命令。不要粘贴未经审查的 AI 输出。此次批准仅对这一会话有效，5 分钟无输入断开。"
        onClose={() => setApprove(undefined)}
        onConfirm={async () => {
          if (approve!.terminalMode === 'interactive') {
            setWriteApprove(approve!);
            return;
          }
          const r = await request(
            `/api/servers/${approve!.id}/terminal-ticket`,
            'POST',
            { confirmed: true },
          );
          setTerminal({ row: approve!, ticket: r.ticket });
        }}
      />
      <ConfirmDialog
        open={!!writeApprove}
        title="额外批准高风险写入权限？"
        description="交互式终端可写文件、重启服务或部署。此次明确批准仅授予本会话远程账户完整 shell 权限，命令须由你逐条审查；AI 不会自动执行。默认推荐只读诊断模式。"
        onClose={() => setWriteApprove(undefined)}
        onConfirm={async () => {
          const r = await request(
            `/api/servers/${writeApprove!.id}/terminal-ticket`,
            'POST',
            { confirmed: true, writeApproved: true },
          );
          setTerminal({ row: writeApprove!, ticket: r.ticket });
        }}
      />
      <Dialog
        open={!!terminal}
        onClose={() => {
          setTerminal(undefined);
          data.refresh();
        }}
        title={terminal?.row.name + ' · SSH 终端'}
      >
        {terminal && (
          <TerminalView server={terminal.row} ticket={terminal.ticket} />
        )}
      </Dialog>
    </>
  );
}
function TerminalView({ server, ticket }: { server: Row; ticket: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { session } = useApp();
  const [status, setStatus] = useState('正在建立授权连接…');
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(
      ([{ Terminal }, { FitAddon }]) => {
        if (disposed) return;
        const term = new Terminal({
          fontSize: 12,
          cursorBlink: true,
          theme: { background: '#121b32', foreground: '#e5e9ff' },
          scrollback: 1000,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(ref.current!);
        fit.fit();
        const ws = new WebSocket(
          `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/servers/${server.id}/terminal`,
        );
        ws.onopen = () => {
          ws.send(JSON.stringify({ ticket, csrf: session.csrf }));
          setStatus('已建立终端通道，等待 SSH 握手');
        };
        ws.onmessage = (e) => {
          setStatus('SSH 终端 · 请审查所有输入');
          term.write(e.data);
        };
        ws.onclose = (e) =>
          setStatus(e.reason || '连接已关闭；重新开启终端可重连');
        ws.onerror = () => setStatus('连接失败，请检查网络与授权');
        term.onData((data) => {
          if (ws.readyState === 1)
            ws.send(JSON.stringify({ type: 'input', data }));
        });
        const observer = new ResizeObserver(() => {
          fit.fit();
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                type: 'resize',
                rows: term.rows,
                cols: term.cols,
              }),
            );
        });
        observer.observe(ref.current!);
        cleanup = () => {
          observer.disconnect();
          ws.close();
          term.dispose();
        };
      },
    );
    return () => {
      disposed = true;
      cleanup();
    };
  }, [server.id, ticket]);
  return (
    <>
      <p className="callout" role="status">
        {status}
      </p>
      <div className="terminal-container section-space" ref={ref} />
      <small>关闭面板将断开连接。终端输出不进入审计日志。</small>
    </>
  );
}
