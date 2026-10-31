import {
  FormEvent,
  ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleStop,
  Home,
  KeyRound,
  LogOut,
  MessageSquare,
  Moon,
  Network,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { api, chatStream } from "./api";

const RichMessage = lazy(() => import("./RichMessage"));
function readAuthLink() {
  const match = /^#(verify|reset)=([a-zA-Z0-9_-]{20,200})$/.exec(location.hash);
  return match ? { kind: match[1], token: match[2] } : null;
}

type User = {
  id: number;
  email: string;
  display_name: string;
  role: string;
  modules: string[];
};
type Connection = {
  id: number;
  name: string;
  provider: string;
  is_default: boolean;
  status: string;
  budget_cents: number;
  models: string[];
  revoked_at: number | null;
};
type Session = { id: string; title: string; updated_at: number };
type Run = {
  id: string;
  status: string;
  connection_id: number;
  model_id: string;
  error: string | null;
  cost_cents: number | null;
};
type Message = { id: number; role: string; content: string };
type Conversation = Session & {
  messages: Message[];
  runs: Run[];
  has_older: boolean;
};
type Price = {
  id: string;
  provider: string;
  input_cents_per_million: number | null;
  output_cents_per_million: number | null;
};
type Page = "home" | "ai" | "nodes" | "account";
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请稍后重试";
const providers: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};
const statusName: Record<string, string> = {
  ready: "模型查询已通过",
  untested: "待检测",
  check_failed: "检测失败",
  revoked: "已撤销",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "连接中断",
  cancelled: "已停止",
  running: "正在执行",
  pending: "准备中",
  cancel_requested: "正在停止",
};
const nav: { id: Page; label: string; icon: typeof Home }[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "ai", label: "AI", icon: MessageSquare },
  { id: "nodes", label: "节点", icon: Network },
  { id: "account", label: "我的", icon: Settings2 },
];

function Button({
  children,
  onClick,
  disabled,
  kind = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={"button " + kind}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Notice({
  children,
  danger = false,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      className={"notice " + (danger ? "danger" : "")}
      role={danger ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const active = document.activeElement as HTMLElement;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      active?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose} aria-label={title}>
      <div className="dialog-title">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ThemeToggle() {
  const [dark, setDark] = useState(
    () => localStorage.getItem("fafa-theme") !== "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("fafa-theme", dark ? "dark" : "light");
  }, [dark]);
  return (
    <button
      className="icon-button"
      onClick={() => setDark(!dark)}
      aria-label="切换主题"
    >
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}
function useViewport() {
  useEffect(() => {
    const resize = () => {
      const v = window.visualViewport;
      document.documentElement.style.setProperty(
        "--viewport-height",
        `${v?.height ?? window.innerHeight}px`,
      );
    };
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    window.addEventListener("resize", resize);
    return () => {
      window.visualViewport?.removeEventListener("resize", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
}
export default function App() {
  useViewport();
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState("");
  const readPage = (): Page => {
    const p = location.hash.slice(1).split("/")[0];
    return nav.some((n) => n.id === p) ? (p as Page) : "home";
  };
  const [page, setPage] = useState<Page>(readPage);
  const [authLink, setAuthLink] = useState(readAuthLink);
  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError("");
    api<User>("/auth/me")
      .then(setUser)
      .catch((e) => {
        if (e.status === 401) setUser(null);
        else setLoadError(errorText(e));
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    refresh();
    const expired = () => setUser(null);
    const route = () => {
      setPage(readPage());
      setAuthLink(readAuthLink());
    };
    window.addEventListener("hashchange", route);
    window.addEventListener("session-expired", expired);
    return () => {
      window.removeEventListener("hashchange", route);
      window.removeEventListener("session-expired", expired);
    };
  }, [refresh]);
  const go = (p: Page) => {
    location.hash = p;
  };
  if (authLink)
    return (
      <Recovery
        link={authLink}
        onDone={() => {
          setAuthLink(null);
          location.hash = "home";
          refresh();
        }}
      />
    );
  if (loading)
    return (
      <main className="center" aria-busy="true">
        正在连接 FAFA ONE…
      </main>
    );
  if (loadError)
    return (
      <main className="center">
        <Notice danger>{loadError}</Notice>
        <Button onClick={refresh}>重试</Button>
      </main>
    );
  if (!user) return <Auth onComplete={refresh} />;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="#home" className="brand">
          <span className="brand-mark">F</span> FAFA <b>ONE</b>
        </a>
        <span className="workspace-label">个人工作空间</span>
        <nav aria-label="主导航">
          {nav.map((n) => (
            <a
              href={"#" + n.id}
              key={n.id}
              className={page === n.id ? "selected" : ""}
              aria-current={page === n.id ? "page" : undefined}
            >
              <n.icon size={19} />
              {n.id === "ai" ? "AI 中心" : n.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">{user.display_name.slice(0, 1)}</span>
          <div>
            <strong>{user.display_name}</strong>
            <small>个人账户</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span className="mobile-brand">FAFA ONE</span>
          <span className="breadcrumb">
            工作空间 <ChevronRight size={14} />{" "}
            {nav.find((n) => n.id === page)?.label}
          </span>
          <div className="top-actions">
            <span className="alpha-badge">Alpha · 未生产发布</span>
            <ThemeToggle />
          </div>
        </header>
        <main className={"content " + (page === "ai" ? "chat-page" : "")}>
          {page === "home" ? (
            <Overview user={user} go={go} />
          ) : page === "ai" ? (
            <Chat />
          ) : page === "nodes" ? (
            <Nodes user={user} />
          ) : (
            <Accounts user={user} onLogout={() => setUser(null)} />
          )}
        </main>
        <nav className="bottom-nav" aria-label="移动导航">
          {nav.map((n) => (
            <a
              href={"#" + n.id}
              key={n.id}
              aria-current={page === n.id ? "page" : undefined}
            >
              <n.icon size={21} />
              <span>{n.label}</span>
            </a>
          ))}
        </nav>
      </div>
    </div>
  );
}
function Recovery({
  link,
  onDone,
}: {
  link: { kind: string; token: string };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false);
  useEffect(() => {
    history.replaceState(
      null,
      "",
      location.pathname + location.search + "#home",
    );
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const password = new FormData(e.currentTarget).get("password");
    try {
      await api(
        link.kind === "verify"
          ? "/auth/verification/confirm"
          : "/auth/password/reset",
        "POST",
        { token: link.token, ...(link.kind === "reset" ? { password } : {}) },
      );
      setComplete(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1>
          {complete
            ? "验证完成"
            : link.kind === "verify"
              ? "验证邮箱"
              : "设置新密码"}
        </h1>
        {error && <Notice danger>{error}</Notice>}
        {complete ? (
          <Button onClick={onDone}>返回登录</Button>
        ) : (
          <form onSubmit={submit}>
            {link.kind === "reset" && (
              <label>
                新密码
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  required
                  autoComplete="new-password"
                />
              </label>
            )}
            <Button type="submit" kind="primary full" disabled={busy}>
              {busy ? "正在验证…" : "确认"}
            </Button>
            <Button onClick={onDone}>返回</Button>
          </form>
        )}
      </div>
    </main>
  );
}
function Auth({ onComplete }: { onComplete: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "reset" | "verify">(
      "login",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [caps, setCaps] = useState<{ google: string; email: string } | null>(
    null,
  );
  useEffect(() => {
    api<{ google: string; email: string }>("/auth/capabilities")
      .then(setCaps)
      .catch(() => setCaps(null));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === "reset" || mode === "verify") {
        await api(
          mode === "reset"
            ? "/auth/password/request"
            : "/auth/verification/request",
          "POST",
          { email: data.email },
        );
        setNotice("如果该账户符合条件，验证邮件将发往此邮箱。");
      } else if (mode === "register") {
        const r = await api<{ email_delivery: string }>(
          "/auth/register",
          "POST",
          data,
        );
        setNotice(
          r.email_delivery === "sent"
            ? "注册成功，请通过邮件完成验证后登录。"
            : "注册成功。邮件服务尚未接通；本地环境可登录，生产验证仍未完成。",
        );
        setMode("login");
      } else {
        await api("/auth/login", "POST", data);
        onComplete();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-card">
        <a href="#home" className="brand">
          <span className="brand-mark">F</span> FAFA <b>ONE</b>
        </a>
        <h1>
          {mode === "login"
            ? "回到你的工作空间"
            : mode === "register"
              ? "创建 FAFA 账户"
              : mode === "reset"
                ? "找回密码"
                : "验证你的邮箱"}
        </h1>
        <p className="muted">连接你的 AI，继续每一次探索。</p>
        {error && <Notice danger>{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              昵称
              <input
                name="display_name"
                required
                maxLength={80}
                autoComplete="nickname"
              />
            </label>
          )}
          <label>
            邮箱
            <input name="email" type="email" required autoComplete="email" />
          </label>
          {(mode === "login" || mode === "register") && (
            <label>
              密码
              <input
                name="password"
                type="password"
                required
                minLength={mode === "register" ? 12 : 1}
                maxLength={128}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
              />
            </label>
          )}
          <Button type="submit" kind="primary full" disabled={busy}>
            {busy
              ? "正在处理…"
              : mode === "login"
                ? "登录"
                : mode === "register"
                  ? "注册"
                  : "发送邮件"}
          </Button>
        </form>
        {caps?.google === "configured" && (
          <a className="button full" href="/api/v1/auth/google/start">
            使用 Google 登录
          </a>
        )}
        <div className="auth-links">
          <Button
            onClick={() => {
              setMode(mode === "register" ? "login" : "register");
              setError("");
            }}
          >
            {mode === "register" ? "返回登录" : "注册账户"}
          </Button>
          <Button onClick={() => setMode("reset")}>找回密码</Button>
          <Button onClick={() => setMode("verify")}>邮箱验证</Button>
        </div>
        <p className="fine">
          Google、微信、QQ
          仅在合法凭据配置并验证后启用。当前为尚未生产验收的候选版本。
        </p>
      </div>
      <ThemeToggle />
    </main>
  );
}
function Overview({ user, go }: { user: User; go: (p: Page) => void }) {
  const [counts, setCounts] = useState<{
      connections: number;
      sessions: number;
    } | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      api<{ connections: Connection[] }>("/v2/connections"),
      api<{ sessions: Session[] }>("/v2/sessions"),
    ])
      .then(([c, s]) =>
        setCounts({
          connections: c.connections.length,
          sessions: s.sessions.length,
        }),
      )
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <div className="page">
      <div className="eyebrow">YOUR CONNECTED WORKSPACE</div>
      <h1>你好，{user.display_name}。</h1>
      <p className="lead">从一个问题，到下一个想法。</p>
      <section className="hero">
        <div className="hero-symbol">
          <MessageSquare size={28} />
        </div>
        <h2>让你的 AI 连接起来</h2>
        <p>
          用自己的官方 API 连接开启对话。账户、历史和预算都在同一个工作空间。
        </p>
        <Button kind="primary" onClick={() => go("ai")}>
          进入 AI 中心 <ChevronRight size={16} />
        </Button>
      </section>
      {error && <Notice danger>{error}</Notice>}
      <div className="metrics">
        <div>
          <small>个人 AI 连接</small>
          <strong>{counts?.connections ?? "—"}</strong>
        </div>
        <div>
          <small>最近会话（最多 30 条）</small>
          <strong>{counts?.sessions ?? "—"}</strong>
        </div>
        <div>
          <small>工作空间归属</small>
          <strong className="metric-text">仅你可访问</strong>
        </div>
      </div>
      <section className="section">
        <h2>开始工作</h2>
        <button className="action-row" onClick={() => go("account")}>
          <KeyRound size={21} />
          <span>
            <b>管理我的 AI 账户</b>
            <small>添加连接、设置默认账户和月度成本上限</small>
          </span>
          <ChevronRight size={18} />
        </button>
        <button className="action-row" onClick={() => go("nodes")}>
          <Network size={21} />
          <span>
            <b>查看已授权节点</b>
            <small>显示服务端已有的检测结果，不推算代理流量</small>
          </span>
          <ChevronRight size={18} />
        </button>
      </section>
      <Notice>
        当前交付范围为个人 API 连接和会话核心。CLI
        Agent、订阅迁移、开源发现与技术学院尚未启用，完整平台未达到发布条件。
      </Notice>
    </div>
  );
}
function Accounts({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [rows, setRows] = useState<Connection[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState<Connection | null>(null);
  const [usage, setUsage] = useState<{
    personal_api: {
      cost_cents_known: number;
      cost_cents_reserved: number;
      requests: number;
    };
  } | null>(null);
  const load = useCallback(async () => {
    const [c, u] = await Promise.all([
      api<{ connections: Connection[] }>("/v2/connections"),
      api<{
        personal_api: {
          cost_cents_known: number;
          cost_cents_reserved: number;
          requests: number;
        };
      }>("/v2/usage"),
    ]);
    setRows(c.connections);
    setUsage(u);
  }, []);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);
  async function action(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await load();
      setNotice(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = Object.fromEntries(new FormData(form));
    await action(async () => {
      if (edit)
        await api("/v2/connections/" + edit.id, "PATCH", {
          name: data.name,
          budget_cents: Math.round(Number(data.budget) * 100),
        });
      else
        await api("/v2/connections", "POST", {
          name: data.name,
          provider: data.provider,
          api_key: data.api_key,
          budget_cents: Math.round(Number(data.budget) * 100),
        });
      form.reset();
      setAdding(false);
      setEdit(null);
    }, "连接已保存。请先检测连接，再选择可用模型。");
  }
  return (
    <div className="page">
      <div className="eyebrow">PERSONAL SPACE</div>
      <div className="page-heading">
        <div>
          <h1>我的 AI 账户</h1>
          <p className="muted">你的连接，只用于你的工作空间。</p>
        </div>
        <Button kind="primary" onClick={() => setAdding(true)}>
          <Plus size={17} />
          添加连接
        </Button>
      </div>
      {error && <Notice danger>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      <div className="security-note">
        <ShieldCheck size={20} />
        <p>
          平台登录、个人 API、设备端 CLI
          和平台授权服务分别管理。个人密钥在服务端加密保存，界面不提供密钥回读。
        </p>
      </div>
      <section className="section">
        <div className="section-heading">
          <h2>个人 API 连接</h2>
          <Button onClick={() => action(load, "状态已刷新")} disabled={busy}>
            刷新
          </Button>
        </div>
        {!rows.length ? (
          <div className="empty">
            <KeyRound size={30} />
            <h3>添加你的第一个 AI 连接</h3>
            <p>
              支持 OpenAI、Anthropic 和 Google 官方 API。消费者订阅不等同于 API
              额度。
            </p>
          </div>
        ) : (
          rows.map((c) => (
            <article className="connection-row" key={c.id}>
              <div className="provider-mark">
                {providers[c.provider]?.slice(0, 1)}
              </div>
              <div className="connection-info">
                <h3>
                  {c.name} {c.is_default && <span className="pill">默认</span>}
                </h3>
                <p>
                  {providers[c.provider]} · {statusName[c.status] ?? c.status}
                </p>
                <small>
                  月度成本上限 ${(c.budget_cents / 100).toFixed(2)} ·
                  供应商余额未知
                </small>
              </div>
              <div className="row-actions">
                {!c.revoked_at && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          const result = await api<{ error: string | null }>(
                            "/v2/connections/" + c.id + "/test",
                            "POST",
                          );
                          if (result.error) throw new Error(result.error);
                        }, "已通过官方模型查询。生成能力仍需实际对话验证。")
                      }
                    >
                      检测
                    </Button>
                    <Button
                      disabled={busy || c.is_default}
                      onClick={() =>
                        action(
                          () =>
                            api("/v2/connections/" + c.id + "/default", "POST"),
                          "已设为默认。正在运行的任务不受影响。",
                        )
                      }
                    >
                      设为默认
                    </Button>
                    <Button disabled={busy} onClick={() => setEdit(c)}>
                      设置
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "撤销后 FAFA 无法继续使用此连接。仍需前往供应商撤销 API Key。",
                          )
                        )
                          action(
                            () =>
                              api(
                                "/v2/connections/" + c.id + "/revoke",
                                "POST",
                              ),
                            "已撤销 FAFA 访问；供应商密钥需单独撤销。",
                          );
                      }}
                    >
                      撤销
                    </Button>
                  </>
                )}
                <Button
                  kind="quiet danger-text"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "删除连接？历史会话和计费记录将保留，密钥会从 FAFA 移除。",
                      )
                    )
                      action(
                        () => api("/v2/connections/" + c.id, "DELETE"),
                        "连接已删除。",
                      );
                  }}
                >
                  <Trash2 size={16} />
                  删除
                </Button>
              </div>
            </article>
          ))
        )}
      </section>
      <section className="section">
        <h2>本月用量</h2>
        <div className="metrics">
          <div>
            <small>已知费用（USD）</small>
            <strong>
              {usage
                ? "$" + (usage.personal_api.cost_cents_known / 100).toFixed(2)
                : "—"}
            </strong>
          </div>
          <div>
            <small>未知或进行中预留（USD）</small>
            <strong>
              {usage
                ? "$" +
                  (usage.personal_api.cost_cents_reserved / 100).toFixed(2)
                : "—"}
            </strong>
          </div>
          <div>
            <small>请求次数</small>
            <strong>{usage?.personal_api.requests ?? "—"}</strong>
          </div>
        </div>
        <p className="fine">
          费用来自管理员核验的模型价格与供应商返回的
          token，不是供应商账单。未知用量不会显示为零费用。
        </p>
      </section>
      <section className="section">
        <h2>平台账户</h2>
        <p>{user.email}</p>
        <p className="fine">
          设备端 Codex / Claude Code 授权尚未实现。不要上传登录密码、会话 Cookie
          或 CLI 授权文件。
        </p>
        <div className="row-actions">
          <Button
            onClick={() =>
              action(async () => {
                await api("/auth/sessions/revoke-all", "POST");
                onLogout();
              }, "会话已撤销")
            }
          >
            撤销所有登录会话
          </Button>
          <Button
            onClick={() =>
              action(async () => {
                await api("/auth/logout", "POST");
                onLogout();
              }, "已退出")
            }
          >
            <LogOut size={16} />
            退出登录
          </Button>
        </div>
      </section>
      {(adding || edit) && (
        <Modal
          title={edit ? "连接设置" : "添加个人 API 连接"}
          onClose={() => {
            setAdding(false);
            setEdit(null);
          }}
        >
          <form onSubmit={save}>
            <label>
              账户备注
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={edit?.name}
              />
            </label>
            {!edit && (
              <>
                <label>
                  供应商
                  <select name="provider">
                    {Object.entries(providers).map(([id, name]) => (
                      <option value={id} key={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  官方 API Key
                  <input
                    name="api_key"
                    type="password"
                    autoComplete="off"
                    required
                    minLength={8}
                    maxLength={4096}
                  />
                </label>
              </>
            )}
            <label>
              月度成本上限（USD）
              <input
                name="budget"
                type="number"
                min={0}
                max={100000}
                step="0.01"
                required
                defaultValue={edit ? edit.budget_cents / 100 : 10}
              />
            </label>
            <p className="fine">
              更换密钥需要新建连接，避免修改正在执行任务的账户。撤销 FAFA
              连接不会自动撤销供应商的 API Key。
            </p>
            {error && <Notice danger>{error}</Notice>}
            <Button kind="primary full" type="submit" disabled={busy}>
              {busy ? "保存中…" : "保存连接"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Chat() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [prices, setPrices] = useState<Price[]>([]),
    [sessions, setSessions] = useState<Session[]>([]),
    [connection, setConnection] = useState(""),
    [model, setModel] = useState("");
  const [current, setCurrent] = useState<Conversation | null>(null),
    [prompt, setPrompt] = useState(""),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [sidebar, setSidebar] = useState(false),
    [runId, setRunId] = useState(""),
    [sticky, setSticky] = useState(true),
    [hasMore, setHasMore] = useState(false),
    [sessionPage, setSessionPage] = useState(1),
    [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null),
    scroll = useRef<HTMLDivElement>(null);
  const active = connections.find((c) => String(c.id) === connection);
  const catalog = prices.filter(
    (p) => p.provider === active?.provider && active?.models.includes(p.id),
  );
  const refreshSessions = useCallback(async (search: string, page = 1) => {
    const r = await api<{ sessions: Session[]; has_more: boolean }>(
      `/v2/sessions?q=${encodeURIComponent(search)}&page=${page}`,
    );
    setSessions((prev) => (page === 1 ? r.sessions : [...prev, ...r.sessions]));
    setHasMore(r.has_more);
    setSessionPage(page);
  }, []);
  useEffect(() => {
    Promise.all([
      api<{ connections: Connection[] }>("/v2/connections"),
      api<{ models: Price[] }>("/v2/models"),
    ])
      .then(([c, m]) => {
        setConnections(c.connections);
        setPrices(m.models);
        const first =
          c.connections.find((c) => c.is_default) ?? c.connections[0];
        if (first) setConnection(String(first.id));
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshSessions(query).catch((e) => setError(errorText(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, refreshSessions]);
  useEffect(() => {
    if (sticky && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [draft, current?.messages.length, sticky]);
  useEffect(() => {
    if (
      !current ||
      busy ||
      !current.runs.some((r) =>
        ["running", "pending", "cancel_requested"].includes(r.status),
      )
    )
      return;
    const timer = setInterval(() => {
      api<Conversation>("/v2/sessions/" + current.id)
        .then(setCurrent)
        .catch((e) => setError(errorText(e)));
    }, 2000);
    return () => clearInterval(timer);
  }, [current, busy]);
  async function open(sid: string) {
    if (busy) return;
    setLoading(true);
    setError("");
    try {
      setCurrent(await api<Conversation>("/v2/sessions/" + sid));
      setSidebar(false);
      setSticky(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || !active || !model || !prompt.trim()) return;
    const previous = current?.runs[0],
      confirmHandoff =
        !!previous &&
        (previous.connection_id !== active.id || previous.model_id !== model);
    if (
      confirmHandoff &&
      !window.confirm(
        "切换连接或模型会把此会话上下文发送至新选择的官方连接。确认继续？",
      )
    )
      return;
    setBusy(true);
    setError("");
    setDraft("");
    setSticky(true);
    const content = prompt;
    const snapshot = {
      connection_id: active.id,
      model_id: model,
      content,
      confirm_handoff: confirmHandoff,
    };
    let sid = current?.id;
    controller.current = new AbortController();
    try {
      if (!sid) {
        const s = await api<Session>("/v2/sessions", "POST", {});
        sid = s.id;
        setCurrent({ ...s, messages: [], runs: [], has_older: false });
      }
      const fixedSid = sid;
      await chatStream(
        "/sessions/" + sid + "/messages",
        snapshot,
        controller.current.signal,
        (event) => {
          if (event.name === "start") {
            setRunId(event.data.run_id ?? "");
            setPrompt("");
            setCurrent(
              (prev) =>
                prev && {
                  ...prev,
                  messages: [
                    ...prev.messages,
                    { id: -1, role: "user", content },
                  ],
                },
            );
          }
          if (event.name === "delta")
            setDraft((prev) => prev + (event.data.text ?? ""));
          if (event.name === "error")
            setError(
              "供应商连接失败。用量可能未知，预算预留将保留，请查看历史后决定是否重试。",
            );
        },
      );
      setCurrent(await api<Conversation>("/v2/sessions/" + fixedSid));
    } catch (e) {
      setError(errorText(e));
      if (sid) {
        try {
          setCurrent(await api<Conversation>("/v2/sessions/" + sid));
        } catch {
          /* retain visible history on offline recovery */
        }
      }
    } finally {
      setBusy(false);
      setDraft("");
      setRunId("");
      controller.current = null;
      refreshSessions(query).catch((e) => setError(errorText(e)));
    }
  }
  async function stop() {
    try {
      if (runId) await api("/v2/runs/" + runId + "/stop", "POST");
      else controller.current?.abort();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="chat-layout">
      <aside className={"conversations " + (sidebar ? "mobile-open" : "")}>
        <div className="section-heading">
          <h2>会话</h2>
          <Button
            disabled={busy}
            onClick={() => {
              setCurrent(null);
              setDraft("");
              setSidebar(false);
            }}
          >
            <Plus size={16} />
            新建
          </Button>
        </div>
        <label className="search-box">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </label>
        <div className="conversation-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              disabled={busy}
              className={current?.id === s.id ? "active" : ""}
              onClick={() => open(s.id)}
            >
              <MessageSquare size={16} />
              <span>{s.title}</span>
            </button>
          ))}
          {!sessions.length && <p className="fine">暂无会话</p>}
          {hasMore && (
            <Button
              onClick={() =>
                refreshSessions(query, sessionPage + 1).catch((e) =>
                  setError(errorText(e)),
                )
              }
            >
              加载更多会话
            </Button>
          )}
        </div>
      </aside>
      <section className="conversation">
        <div className="chat-toolbar">
          <Button kind="mobile-only" onClick={() => setSidebar(!sidebar)}>
            历史会话
          </Button>
          <div className="connection-select">
            <label>
              供应商 / 账户
              <select
                aria-label="选择 AI 连接"
                value={connection}
                onChange={(e) => {
                  setConnection(e.target.value);
                  setModel("");
                }}
              >
                {connections
                  .filter((c) => !c.revoked_at)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {providers[c.provider]} · {c.name}
                    </option>
                  ))}
                {!connections.length && <option value="">尚无连接</option>}
              </select>
            </label>
            <label>
              模型
              <select
                aria-label="选择模型"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="">选择模型</option>
                {catalog.map((p) => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={
                      p.input_cents_per_million === null ||
                      p.output_cents_per_million === null
                    }
                  >
                    {p.id}
                    {p.input_cents_per_million === null ||
                    p.output_cents_per_million === null
                      ? "（待核验价格）"
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="chat-title">
          <span>{current?.title ?? "新对话"}</span>
          {current && (
            <div className="row-actions">
              <Button
                disabled={busy}
                onClick={async () => {
                  const title = window.prompt("会话名称", current.title);
                  if (title?.trim())
                    try {
                      await api("/v2/sessions/" + current.id, "PATCH", {
                        title,
                      });
                      await open(current.id);
                      await refreshSessions(query);
                    } catch (e) {
                      setError(errorText(e));
                    }
                }}
              >
                重命名
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm("归档此会话？")) return;
                  try {
                    await api("/v2/sessions/" + current.id, "DELETE");
                    setCurrent(null);
                    await refreshSessions(query);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                归档
              </Button>
            </div>
          )}
        </div>
        {error && <Notice danger>{error}</Notice>}
        {loading && <Notice>正在同步会话…</Notice>}
        <div
          className="message-log"
          ref={scroll}
          aria-label="聊天记录"
          onScroll={() => {
            const el = scroll.current;
            if (el)
              setSticky(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
          }}
        >
          {current?.has_older && (
            <Button
              onClick={async () => {
                try {
                  const older = await api<Conversation>(
                    `/v2/sessions/${current.id}?before=${current.messages[0].id}`,
                  );
                  setSticky(false);
                  setCurrent({
                    ...current,
                    messages: [...older.messages, ...current.messages],
                    has_older: older.has_older,
                  });
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              加载更早消息
            </Button>
          )}
          {!current?.messages.length && !busy && (
            <div className="chat-welcome">
              <span className="ai-symbol">
                <MessageSquare size={30} />
              </span>
              <h1>今天，一起解决什么？</h1>
              <p>你的想法，你的模型，你的工作空间。</p>
              <p className="fine">
                先在「我的」添加并检测官方 API
                连接。模型需配置已核验价格后才可发送。
              </p>
              <a href="#account" className="text-link">
                管理我的 AI 账户 <ChevronRight size={15} />
              </a>
            </div>
          )}
          {current?.messages.map((m) => (
            <article key={m.id} className={"message " + m.role}>
              <div className="message-author">
                {m.role === "user" ? "你" : "AI"}
              </div>
              <div className="markdown">
                <Suspense fallback={<p>{m.content}</p>}>
                  <RichMessage text={m.content} />
                </Suspense>
              </div>
            </article>
          ))}
          {busy && (
            <article className="message assistant">
              <div className="message-author">
                AI <span className="stream-indicator" />
              </div>
              <div className="markdown" aria-live="polite">
                <Suspense fallback={<p>{draft || "正在连接供应商…"}</p>}>
                  <RichMessage text={draft || "正在连接供应商…"} />
                </Suspense>
              </div>
            </article>
          )}
          {!busy && current?.runs[0] && (
            <div className="run-status">
              {statusName[current.runs[0].status] ?? current.runs[0].status} ·
              使用连接 #{current.runs[0].connection_id} ·{" "}
              {current.runs[0].model_id}
              {current.runs[0].cost_cents === null
                ? " · 费用尚未知"
                : ` · $${(current.runs[0].cost_cents / 100).toFixed(2)}`}
              {["pending", "running", "cancel_requested"].includes(
                current.runs[0].status,
              ) && (
                <Button
                  onClick={async () => {
                    try {
                      await api(
                        "/v2/runs/" + current.runs[0].id + "/stop",
                        "POST",
                      );
                      await open(current.id);
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  请求停止
                </Button>
              )}
              <Button
                onClick={async () => {
                  try {
                    await api(
                      "/v2/sessions/" + current.id + "/recover",
                      "POST",
                    );
                    await open(current.id);
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                恢复中断状态
              </Button>
            </div>
          )}
        </div>
        {!sticky && (
          <button
            className="scroll-down"
            aria-label="滚动到底部"
            onClick={() => setSticky(true)}
          >
            <ArrowDown size={18} />
          </button>
        )}
        <form className="composer" onSubmit={send}>
          <label className="sr-only" htmlFor="message-input">
            消息
          </label>
          <textarea
            id="message-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="输入消息…"
            rows={2}
            maxLength={16000}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !matchMedia("(pointer: coarse)").matches
              ) {
                e.preventDefault();
                if (!busy) e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-footer">
            <small>官方 API · 独立计费 · 附件尚未启用</small>
            {busy ? (
              <Button onClick={stop}>
                <CircleStop size={16} />
                停止
              </Button>
            ) : (
              <Button
                kind="primary"
                type="submit"
                disabled={
                  !prompt.trim() ||
                  !connection ||
                  !model ||
                  active?.status !== "ready"
                }
              >
                <ArrowUp size={17} />
                发送
              </Button>
            )}
          </div>
        </form>
        <p className="chat-disclaimer">
          AI 可能出错，请核验重要信息。对话按实际选定的连接执行。
        </p>
      </section>
    </div>
  );
}
function Nodes({ user }: { user: User }) {
  const [nodes, setNodes] = useState<
      {
        id: number;
        name: string;
        group: string;
        health: string;
        checked_at: number | null;
        region: string;
      }[]
    >([]),
    [error, setError] = useState("");
  const allowed = user.role === "super_admin" || user.modules.includes("nodes");
  useEffect(() => {
    if (allowed)
      api<{ nodes: typeof nodes }>("/nodes")
        .then((r) => setNodes(r.nodes))
        .catch((e) => setError(errorText(e)));
  }, [allowed]);
  return (
    <div className="page">
      <div className="eyebrow">NETWORK</div>
      <h1>我的节点</h1>
      <p className="lead">查看已授权服务及其真实检测记录。</p>
      {error && <Notice danger>{error}</Notice>}
      {!allowed ? (
        <Notice>
          当前账户尚无节点授权。生产订阅数据尚未迁移，此处不会生成替代订阅。
        </Notice>
      ) : (
        <section className="section">
          {nodes.length ? (
            nodes.map((n) => (
              <article key={n.id} className="node-row">
                <Network size={20} />
                <div>
                  <h3>{n.name}</h3>
                  <p>
                    {n.region} · {n.group}
                  </p>
                </div>
                <span className="pill">
                  {n.health === "unknown" ? "尚未检测" : n.health}
                </span>
                <small>
                  {n.checked_at
                    ? new Date(n.checked_at * 1000).toLocaleString()
                    : "无检测时间"}
                </small>
              </article>
            ))
          ) : (
            <div className="empty">暂无已授权节点记录</div>
          )}
        </section>
      )}
      <Notice>
        旧系统订阅
        Token、客户端格式和服务授权尚未完成对账。订阅导入、轮换与撤销暂未启用；不显示未经计量的流量。
      </Notice>
    </div>
  );
}
