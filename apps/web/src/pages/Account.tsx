import { useState } from 'react';
import { Link } from 'react-router-dom';
import { UserRound, ShieldCheck, MapPin, Download, LogOut } from 'lucide-react';
import {
  Card,
  PageTitle,
  useData,
  useApp,
  Badge,
  ConfirmDialog,
} from '../../../../packages/ui/src/core';
export function Account() {
  const { session, request, toast, reload } = useApp();
  const devices = useData<any[]>('/api/sessions');
  const [remove, setRemove] = useState(false);
  return (
    <>
      <PageTitle
        title="我的账户"
        description="管理登录设备、个人数据与隐私。"
      />
      <div className="stack">
        <Card title="账户资料" icon={UserRound}>
          <div className="account-heading">
            <div className="avatar">{session.user.name.slice(0, 1)}</div>
            <div>
              <h2>{session.user.name}</h2>
              <p>{session.user.email}</p>
              <Badge>
                {session.user.role}
                {session.demo ? ' · 演示身份' : ''}
              </Badge>
            </div>
          </div>
          <div className="detail-grid">
            <div>
              <small>登录方式</small>
              <p>{session.demo ? '开发专用模拟登录' : 'Google OIDC'}</p>
            </div>
            <div>
              <small>账户标识</small>
              <p className="inline-code">{session.user.id}</p>
            </div>
          </div>
          <div className="actions">
            <Link to="/locations" className="button">
              <MapPin size={15} />
              位置中心
            </Link>
            <button
              onClick={() =>
                request('/api/logout', 'POST')
                  .then(reload)
                  .catch(() => {})
              }
            >
              <LogOut size={15} />
              退出登录
            </button>
          </div>
        </Card>
        <Card
          title="登录设备 / 会话"
          description="会话闲置 30 分钟超时；敏感操作需近期登录"
          icon={ShieldCheck}
        >
          <div className="list">
            {devices.data?.map((s) => (
              <div className="list-item" key={s.id}>
                <div>
                  <strong>
                    {s.id === (session.user as any).session_id
                      ? '当前会话'
                      : '登录会话'}
                  </strong>
                  <small>
                    创建：{new Date(s.created_at).toLocaleString('zh-CN')} ·
                    最近活动：{new Date(s.last_seen_at).toLocaleString('zh-CN')}
                  </small>
                </div>
                <button
                  onClick={() =>
                    request('/api/sessions/' + s.id, 'DELETE')
                      .then(() => {
                        devices.refresh();
                        reload();
                      })
                      .catch(() => {})
                  }
                >
                  撤销
                </button>
              </div>
            ))}
          </div>
        </Card>
        <Card
          title="我的数据"
          description="平台保存必要账户标识与资源配置，秘密不会包含在导出中"
          icon={Download}
        >
          <p>
            业务记录默认保留至主动删除；审计建议保留 90 天，离线备份保留 30
            天。删除请求会登记给管理员，须核验后人工处理。
          </p>
          <div className="actions">
            <button
              onClick={async () => {
                try {
                  const data = await request('/api/data-export');
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(data, null, 2)], {
                      type: 'application/json',
                    }),
                  );
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'fafa-one-my-data.json';
                  a.click();
                  URL.revokeObjectURL(url);
                  toast('已导出个人配置（不含密钥）');
                } catch {
                  /* 错误由统一提示显示 */
                }
              }}
            >
              导出我的数据
            </button>
            <button className="danger" onClick={() => setRemove(true)}>
              提交删除请求
            </button>
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={remove}
        title="提交个人数据删除请求？"
        description="此操作将记录请求，由管理员核验身份并按保留策略处理。不会立即删除数据库。"
        onClose={() => setRemove(false)}
        onConfirm={async () => {
          const r = await request('/api/data-request', 'POST');
          toast(r.message);
        }}
      />
    </>
  );
}
