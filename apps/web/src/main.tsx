import type { ReactNode } from 'react';
import { MyAiTasks, MyAiQuota } from './pages/PlatformCodex';
import { MySubscriptions } from './workspace/MySubscriptions';
import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';
import {
  LayoutDashboard,
  Globe2,
  Code2,
  Server,
  MapPin,
  UserRound,
  MessageSquare,
  ListTodo,
  Gauge,
  Settings,
} from 'lucide-react';
import {
  Provider,
  Shell,
  Empty,
  Card,
  useApp,
} from '../../../packages/ui/src/core';
import { Dashboard } from './pages/Dashboard';
import { MemberPortal } from './member/MemberPortal';
const GptChat = lazy(() =>
  import('./pages/GptChat').then((m) => ({ default: m.GptChat })),
);
const Subscriptions = lazy(() =>
  import('./pages/Subscriptions').then((m) => ({ default: m.Subscriptions })),
);
const Codex = lazy(() =>
  import('./pages/Codex').then((m) => ({ default: m.Codex })),
);
const Servers = lazy(() =>
  import('./pages/Servers').then((m) => ({ default: m.Servers })),
);
const Locations = lazy(() =>
  import('./pages/Locations').then((m) => ({ default: m.Locations })),
);
const Account = lazy(() =>
  import('./pages/Account').then((m) => ({ default: m.Account })),
);
const nav = [
  { to: '/', label: '仪表盘', icon: LayoutDashboard },
  { to: '/subscriptions', label: '节点订阅', icon: Globe2 },
  { to: '/my-subscriptions', label: '我的订阅', icon: Globe2 },
  { to: '/ai/chat', label: 'GPT 对话', icon: MessageSquare },
  { to: '/codex', label: 'Codex 工作台', icon: Code2 },
  { to: '/ai/tasks', label: '我的任务', icon: ListTodo },
  { to: '/ai/quota', label: '我的额度', icon: Gauge },
  { to: '/servers', label: '服务器', icon: Server },
  { to: '/locations', label: '位置中心', icon: MapPin },
  { to: '/account', label: '我的账户', icon: UserRound },
];
function AdminAiSettings() {
  const { session } = useApp();
  if (!['Owner', 'Admin'].includes(session.user.role))
    return <Empty title="需要管理员权限" />;
  const origin =
    import.meta.env.VITE_ADMIN_ORIGIN?.replace(/\/$/, '') ||
    (window.location.hostname === 'fafa888.uk' ? 'https://a.fafa888.uk' : '');
  return (
    <Card title="管理员设置">
      {origin ? (
        <a className="button primary" href={origin + '/ai/service-accounts'}>
          打开 API 服务账户与模型管理
        </a>
      ) : (
        <p>请使用当前预览环境的管理后台地址。</p>
      )}
    </Card>
  );
}

function WorkspaceShell({ children }: { children: ReactNode }) {
  const { session } = useApp();
  const items = ['Owner', 'Admin'].includes(session.user.role)
    ? [...nav, { to: '/ai/settings', label: '管理员设置', icon: Settings }]
    : nav;
  return (
    <Shell nav={items} bottom={[nav[0], nav[1], nav[3], nav[4], nav.at(-1)!]}>
      {children}
    </Shell>
  );
}

function WebApplication() {
  const location = useLocation();
  return location.pathname.startsWith('/member/') ? (
    <MemberPortal />
  ) : (
    <Provider
      loginPage={(onLogin) => <MemberPortal onAuthenticated={onLogin} />}
    >
      <WorkspaceShell>
        <Suspense
          fallback={<div className="skeleton" aria-label="正在加载页面" />}
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/my-subscriptions" element={<MySubscriptions />} />
            <Route path="/codex" element={<Codex />} />
            <Route path="/ai/chat" element={<GptChat />} />
            <Route path="/ai/tasks" element={<MyAiTasks />} />
            <Route path="/ai/quota" element={<MyAiQuota />} />
            <Route path="/ai/settings" element={<AdminAiSettings />} />
            <Route path="/servers" element={<Servers />} />
            <Route path="/locations" element={<Locations />} />
            <Route path="/account" element={<Account />} />
            <Route
              path="*"
              element={
                <Empty
                  title="页面不存在"
                  action={<Link to="/">返回仪表盘</Link>}
                />
              }
            />
          </Routes>
        </Suspense>
      </WorkspaceShell>
    </Provider>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <WebApplication />
  </BrowserRouter>,
);
