import { useState } from "react";
import { Card, PageTitle, useApp, useData } from "../../../../packages/ui/src/core";
interface SessionRow { id: string; created_at: string; last_seen_at: string | null; revoked_at: string | null; user_agent: string | null; ip: string | null; }
export function Settings() {
  const { request } = useApp();
  const [theme, setTheme] = useState(() => localStorage.getItem("fafa_theme") || "light");
  const [locale, setLocale] = useState(() => localStorage.getItem("fafa.locale") || "zh-CN");
  const [prefs, setPrefs] = useState(() => {
    const raw = localStorage.getItem("fafa.notification.prefs");
    if (raw) { try { return JSON.parse(raw); } catch { return { subscription: true, session: true, quota: true }; } }
    return { subscription: true, session: true, quota: true };
  });
  const sessions = useData<SessionRow[]>("/api/sessions");
  function applyTheme(t: string) { document.documentElement.dataset.theme = t === "dark" ? "dark" : "light"; localStorage.setItem("fafa_theme", t); setTheme(t); }
  function applyLocale(v: string) { localStorage.setItem("fafa.locale", v); setLocale(v); }
  function togglePref(k: string) { const next = { ...prefs, [k]: prefs[k] === true ? false : true }; localStorage.setItem("fafa.notification.prefs", JSON.stringify(next)); setPrefs(next); }
  async function revoke(id: string) { await request("/api/sessions/" + id, "DELETE"); sessions.refresh(); }
  async function logout() { await request("/api/logout", "POST"); window.location.reload(); }
  return (
    <div>
      <PageTitle title="设置" description="外观、语言偏好、通知偏好与登录会话管理。" />
      <Card title="外观主题"><div className="cluster"><button className="btn" type="button" aria-pressed={theme === "light"} onClick={() => applyTheme("light")}>浅色</button><button className="btn" type="button" aria-pressed={theme === "dark"} onClick={() => applyTheme("dark")}>深色</button></div><p className="muted">主题立即生效并保存在本机浏览器。</p></Card>
      <Card title="语言偏好"><select value={locale} onChange={(e) => applyLocale(e.target.value)}><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option></select><p className="muted">语言偏好已保存到本机；界面语言切换尚未接通，当前界面仍为简体中文。</p></Card>
      <Card title="通知偏好"><div className="cluster"><label><input type="checkbox" checked={prefs.subscription === true} onChange={() => togglePref("subscription")} /> 订阅变更</label><label><input type="checkbox" checked={prefs.session === true} onChange={() => togglePref("session")} /> 会话安全</label><label><input type="checkbox" checked={prefs.quota === true} onChange={() => togglePref("quota")} /> 额度提醒</label></div><p className="muted">偏好保存在本机；服务端推送尚未接通，站内通知以通知中心列表为准。</p></Card>
      <Card title="登录会话">{sessions.error ? <div className="callout danger">加载失败：{sessions.error}</div> : null}{sessions.data === undefined && sessions.error === null ? <div className="muted">加载中…</div> : null}{(sessions.data || []).length === 0 && sessions.data !== undefined ? <p className="muted">暂无其他登录会话。</p> : null}{(sessions.data || []).map((s) => (<div key={s.id} className="cluster"><span>{s.user_agent || "未知设备"}</span><span className="muted">{new Date(s.created_at).toLocaleString()}</span>{s.revoked_at === null ? <button className="btn danger" type="button" onClick={() => revoke(s.id)}>撤销</button> : <span className="muted">已撤销</span>}</div>))}</Card>
      <Card title="退出登录"><button className="btn danger" type="button" onClick={logout}>退出当前会话</button></Card>
    </div>
  );
}

