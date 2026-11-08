import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

type Config = {
  csrf: string;
  registrationOpen: boolean;
  mailConfigured: boolean;
};
async function request(path: string, body?: unknown, csrf?: string) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.message || '请求失败，请稍后重试');
  return data;
}
export function CodeRegistration() {
  const [config, setConfig] = useState<Config>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const challenge = useRef(''),
    pending = useRef(false),
    formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    let active = true;
    request('/auth/member/config')
      .then((d) => {
        if (active) setConfig(d);
      })
      .catch(() => {
        if (active) setError('无法加载认证服务，请刷新页面重试');
      });
    return () => {
      active = false;
    };
  }, []);
  const unavailable =
    !config || !config.registrationOpen || !config.mailConfigured;
  function values() {
    return Object.fromEntries(
      new FormData(formRef.current!).entries(),
    ) as Record<string, string>;
  }
  async function act(kind: 'start' | 'resend' | 'complete') {
    if (!config || pending.current) return;
    const data = values();
    const fields =
      kind === 'start'
        ? ['username', 'email', 'password', 'confirmPassword']
        : kind === 'complete'
          ? ['password', 'code']
          : ['email', 'password'];
    for (const name of fields) {
      const input = formRef.current!.elements.namedItem(
        name,
      ) as HTMLInputElement;
      if (!input.reportValidity()) return;
    }
    if (kind === 'start' && data.password !== data.confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const path =
        kind === 'resend' ? (challenge.current ? 'resend' : 'recover') : kind;
      const body =
        kind === 'start'
          ? {
              username: data.username,
              email: data.email,
              password: data.password,
              confirmPassword: data.confirmPassword,
            }
          : kind === 'complete'
            ? {
                challenge: challenge.current,
                code: data.code,
                password: data.password,
              }
            : challenge.current
              ? { challenge: challenge.current, password: data.password }
              : { email: data.email, password: data.password };
      const result = await request(
        '/auth/member/registration/' + path,
        body,
        config.csrf,
      );
      if (result.challenge) challenge.current = result.challenge;
      if (result.username)
        (
          formRef.current!.elements.namedItem('username') as HTMLInputElement
        ).value = result.username;
      if (kind === 'complete') {
        formRef.current!.reset();
        challenge.current = '';
        window.location.assign('/member/account');
        return;
      }
      setMessage(result.message);
    } catch (caught) {
      setError(
        caught instanceof Error && caught.name !== 'TimeoutError'
          ? caught.message
          : '请求超时，请先确认邮箱和结果再重试',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void act('complete');
  }
  return (
    <form
      className="fields member-registration"
      ref={formRef}
      onSubmit={submit}
    >
      <h1>注册普通账户</h1>
      <p>
        自行设置用户名和密码，验证本人邮箱后进入个人中心。新账户默认为 Member。
      </p>
      {config && !config.registrationOpen && (
        <p role="status">当前未开放普通用户注册</p>
      )}
      {config && !config.mailConfigured && (
        <p role="status">
          邮件服务尚未配置，暂时无法注册或找回密码，请联系管理员。
        </p>
      )}
      <label>
        <span>用户名</span>
        <input
          name="username"
          aria-describedby="member-username-help"
          autoComplete="username"
          required
          minLength={3}
          maxLength={32}
          pattern="[a-zA-Z0-9_]{3,32}"
        />
      </label>
      <small id="member-username-help" className="member-field-hint">
        用户名为3至32位英文字母、数字或下划线，大小写统一处理。
      </small>
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
      <label>
        <span>密码</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={15}
          maxLength={128}
        />
      </label>
      <label>
        <span>确认密码</span>
        <input
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={15}
          maxLength={128}
        />
      </label>
      <small>
        密码为15至128个字符，可包含中文和空格。不要分享验证码或密码。
      </small>
      <div className="member-actions">
        <button
          type="button"
          disabled={busy || unavailable}
          onClick={() => void act('start')}
        >
          发送验证码
        </button>
        <button
          type="button"
          disabled={busy || unavailable}
          onClick={() => void act('resend')}
        >
          重发验证码
        </button>
      </div>
      <label>
        <span>邮箱验证码</span>
        <input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          minLength={6}
          maxLength={6}
          required
          disabled={!challenge.current}
        />
      </label>
      <small>
        验证码10分钟内有效，最多5次尝试。刷新页面后可用原邮箱和注册密码重发。
      </small>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="member-submit">
        <button
          className="primary"
          disabled={busy || unavailable || !challenge.current}
        >
          {busy ? '处理中…' : '确认'}
        </button>
      </div>
      <Link to="/member/login">普通账户登录</Link>
      <Link to="/member/forgot">忘记密码</Link>
      <Link to="/member/resend">重新发送激活邮件</Link>
      <a href="/auth/google">使用 Google 登录</a>
      <a href="/">返回现有控制台</a>
    </form>
  );
}
