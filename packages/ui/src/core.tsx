import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useId,
  type ReactNode,
  type FormEvent,
} from 'react';
import { NavLink, Link, useNavigate } from 'react-router-dom';
import {
  Search,
  Bell,
  Sun,
  Moon,
  Menu,
  LogOut,
  ChevronRight,
  ShieldCheck,
  X,
  Plus,
  ArrowUpRight,
  LoaderCircle,
  MapPin,
} from 'lucide-react';
import type { User } from '../../shared/src';
import './style.css';
import { backendUrl } from './endpoints';
export type Row = { id: string; [key: string]: any };
type Session = { user: User; csrf: string; demo: boolean };
const Context = createContext<{
  session: Session;
  request: <T = any>(
    path: string,
    method?: string,
    body?: unknown,
  ) => Promise<T>;
  toast: (s: string) => void;
  reload: () => void;
}>(null!);
export const useApp = () => useContext(Context);
export async function api<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(backendUrl(path), {
      method,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf && unsafe ? { 'x-csrf-token': csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || '请求失败，请稍后重试');
    return data;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error('请求超时，请刷新确认操作结果后再重试', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
export function Provider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api<Session>('/api/me')
      .then(setSession)
      .catch(() => setSession(null));
  }, [version]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(id);
  }, [toast]);
  if (session === undefined)
    return (
      <div className="loading" aria-label="正在加载">
        <LoaderCircle className="spin" />
        <div className="skeleton" />
      </div>
    );
  if (!session) return <Login onLogin={setSession} />;
  const request = async <T,>(path: string, method = 'GET', body?: unknown) => {
    try {
      return await api<T>(path, method, body, session.csrf);
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      throw e;
    }
  };
  return (
    <Context.Provider
      value={{
        session,
        request,
        toast: setToast,
        reload: () => setVersion((v) => v + 1),
      }}
    >
      {children}
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={18} />
          {toast}
        </div>
      )}
      {error && (
        <div className="toast error" role="alert">
          {error}
          <button aria-label="关闭错误" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [config, setConfig] = useState<any>();
  const [ownerCredential, setOwnerCredential] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api('/auth/config')
      .then(setConfig)
      .catch(() => setError('无法连接 API，请确认服务已启动'));
  }, []);
  return (
    <main className="login">
      <div className="glass login-card">
        <Brand />
        <span className="eyebrow">YOUR PERSONAL CONTROL PLANE</span>
        <h1>
          一处连接，
          <br />
          从容掌控。
        </h1>
        <p>
          节点订阅、Codex 工作台与服务器，
          <br />
          在你的安全空间内井然有序。
        </p>
        <a
          className="button primary"
          href={backendUrl('/auth/google')}
          aria-disabled={!config?.google}
          onClick={(e) => {
            if (!config?.google) e.preventDefault();
          }}
        >
          G · 使用 Google 登录
        </a>
        {!config?.google && (
          <p className="muted">Google 登录未配置 · 仅受邀账号可激活</p>
        )}
        {config?.ownerSetup && (
          <details>
            <summary>首次 Owner 初始化</summary>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const credential = ownerCredential;
                setOwnerCredential('');
                try {
                  const result = await api<{ url: string }>(
                    '/auth/owner/start',
                    'POST',
                    { credential },
                  );
                  window.location.assign(result.url);
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              <label>
                服务器一次性授权凭据
                <input
                  type="password"
                  value={ownerCredential}
                  onChange={(event) => setOwnerCredential(event.target.value)}
                  autoComplete="off"
                  required
                  maxLength={100}
                />
              </label>
              <p>
                凭据由服务器交互终端生成，输入后使用正式 Google 登录完成绑定。
              </p>
              <button className="primary">
                授权并使用 Google 初始化 Owner
              </button>
            </form>
          </details>
        )}
        {config?.mock && (
          <div className="dev-login">
            <Badge>开发专用 · 演示数据</Badge>
            <p>体验独立角色，默认不调用任何外部服务。</p>
            {(['owner', 'member', 'viewer'] as const).map((profile, i) => (
              <button
                key={profile}
                onClick={() =>
                  api<Session>('/auth/dev', 'POST', { profile })
                    .then(onLogin)
                    .catch((e) => setError(e.message))
                }
              >
                {['管理员演示', '成员演示', '访客演示'][i]}
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        <small>不会收集 ChatGPT Cookies 或 CLI 凭据</small>
      </div>
    </main>
  );
}
export function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-icon">F</span>
      <span>
        <strong>FAFA ONE</strong>
        <small>统一控制面板</small>
      </span>
    </Link>
  );
}
export type Navigation = { to: string; label: string; icon: any };
export function Shell({
  nav,
  bottom,
  children,
  admin = false,
}: {
  nav: Navigation[];
  bottom: Navigation[];
  children: ReactNode;
  admin?: boolean;
}) {
  const { session, request, toast, reload } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(
    () => localStorage.getItem('fafa_theme') === 'dark',
  );
  const [command, setCommand] = useState(false);
  const [notice, setNotice] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('fafa_theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  return (
    <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <Brand />
        <span className="nav-caption">
          {admin ? 'ADMINISTRATION' : 'WORKSPACE'}
        </span>
        <nav>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}>
              <n.icon size={21} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom glass">
          <ShieldCheck />
          <strong>私有空间，安心连接</strong>
          <small>用户数据与凭据独立隔离</small>
          <Badge>
            {session.demo ? '开发环境 · 演示数据' : '真实模式 · 按权限访问'}
          </Badge>
        </div>
        <div className="sidebar-foot">
          <strong>FAFA ONE</strong>
          <small>简洁 · 高效 · 一体化</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button desktop"
            aria-label="折叠导航"
            onClick={() => setCollapsed((v) => !v)}
          >
            <Menu size={20} />
          </button>
          <div className="mobile-brand">
            <Brand />
          </div>
          <button
            aria-label="搜索功能、节点、服务器… ⌘ K"
            aria-keyshortcuts="Control+K Meta+K"
            className="search"
            onClick={() => setCommand(true)}
          >
            <Search size={18} />
            <span>搜索功能、节点、服务器…</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="top-actions">
            <button
              className="icon-button"
              aria-label="通知"
              onClick={() => setNotice(true)}
            >
              <Bell size={21} />
            </button>
            <button
              className="icon-button"
              aria-label="切换主题"
              onClick={() => setDark((v) => !v)}
            >
              {dark ? <Sun size={21} /> : <Moon size={21} />}
            </button>
            <Link
              className="avatar"
              to={admin ? '/' : '/account'}
              aria-label="我的账户"
            >
              {session.user.name.slice(0, 1)}
            </Link>
            <span className="profile-name">{session.user.name}</span>
            <button
              className="icon-button desktop"
              aria-label="退出登录"
              onClick={() =>
                request('/api/logout', 'POST')
                  .then(reload)
                  .catch(() => {})
              }
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>
        <main className="page">
          {session.demo && (
            <div className="environment-banner">
              <span className="status-dot" />
              演示环境 · 样例均已标注，不连接外部代理、SSH 或 AI 服务
            </div>
          )}
          {children}
        </main>
        <footer className="page-footer">
          FAFA ONE <span>私有控制空间 · {admin ? '管理端' : '用户端'}</span>
          <span>连接有边界，数据有归属。</span>
        </footer>
      </div>
      <nav className="bottom-nav glass" aria-label="手机导航">
        {bottom.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}>
            <n.icon size={22} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
      <Dialog open={command} onClose={() => setCommand(false)} title="快速前往">
        <CommandSearch
          nav={nav}
          onGo={(to) => {
            navigate(to);
            setCommand(false);
          }}
        />
      </Dialog>
      <Dialog open={notice} onClose={() => setNotice(false)} title="通知中心">
        <Empty
          title="暂无系统通知"
          description="订阅刷新记录可在节点订阅页面查看。"
        />
        <button
          onClick={() => {
            toast('已查看通知');
            setNotice(false);
          }}
        >
          完成
        </button>
      </Dialog>
    </div>
  );
}
function CommandSearch({
  nav,
  onGo,
}: {
  nav: Navigation[];
  onGo: (to: string) => void;
}) {
  const [q, setQ] = useState('');
  return (
    <>
      <input
        autoFocus
        placeholder="搜索页面名称"
        aria-label="搜索页面名称"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="command-list">
        {nav
          .filter((n) => n.label.toLowerCase().includes(q.toLowerCase()))
          .map((n) => (
            <button key={n.to} onClick={() => onGo(n.to)}>
              <n.icon size={20} />
              {n.label}
              <ChevronRight size={16} />
            </button>
          ))}
      </div>
    </>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow || 'FAFA ONE / WORKSPACE'}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Card({
  title,
  description,
  icon: Icon,
  children,
  action,
  className = '',
}: {
  title: string;
  description?: string;
  icon?: any;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { session } = useApp();
  return (
    <section className={`glass card ${className}`} aria-label={title}>
      <div className="card-heading">
        {Icon && (
          <span className="card-icon">
            <Icon size={25} />
          </span>
        )}
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <div className="card-action">
          {session.demo && <Badge>演示数据</Badge>}
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}
export function Empty({
  title = '暂无数据',
  description = '添加配置后将在这里显示。',
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Plus size={26} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-content">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button
            aria-label="关闭弹窗"
            className="icon-button"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  placeholder?: string;
  value?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: string;
};
export function FormDialog({
  open,
  onClose,
  title,
  fields,
  onSubmit,
  notice,
  submitLabel = '保存',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: Field[];
  onSubmit: (data: any) => Promise<void>;
  notice?: string;
  submitLabel?: string;
}) {
  const fieldPrefix = useId();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) setError('');
  }, [open]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const form = new FormData(e.currentTarget);
    const data: Record<string, unknown> = {};
    fields.forEach((f) => {
      const value = form.get(f.name);
      if (f.type === 'checkbox') data[f.name] = value === 'on';
      else if (f.type === 'number') data[f.name] = Number(value);
      else if (value !== null && value !== '') data[f.name] = value;
    });
    setBusy(true);
    setError('');
    try {
      await onSubmit(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {open && (
        <form onSubmit={submit}>
          {notice && <p className="callout">{notice}</p>}
          <div className="fields">
            {fields.map((f) => (
              <label
                key={f.name}
                className={f.type === 'checkbox' ? 'checkbox-label' : ''}
              >
                <span>
                  {f.label}
                  {f.required ? ' *' : ''}
                </span>
                {f.options ? (
                  <select
                    aria-label={f.label}
                    aria-describedby={
                      f.help ? fieldPrefix + '-' + f.name + '-help' : undefined
                    }
                    name={f.name}
                    defaultValue={f.value}
                    required={f.required}
                  >
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'textarea' ? (
                  <textarea
                    aria-label={f.label}
                    aria-describedby={
                      f.help ? fieldPrefix + '-' + f.name + '-help' : undefined
                    }
                    name={f.name}
                    defaultValue={f.value}
                    required={f.required}
                    placeholder={f.placeholder}
                    rows={5}
                  />
                ) : (
                  <input
                    aria-label={f.label}
                    aria-describedby={
                      f.help ? fieldPrefix + '-' + f.name + '-help' : undefined
                    }
                    name={f.name}
                    type={f.type || 'text'}
                    defaultValue={f.type === 'checkbox' ? undefined : f.value}
                    defaultChecked={
                      f.type === 'checkbox'
                        ? String(f.value) === 'true'
                        : undefined
                    }
                    required={f.required}
                    placeholder={f.placeholder}
                    min={f.min}
                    max={f.max}
                    step={f.step}
                    autoComplete={
                      f.type === 'password' ? 'new-password' : 'off'
                    }
                  />
                )}
                <small id={fieldPrefix + '-' + f.name + '-help'}>
                  {f.help}
                </small>
              </label>
            ))}
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-footer">
            <button type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : null}
              {submitLabel}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
export function ConfirmDialog({
  open,
  title,
  description,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <p>{description}</p>
      <div className="dialog-footer">
        <button onClick={onClose}>取消</button>
        <button
          className="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch {
              /* 错误由统一提示显示 */
            } finally {
              setBusy(false);
            }
          }}
        >
          确认操作
        </button>
      </div>
    </Dialog>
  );
}
export function useData<T = any>(url: string) {
  const { request } = useApp();
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    request<T>(url)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [url, version]);
  return { data, error, refresh: () => setVersion((v) => v + 1) };
}
export function DataState({
  error,
  loading,
  onRetry,
}: {
  error: string;
  loading: boolean;
  onRetry: () => void;
}) {
  if (error)
    return (
      <div className="callout" role="alert">
        {error}
        <button onClick={onRetry}>重试</button>
      </div>
    );
  if (loading) return <div className="skeleton" aria-label="正在加载数据" />;
  return null;
}
export function LocationPreview({
  latitude = 35.6762,
  longitude = 139.6503,
}: {
  latitude?: number;
  longitude?: number;
}) {
  return (
    <div
      className="map-preview"
      role="img"
      aria-label={`坐标示意图：${latitude}, ${longitude}，不是实时地图`}
    >
      <div className="map-river" />
      {[1, 2, 3, 4, 5].map((i) => (
        <i
          key={i}
          style={{
            left: i * 18 + '%',
            transform: `rotate(${i % 2 ? 35 : -25}deg)`,
          }}
        />
      ))}
      <MapPin size={46} fill="var(--primary)" color="white" />
      <span>
        {latitude.toFixed(4)}° / {longitude.toFixed(4)}° · 坐标示意
      </span>
    </div>
  );
}
