import { Link } from 'react-router-dom';
import {
  Activity,
  Server,
  Users,
  ArrowLeftRight,
  Globe2,
  Code2,
  MapPin,
  ShieldCheck,
  Link2,
  ChevronRight,
  Terminal,
  Plus,
  Zap,
  Info,
  Copy,
} from 'lucide-react';
import {
  Card,
  Badge,
  PageTitle,
  useData,
  useApp,
  LocationPreview,
  DataState,
  type Row,
} from '../../../../packages/ui/src/core';
export const flag = (country: string) =>
  ({
    日本: '🇯🇵',
    美国: '🇺🇸',
    新加坡: '🇸🇬',
    香港: '🇭🇰',
    英国: '🇬🇧',
    德国: '🇩🇪',
  })[country] || '🌐';
export function Dashboard() {
  const { session, request } = useApp();
  const summary = useData<any>('/api/summary');
  const sources = useData<Row[]>('/api/node_sources');
  const accounts = useData<Row[]>('/api/ai_accounts');
  const servers = useData<Row[]>('/api/server_connections');
  const locations = useData<Row[]>('/api/location_presets');
  const s = summary.data;
  const location = locations.data?.[0];
  return (
    <>
      <PageTitle
        title="欢迎使用 FAFA ONE 控制面板 👋"
        description="一体化的节点、Codex、服务器与位置管理平台"
        eyebrow="YOUR WORKSPACE, CONNECTED"
      />
      <DataState
        error={summary.error}
        loading={false}
        onRetry={summary.refresh}
      />
      <div className="stats">
        {[
          {
            label: '在线节点',
            value: '未检测',
            hint: `${s?.nodes ?? '—'} 个可用配置`,
            icon: Activity,
          },
          {
            label: '我的服务器',
            value: s?.servers ?? '—',
            hint: '状态来自真实连接',
            icon: Server,
          },
          {
            label: '用户席位',
            value:
              s?.seats != null ? `${s.seats} / ${s.seatLimit}` : '按权限隔离',
            hint: session.demo ? '演示用户 · 上限可调整' : '个人私有空间',
            icon: Users,
          },
          {
            label: '累计流量',
            value: '数据不可用',
            hint: '尚未接入计量接口',
            icon: ArrowLeftRight,
          },
        ].map((item) => (
          <div className="glass stat" key={item.label}>
            <span className="stat-icon">
              <item.icon size={23} />
            </span>
            <div>
              <label>{item.label}</label>
              <strong
                className={
                  typeof item.value === 'string' && item.value.length > 6
                    ? 'unavailable'
                    : ''
                }
              >
                {item.value}
              </strong>
              <small>{item.hint}</small>
            </div>
          </div>
        ))}
      </div>
      <div className="dashboard-grid">
        <Card
          title="VPN 节点中心"
          description="统一管理自有与第三方节点，独立订阅、安全聚合"
          icon={Globe2}
          action={
            <Link to="/subscriptions" aria-label="打开节点订阅">
              <ChevronRight size={18} />
            </Link>
          }
        >
          <div className="tabs">
            <Link
              className="button primary"
              to="/subscriptions"
              style={{ flex: 1, minHeight: 31, fontSize: 11 }}
            >
              统一订阅
            </Link>
            <Link
              className="button"
              to="/subscriptions"
              style={{ flex: 1, minHeight: 31, fontSize: 11 }}
            >
              自有节点
            </Link>
            <Link
              className="button"
              to="/subscriptions"
              style={{ flex: 1, minHeight: 31, fontSize: 11 }}
            >
              第三方节点
            </Link>
          </div>
          <div className="subscription-strip">
            <Link2 size={24} />
            <div>
              <strong>统一订阅（自有 + 第三方）</strong>
              <small>每用户独立令牌 · 可轮换与撤销</small>
            </div>
            <Link className="button primary" to="/subscriptions">
              <Copy size={14} />
              管理订阅链接
            </Link>
          </div>
          <div className="country-grid">
            {(sources.data?.length ? sources.data : [])
              .slice(0, 6)
              .map((source) => (
                <Link
                  className="country-tile"
                  key={source.id}
                  to="/subscriptions"
                >
                  <span className="flag">{flag(source.country)}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong>{source.country}</strong>
                    <small>
                      {source.demo
                        ? '演示样例 · 未探测'
                        : `${source.nodeCount || 0} 个节点 · 未探测`}
                    </small>
                    <div className="subtle-progress" />
                  </div>
                </Link>
              ))}
          </div>
          {sources.data?.length === 0 && (
            <p className="callout">尚无订阅源，添加你的授权订阅即可开始。</p>
          )}
        </Card>
        <Card
          title="Codex 工作台"
          description="多 API 账户 · 独立会话 · 安全任务"
          icon={Code2}
          action={
            <Link to="/codex" aria-label="打开 Codex">
              <ChevronRight size={18} />
            </Link>
          }
        >
          <div className="workspace-grid">
            <div className="inner-panel">
              <label>当前 API 账户</label>
              <select
                aria-label="当前 API 账户"
                value={
                  accounts.data?.find((a) => a.selected)?.id ||
                  accounts.data?.[0]?.id ||
                  ''
                }
                onChange={(e) =>
                  request('/api/ai/select', 'POST', {
                    accountId: e.target.value,
                  })
                    .then(accounts.refresh)
                    .catch(() => {})
                }
                disabled={session.user.role === 'Viewer'}
              >
                {!accounts.data?.length && (
                  <option value="">尚未添加账户</option>
                )}
                {accounts.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {accounts.data?.map((a) => (
                <div key={a.id} className="account-entry">
                  <span className="account-icon">C</span>
                  <span>{a.name}</span>
                  <Badge>{a.credentialConfigured ? '待验证' : '未配置'}</Badge>
                </div>
              ))}
              <p style={{ fontSize: 10, marginTop: 12 }}>
                API 独立计费
                <br />
                不使用 ChatGPT Plus 额度
              </p>
            </div>
            <div className="inner-panel">
              <span className="panel-label">工作空间 / API 助手</span>
              <div className="terminal-preview">
                <div className="window-dots">
                  <i />
                  <i />
                  <i />
                </div>
                <div className="code-line" />
                <div className="code-line" />
                <div className="code-line" />
                <strong>
                  <Terminal size={21} />
                  Codex Workspace
                </strong>
              </div>
            </div>
          </div>
          <div className="recent">
            <Badge>未连接外部服务</Badge>
            <p>配置你的 API Key 后创建任务。ChatGPT 授权暂未开放。</p>
          </div>
        </Card>
        <div className="dashboard-lower">
          <Card
            title="服务器连接"
            description="用户自行管理服务器 · 显式授权连接"
            icon={Server}
            action={
              <Link to="/servers" aria-label="打开服务器">
                <ChevronRight size={18} />
              </Link>
            }
          >
            <div className="list">
              {servers.data?.slice(0, 3).map((r) => (
                <div className="list-item" key={r.id}>
                  <Server size={17} />
                  <div>
                    <strong>{r.name}</strong>
                    <small>
                      {r.host}:{r.port}
                    </small>
                  </div>
                  <Badge>{r.demo ? '演示 · 未连接' : '未知'}</Badge>
                </div>
              ))}
            </div>
            {servers.data?.length === 0 && (
              <p className="callout">
                暂无服务器，凭据加密保存，仅你可以授权连接。
              </p>
            )}
            <Link to="/servers" className="button primary full">
              <Plus size={16} />
              添加服务器
            </Link>
            <p className="location-notice">
              <ShieldCheck size={13} />
              先核验主机指纹，再开启安全终端
            </p>
          </Card>
          <Card
            title="位置中心"
            description="IP 出口策略与地图坐标预设"
            icon={MapPin}
            action={
              <Link to="/locations" aria-label="打开位置中心">
                <ChevronRight size={18} />
              </Link>
            }
          >
            <div className="location-grid">
              <div>
                <small>保存的位置预设</small>
                <strong>{location?.name || '尚未添加'}</strong>
                <div className="pill">
                  <MapPin size={13} />
                  {location?.country || '等待配置'}
                </div>
                <small style={{ display: 'block', marginTop: 12 }}>
                  出口地区
                </small>
                <strong>在节点中选择</strong>
              </div>
              <LocationPreview
                latitude={location?.latitude}
                longitude={location?.longitude}
              />
            </div>
            <Link to="/locations" className="button full">
              管理位置预设
              <ChevronRight size={14} />
            </Link>
            <p className="location-notice">
              <Info size={13} />
              系统 GPS 暂不支持，网页不能修改 iOS 定位
            </p>
          </Card>
          <Card
            title="用户与权限"
            description="独立数据空间与团队协作"
            icon={Users}
            className="permissions-card"
          >
            <div className="seat-content">
              <div
                className="seat-ring"
                style={
                  {
                    '--seats': `${s?.seats ? (s.seats / s.seatLimit) * 100 : 0}%`,
                  } as any
                }
              >
                <div>
                  <strong>
                    {s?.seats ?? '—'}
                    <small> / {s?.seatLimit ?? 20}</small>
                  </strong>
                  <small>受邀席位</small>
                </div>
              </div>
              <div className="seat-details">
                <div className="seat-legend">
                  <span>当前角色</span>
                  <strong>{session.user.role}</strong>
                </div>
                <div className="seat-legend">
                  <span>数据访问</span>
                  <strong>按用户隔离</strong>
                </div>
                <div className="seat-legend">
                  <span>账户状态</span>
                  <Badge>已登录{session.demo ? ' · 演示' : ''}</Badge>
                </div>
              </div>
            </div>
          </Card>
        </div>
        <section className="glass quick-actions">
          <Zap size={24} color="var(--primary)" />
          <div>
            <h2>快捷操作</h2>
            <p>让常用操作，少一步</p>
          </div>
          <Link to="/subscriptions">
            <Link2 size={17} />
            管理订阅
          </Link>
          <Link to="/servers">
            <Server size={17} />
            添加服务器
          </Link>
          <Link to="/codex">
            <Code2 size={17} />
            切换账户
          </Link>
          <Link to="/locations">
            <MapPin size={17} />
            位置预设
          </Link>
        </section>
      </div>
    </>
  );
}
