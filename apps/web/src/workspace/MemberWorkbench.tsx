import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Globe2,
  Code2,
  Server,
  ShieldCheck,
  ArrowUpRight,
  Clock3,
} from 'lucide-react';
import {
  Card,
  Badge,
  PageTitle,
  useData,
  useApp,
  DataState,
} from '../../../../packages/ui/src/core';
import './workspace.css';

const actionNames: Record<string, string> = {
  'session.created': '登录账户',
  'member.password_reset': '重置密码',
  'member.email_verified': '验证邮箱',
  'subscription.rotated': '更新订阅链接',
  'subscription.profile_updated': '调整订阅范围',
};
export function MemberWorkbench() {
  const navigate = useNavigate();
  const { session, request } = useApp();
  const [loggingOut, setLoggingOut] = useState(false);
  const data = useData<any>('/api/workspace');
  const w = data.data;
  return (
    <section className="v3-workspace">
      <PageTitle
        title="我的工作台"
        description="你的节点、AI 账户与服务权限，在这里一目了然。"
        eyebrow="FAFA ONE / WORKSPACE"
      />
      <DataState
        loading={!w && !data.error}
        error={data.error}
        onRetry={data.refresh}
      />
      {w && (
        <>
          <div className="glass v3-welcome">
            <div>
              <span className="v3-eyebrow">WELCOME BACK</span>
              <h2>你好，{w.user.name || session.user.name}</h2>
              <p>从一次安全连接开始，管理属于你的服务。</p>
            </div>
            <div className="v3-welcome-badges">
              <Badge>
                {w.user.role === 'Member' ? '普通用户' : w.user.role}
              </Badge>
              <Badge>
                {w.user.emailVerified ? '邮箱已验证' : '待邮箱验证'}
              </Badge>
              <button
                disabled={loggingOut}
                onClick={() => {
                  setLoggingOut(true);
                  void request('/api/logout', 'POST')
                    .then(() => navigate('/member/login', { replace: true }))
                    .catch(() => setLoggingOut(false));
                }}
              >
                安全退出登录
              </button>
            </div>
          </div>
          <div className="v3-stats">
            {[
              {
                label: '开放展示节点',
                value: w.statistics.visibleNodes,
                icon: Globe2,
              },
              {
                label: '已授权节点',
                value: w.statistics.authorizedNodes,
                icon: ShieldCheck,
              },
              {
                label: '我的 AI 账户',
                value: w.statistics.aiAccounts,
                icon: Code2,
              },
              {
                label: '我的服务器',
                value: w.statistics.servers,
                icon: Server,
              },
            ].map((item) => (
              <div className="glass v3-stat" key={item.label}>
                <item.icon size={20} />
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <div className="v3-bento">
            <Card
              title="节点与订阅"
              description="查看管理员开放的节点，使用已获授权的资源。"
              icon={Globe2}
            >
              <p className="v3-feature-copy">
                {w.capabilities.subscribe
                  ? '订阅权限已开放。每个账户使用独立订阅通道。'
                  : '可以查看开放节点；订阅和使用权限由管理员授权。'}
              </p>
              <Link className="button primary" to="/subscriptions">
                查看开放节点
                <ArrowUpRight size={15} />
              </Link>
              <Link className="button" to="/my-subscriptions">
                我的订阅
              </Link>
            </Card>
            <Card
              title="AI 账户"
              description="个人账户与平台服务分开管理。"
              icon={Code2}
            >
              <p className="v3-feature-copy">
                {w.capabilities.codex
                  ? 'AI 使用权限已开放，连接状态以实际授权结果为准。'
                  : '个人账户连接与平台 AI 服务的使用范围由实际配置和授权决定。'}
              </p>
              <Link className="button" to="/codex">
                管理 AI 账户
                <ArrowUpRight size={15} />
              </Link>
            </Card>
            <Card
              title="账户与安全"
              description="保护登录信息，查看功能授权。"
              icon={ShieldCheck}
            >
              <p className="v3-feature-copy">
                注册不会提升管理角色。管理员授予的服务权限和有效期，可以在账户中查看。
              </p>
              <Link className="button" to="/member/account">
                账户安全
                <ArrowUpRight size={15} />
              </Link>
              <Link className="button" to="/account">
                账户设置
              </Link>
            </Card>
            <Card
              title="近期账户活动"
              description="仅显示你自己的安全记录。"
              icon={Clock3}
            >
              <div className="v3-activity">
                {w.history.length ? (
                  w.history.slice(0, 5).map((item: any) => (
                    <div key={item.id}>
                      <span>{actionNames[item.action] || '账户活动'}</span>
                      <time>
                        {new Date(item.created_at).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </div>
                  ))
                ) : (
                  <p>暂无活动记录</p>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}
