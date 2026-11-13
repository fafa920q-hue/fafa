import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, ShieldCheck, LockKeyhole, Globe2 } from 'lucide-react';

export function AuthBrand() {
  return (
    <aside className="auth-brand">
      <a className="auth-wordmark" href="/" aria-label="FAFA ONE 首页">
        <span className="auth-logo">F</span>
        <span>
          FAFA ONE<small>统一控制面板</small>
        </span>
      </a>
      <div className="auth-brand-copy">
        <span className="auth-eyebrow">YOUR PERSONAL WORKSPACE</span>
        <h2>
          一处连接，
          <br />
          从容掌控。
        </h2>
        <p>
          节点订阅 · AI 账户 · 服务器管理
          <br />
          让每一次连接，更简单一些。
        </p>
      </div>
      <div className="auth-brand-orbit" aria-hidden="true">
        <span>F</span>
        <i />
        <i />
        <i />
      </div>
      <div className="auth-trust">
        <span>
          <ShieldCheck size={14} />
          安全连接
        </span>
        <span>
          <LockKeyhole size={14} />
          隐私保护
        </span>
        <span>
          <Globe2 size={14} />
          多端访问
        </span>
      </div>
    </aside>
  );
}
export function PasswordField({
  label = '密码',
  name = 'password',
  minimum = 1,
  autoComplete = 'current-password',
}: {
  label?: string;
  name?: string;
  minimum?: number;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          minLength={minimum}
          maxLength={128}
        />
        <button
          type="button"
          className="auth-eye"
          aria-label={(visible ? '隐藏' : '显示') + label}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>
    </div>
  );
}
export function AuthLegal() {
  return (
    <div className="auth-legal">
      <Link to="/member/terms">用户协议</Link>
      <span>·</span>
      <Link to="/member/privacy">隐私政策</Link>
    </div>
  );
}
export function GoogleSignIn() {
  return (
    <>
      <div className="auth-divider">
        <span>其他登录方式</span>
      </div>
      <a className="auth-google" href="/auth/google">
        <span className="auth-google-mark" aria-hidden="true">
          G
        </span>
        使用 Google 登录
      </a>
    </>
  );
}
export function AuthHelp({ children }: { children: ReactNode }) {
  return <p className="auth-help">{children}</p>;
}
