import { CodeRegistration } from './CodeRegistration';
import './member.css';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';

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
function CredentialForm({ mode }: { mode: string }) {
  const [config, setConfig] = useState<Config>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const action = useRef(
    new URLSearchParams(window.location.hash.slice(1)).get('token') || '',
  );
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
    if(mode==='reset'&&data.password!==data.confirmPassword){setError('两次输入的密码不一致');submitting.current=false;setBusy(false);return;}
    delete data.confirmPassword;
    if (mode === 'verify' || mode === 'reset') data.token = action.current;
    try {
      const result = await send(
        '/auth/member/' + endpoints[mode],
        'POST',
        data,
        config.csrf,
      );
      form.reset();
      if (mode === 'login') window.location.assign('/member/account');
      else {
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
      <p>新注册账户仅为 Member；管理员和 Owner 权限不会通过注册获得。</p>
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
        <label>
          <span>
            {mode === 'reset'
              ? '新密码'
              : mode === 'verify'
                ? '注册时设置的密码'
                : '密码'}
          </span>
          <input
            name="password"
            type="password"
            autoComplete={
              ['register', 'reset'].includes(mode)
                ? 'new-password'
                : 'current-password'
            }
            required
            minLength={['register', 'reset'].includes(mode) ? 15 : 1}
            maxLength={128}
          />
        </label>
      )}
      {mode==='reset'&&<label><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={128}/></label>}
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
        {busy ? '处理中…' : '确认'}
      </button>
      <Link to="/member/login">普通账户登录</Link>
      <Link to="/member/register">注册普通账户</Link>
      <Link to="/member/forgot">忘记密码</Link>
      <Link to="/member/resend">重新发送激活邮件</Link>
      <a href="/auth/google">使用 Google 登录</a>
      <a href="/">返回现有控制台</a>
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

          {profile?.passwordConfigured&&<form className="fields" onSubmit={event=>{
           event.preventDefault();const form=event.currentTarget;const data=Object.fromEntries(new FormData(form));
           if(data.newPassword!==data.confirmPassword){setError('两次输入的密码不一致');return;}
           void run(async()=>{await send('/api/member/password','POST',{currentPassword:data.currentPassword,newPassword:data.newPassword},session.csrf);form.reset();window.location.assign('/member/login');});
          }}>
           <h2>修改密码</h2>
           <label><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128}/></label>
           <label><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={128}/></label>
           <label><span>确认新密码</span><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={128}/></label>
           <button disabled={busy}>修改密码并撤销旧会话</button>
          </form>}

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
export function MemberPortal() {
  const location = useLocation();
  return (
    <main className="login member-portal">
      <section className="login-card glass">
        <Routes>
          <Route path="/member/register" element={<CodeRegistration />} />
          {Object.keys(titles).filter(mode=>mode!=='register').map((mode) => (
            <Route
              key={mode}
              path={'/member/' + mode}
              element={<CredentialForm key={location.pathname} mode={mode} />}
            />
          ))}
          <Route path="/member/account" element={<AccountSecurity />} />
          <Route path="*" element={<CredentialForm mode="login" />} />
        </Routes>
      </section>
    </main>
  );
}
