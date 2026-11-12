import { useMemo, useState } from "react";
import { Badge, Card, PageTitle, useData } from "../../../../packages/ui/src/core";
import type { NotificationItem } from "../../../../packages/shared/src/notifications";
const KINDS = ["全部", "subscription", "session", "source", "quota", "ai", "account", "system"];
const KIND_LABELS: Record<string, string> = { subscription: "订阅", session: "会话", source: "节点", quota: "额度", ai: "AI", account: "账户", system: "系统" };
export function Notifications() {
  const { data, error, refresh } = useData<NotificationItem[]>("/api/notifications");
  const [kind, setKind] = useState("全部");
  const [readAt, setReadAt] = useState(() => localStorage.getItem("fafa.notifications.readAt") || "");
  const list = useMemo(() => (data || []).filter((n) => kind === "全部" || n.kind === kind), [data, kind]);
  const unread = (data || []).filter((n) => readAt === "" || n.createdAt > readAt).length;
  function markAllRead() { const now = new Date().toISOString(); localStorage.setItem("fafa.notifications.readAt", now); setReadAt(now); }
  return (
    <div>
      <PageTitle title="通知中心" description="来自你本人账户的真实事件：订阅、会话、节点与额度变更。" />
      <div className="cluster" style={{ marginBottom: 12 }}><span className="muted">未读：{unread} 条</span><button className="btn" type="button" onClick={markAllRead}>全部标记为已读</button><button className="btn" type="button" onClick={refresh}>刷新</button></div>
      <Card title="筛选">
        <div className="cluster">{KINDS.map((k) => (<button key={k} className="btn" type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{k === "全部" ? "全部" : KIND_LABELS[k]}</button>))}</div>
      </Card>
      {error ? (<div className="callout danger" role="alert">加载失败：{error}<button className="btn" type="button" onClick={refresh}>重试</button></div>) : null}
      {data === undefined && error === null ? <div className="muted">加载中…</div> : null}
      {data !== undefined && list.length === 0 ? (<Card title="暂无通知"><p className="muted">当前没有符合条件的通知。通知只来自你本人账户的真实事件，不会展示演示数据。</p></Card>) : null}
      {list.map((n) => (<Card key={n.id} title={n.title}><div className="cluster"><Badge tone="neutral">{KIND_LABELS[n.kind]}</Badge><span className="muted">{new Date(n.createdAt).toLocaleString()}</span></div><p className="muted">{n.detail || n.action}</p></Card>))}
    </div>
  );
}

