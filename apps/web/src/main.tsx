import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import {
  LayoutDashboard,
  Globe2,
  Code2,
  Server,
  MapPin,
  UserRound,
} from 'lucide-react';
import { Provider, Shell, Empty } from '../../../packages/ui/src/core';
import { Dashboard } from './pages/Dashboard';
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
  { to: '/codex', label: 'Codex', icon: Code2 },
  { to: '/servers', label: '服务器', icon: Server },
  { to: '/locations', label: '位置中心', icon: MapPin },
  { to: '/account', label: '我的账户', icon: UserRound },
];
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Provider>
      <Shell nav={nav} bottom={[nav[0], nav[1], nav[2], nav[3], nav[5]]}>
        <Suspense
          fallback={<div className="skeleton" aria-label="正在加载页面" />}
        >
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/subscriptions" element={<Subscriptions />} />
            <Route path="/codex" element={<Codex />} />
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
      </Shell>
    </Provider>
  </BrowserRouter>,
);
