import { consumeActionToken } from './action-token';
import { AuthPolicy } from './AuthPolicy';
import { AuthBrand, AuthLegal, GoogleSignIn, PasswordField } from './AuthUI';
import { CodeRegistration } from './CodeRegistration';
import './member.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';

type Config = {
  csrf: string;
  registrationOpen: boolean;
  mailConfigured: boolean;
};
type Session = { csrf: string; user: { name: string; role: string } };
async function send(
  path: string,
  method = 'GET',
  body?: unknown,
  csrf?: string,
) {
  const response = await fetch(path, {
    method,
    credentials: 'include',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求未能完成，请稍后重试');
  return data;
}
const titles: Record<string, string> = {
  login: '普通账户登录',
  register: '注册普通账户',
  verify: '验证邮箱',
  forgot: '忘记密码',
  reset: '设置新密码',
  resend: '重新发送激活邮件',
};
function CredentialForm({
  mode,
  onAuthenticated,
}: {
  mode: string;
  onAuthenticated?: (session: any) => void;
}) {
  const navigate = useNavigate();
  const [config, setConfig] = useState<Config>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(
    mode === 'login' &&
      new URLSearchParams(window.location.search).get('reset') === 'success'
      ? '密码已重置，请使用新密码登录。'
      : '',
  );
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const action = useRef(consumeActionToken());
  useEffect(() => {
    // Never keep action credentials in browser history, query strings or rendered DOM.
    if (window.location.hash)
      history.replaceState(null, '', window.location.pathname);
    let active = true;
    send('/auth/member/config')
      .then((data) => {
        if (active) setConfig(data);
      })
      .catch(() => {
        if (active) setError('无法加载认证服务，请刷新页面重试');
      });
    return () => {
      active = false;
    };
  }, [mode]);
  const endpoints: Record<string, string> = {
    login: 'login',
    register: 'register',
    verify: 'verify',
    forgot: 'forgot-password',
    reset: 'reset-password',
    resend: 'resend-verification',
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (mode === 'reset' && data.password !== data.confirmPassword) {
      setError('两次输入的密码不一致');
      submitting.current = false;
      setBusy(false);
      return;
    }
    delete data.confirmPassword;
    if (mode === 'login')
      data.remember = data.remember === 'on' ? 'true' : 'false';
    if (mode === 'verify' || mode === 'reset') data.token = action.current;
    try {
      const result = await send(
        '/auth/member/' + endpoints[mode],
        'POST',
        mode === 'login'
          ? { ...data, remember: data.remember === 'true' }
          : data,
        config.csrf,
      );
      form.reset();
      if (mode === 'login') {
        onAuthenticated?.(result);
        navigate('/', { replace: true });
      } else if (mode === 'reset') {
        action.current = '';
        navigate('/member/login?reset=success', { replace: true });
      } else {
        if (mode === 'verify' || mode === 'reset') action.current = '';
        setMessage(result.message);
      }
    } catch (caught) {
      setError(
        caught instanceof Error && caught.name !== 'TimeoutError'
          ? caught.message
          : '请求超时，请确认结果后再试',
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  const needsMail = ['register', 'forgot', 'resend'].includes(mode);
  const unavailable =
    !config ||
    (mode === 'register' && !config.registrationOpen) ||
    (needsMail && !config.mailConfigured);
  return (
    <form className="fields" onSubmit={submit}>
      <h1>{titles[mode]}</h1>
      <p>
        {mode === 'login'
          ? '欢迎回来，登录你的 FAFA ONE 账户。'
          : mode === 'forgot'
            ? '输入注册邮箱，我们会向你发送密码重置链接。'
            : mode === 'reset'
              ? '设置一个安全的新密码，重新开始连接。'
              : '验证本人邮箱，安全地管理你的账户。'}
      </p>
      {config && mode === 'register' && !config.registrationOpen && (
        <p role="status">当前未开放普通用户注册</p>
      )}
      {config && needsMail && !config.mailConfigured && (
        <p role="status">
          邮件服务尚未配置，暂时无法注册或找回密码，请联系管理员。
        </p>
      )}
      {mode === 'register' && (
        <label>
          <span>用户名</span>
          <input
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_]{3,32}"
          />
        </label>
      )}
      {['register', 'forgot', 'resend'].includes(mode) && (
        <label>
          <span>邮箱</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
          />
        </label>
      )}
      {mode === 'login' && (
        <label>
          <span>用户名或邮箱</span>
          <input
            name="identifier"
            autoComplete="username"
            required
            maxLength={254}
          />
        </label>
      )}
      {mode !== 'forgot' && (
        <PasswordField
          label={
            mode === 'reset'
              ? '新密码'
              : mode === 'verify'
                ? '注册时设置的密码'
                : '密码'
          }
          minimum={mode === 'reset' ? 15 : 1}
          autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
        />
      )}
      {mode === 'reset' && (
        <PasswordField
          label="确认新密码"
          name="confirmPassword"
          minimum={15}
          autoComplete="new-password"
        />
      )}
      {mode === 'login' && (
        <div className="auth-options">
          <label className="auth-check">
            <input type="checkbox" name="remember" />
            <span>记住登录状态</span>
          </label>
          <Link to="/member/forgot">忘记密码？</Link>
        </div>
      )}
      {['register', 'reset'].includes(mode) && (
        <small>密码为15至128个字符，可使用空格和中文；请使用独立密码。</small>
      )}
      {mode === 'verify' && (
        <small>
          输入注册时设置的密码可防止他人预先冒用你的邮箱注册；仅打开邮件不会激活账户。
        </small>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button className="primary" disabled={busy || unavailable}>
        {busy
          ? '处理中…'
          : mode === 'login'
            ? '登录'
            : mode === 'forgot'
              ? '发送重置邮件'
              : mode === 'reset'
                ? '设置新密码'
                : mode === 'verify'
                  ? '验证邮箱'
                  : '重新发送激活邮件'}
      </button>
      {mode === 'login' ? (
        <p className="auth-help">
          还没有账户？<Link to="/member/register">立即注册</Link>
        </p>
      ) : (
        <p className="auth-help">
          <Link to="/member/login">返回登录</Link>
          {mode === 'verify' && (
            <Link to="/member/resend">重新发送激活邮件</Link>
          )}
        </p>
      )}
      {mode === 'login' && <GoogleSignIn />}
      <AuthLegal />
    </form>
  );
}
function AccountSecurity() {
  const [session, setSession] = useState<Session>();
  const [profile, setProfile] = useState<any>();
  const [sessions, setSessions] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  async function refresh() {
    const [me, info, active] = await Promise.all([
      send('/api/me'),
      send('/api/member/profile'),
      send('/api/member/sessions'),
    ]);
    setSession(me);
    setProfile(info);
    setSessions(active);
  }
  useEffect(() => {
    refresh().catch(() => setError('请先登录普通账户'));
  }, []);
  async function run(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败，请重试');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="fields">
      <h1>账户安全</h1>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!session ? (
        <Link to="/member/login">前往登录</Link>
      ) : (
        <>
          <p>
            {session.user.name} · {session.user.role}
          </p>
          <p>
            {profile?.emailVerified ? '邮箱已验证' : '通过现有身份提供商登录'} ·{' '}
            {profile?.googleLinked ? 'Google 已绑定' : 'Google 未绑定'}
          </p>

          {profile?.passwordConfigured && (
            <form
              className="fields"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = Object.fromEntries(new FormData(form));
                if (data.newPassword !== data.confirmPassword) {
                  setError('两次输入的密码不一致');
                  return;
                }
                void run(async () => {
                  await send(
                    '/api/member/password',
                    'POST',
                    {
                      currentPassword: data.currentPassword,
                      newPassword: data.newPassword,
                    },
                    session.csrf,
                  );
                  form.reset();
                  window.location.assign('/member/login');
                });
              }}
            >
              <h2>修改密码</h2>
              <label>
                <span>当前密码</span>
                <input
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                />
              </label>
              <label>
                <span>新密码</span>
                <input
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={128}
                />
              </label>
              <label>
                <span>确认新密码</span>
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={15}
                  maxLength={128}
                />
              </label>
              <button disabled={busy}>修改密码并撤销旧会话</button>
            </form>
          )}

          <h2>功能授权</h2>
          {(['node'] as const).map((kind, index) => (
            <p key={kind}>
              {['节点订阅'][index]}：
              {profile?.capabilities?.[kind] ? '已开放' : '未授权或已到期'}
              {profile?.capabilityExpiry?.[kind]
                ? ' · 到期 ' +
                  new Date(profile.capabilityExpiry[kind]).toLocaleString(
                    'zh-CN',
                  )
                : ''}
            </p>
          ))}
          <h2>有效会话</h2>
          {sessions.map((item) => (
            <div className="list-item" key={item.id}>
              <div>
                <strong>{item.current ? '当前会话' : '其他会话'}</strong>
                <small>
                  {new Date(item.created_at).toLocaleString('zh-CN')}
                </small>
              </div>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await send(
                      '/api/member/sessions/' + item.id,
                      'DELETE',
                      undefined,
                      session.csrf,
                    );
                    if (item.current) window.location.assign('/member/login');
                    else await refresh();
                  })
                }
              >
                撤销会话
              </button>
            </div>
          ))}
          {profile?.googleLinkAllowed && (
            <form
              className="fields"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const password = String(
                  new FormData(form).get('password') || '',
                );
                void run(async () => {
                  const result = await send(
                    '/api/member/google/start',
                    'POST',
                    { password },
                    session.csrf,
                  );
                  form.reset();
                  window.location.assign(result.url);
                });
              }}
            >
              <h2>安全绑定 Google</h2>
              <p>
                先验证当前密码，再使用同一已验证邮箱完成正式 Google
                登录；不会按邮箱自动合并账户。
              </p>
              <label>
                <span>当前密码</span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                />
              </label>
              <button disabled={busy}>验证密码并绑定 Google</button>
            </form>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await send('/api/logout', 'POST', undefined, session.csrf);
                window.location.assign('/member/login');
              })
            }
          >
            安全退出登录
          </button>
          <a href="/">返回控制台</a>
        </>
      )}
    </div>
  );
}
export function MemberPortal({
  onAuthenticated,
}: { onAuthenticated?: (session: any) => void } = {}) {
  const location = useLocation();
  return (
    <main className="member-portal">
      <div className="auth-layout">
        <AuthBrand />
        <section className="login-card glass">
          <Routes>
            <Route path="/member/terms" element={<AuthPolicy />} />
            <Route path="/member/privacy" element={<AuthPolicy privacy />} />
            <Route path="/member/register" element={<CodeRegistration />} />
            {Object.keys(titles)
              .filter((mode) => mode !== 'register')
              .map((mode) => (
                <Route
                  key={mode}
                  path={'/member/' + mode}
                  element={
                    <CredentialForm
                      key={location.pathname}
                      mode={mode}
                      onAuthenticated={onAuthenticated}
                    />
                  }
                />
              ))}
            <Route path="/member/account" element={<AccountSecurity />} />
            <Route
              path="*"
              element={
                <CredentialForm
                  mode="login"
                  onAuthenticated={onAuthenticated}
                />
              }
            />
          </Routes>
        </section>
      </div>
    </main>
  );
}
